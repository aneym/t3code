// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

const FIND_TOOL = "find_tools";
const CALL_TOOL = "call_tool";
const OWN_ID_PREFIX = "t3-lazy-";

interface Envelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: {
    readonly name?: unknown;
    readonly arguments?: unknown;
    readonly cursor?: unknown;
  };
  readonly result?: unknown;
  readonly error?: unknown;
}

interface InnerTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parse = (line: string): Envelope | null => {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? (value as Envelope) : null;
  } catch {
    return null;
  }
};

const proxyTools = (server: string) => [
  {
    name: FIND_TOOL,
    description: `Find ${server} tools. With \`query\`, lists the tools whose name or description has every word; with no query, lists them all. With \`names\`, returns those tools' full descriptions and input schemas. Run one with ${CALL_TOOL}.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to match, such as `lane list`." },
        names: { type: "array", items: { type: "string" }, description: "Exact tool names." },
      },
    },
  },
  {
    name: CALL_TOOL,
    description: `Run one ${server} tool by its exact name with the arguments its schema from ${FIND_TOOL} asks for.`,
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Exact tool name." },
        arguments: { type: "object", description: "The tool's arguments." },
      },
      required: ["tool"],
    },
  },
];

const summary = (tool: InnerTool) => {
  const first = (tool.description ?? "").split(/(?<=\.)\s|\n/, 1)[0]?.trim() ?? "";
  return first.length === 0 ? tool.name : `${tool.name}: ${first.slice(0, 160)}`;
};

const findResult = (tools: ReadonlyArray<InnerTool>, args: Record<string, unknown>) => {
  const names = Array.isArray(args.names)
    ? args.names.filter((name): name is string => typeof name === "string")
    : [];
  if (names.length > 0) {
    const found = names.map(
      (name) => tools.find((tool) => tool.name === name) ?? { name, missing: true },
    );
    return JSON.stringify(found);
  }
  const words =
    typeof args.query === "string" ? args.query.toLowerCase().split(/\W+/).filter(Boolean) : [];
  const matches = tools.filter((tool) => {
    const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase().replaceAll("_", " ");
    return words.every((word) => text.includes(word) || tool.name.includes(word));
  });
  return matches.length === 0
    ? `No tool matches. ${tools.length} tools exist; call ${FIND_TOOL} with no query to list them.`
    : matches.map(summary).join("\n");
};

const textResult = (id: unknown, text: string, isError = false) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
});

export async function runLazyMcpProxy(args: ReadonlyArray<string>): Promise<void> {
  const [server, separator, command, ...commandArgs] = args;
  if (server === undefined || separator !== "--" || command === undefined) {
    process.stderr.write("acp-mcp-lazy requires <server> -- <command> [args...].\n");
    process.exitCode = 2;
    return;
  }
  const inner = NodeChildProcess.spawn(command, commandArgs, {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const toAgent = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const toInner = (message: unknown) => inner.stdin.write(`${JSON.stringify(message)}\n`);
  const pending = new Map<string, (envelope: Envelope) => void>();
  let ownId = 0;
  let initializeId: unknown;
  let cached: Promise<ReadonlyArray<InnerTool>> | null = null;

  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Envelope>((resolve) => {
      const id = `${OWN_ID_PREFIX}${++ownId}`;
      pending.set(id, resolve);
      toInner({ jsonrpc: "2.0", id, method, params });
    });

  const innerTools = () => {
    cached ??= (async () => {
      const tools: InnerTool[] = [];
      let cursor: unknown;
      do {
        const page = await request("tools/list", cursor === undefined ? {} : { cursor });
        const result = isObject(page.result) ? page.result : {};
        if (Array.isArray(result.tools)) tools.push(...(result.tools as InnerTool[]));
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      } while (cursor !== undefined);
      return tools;
    })();
    return cached;
  };

  const fromAgent = async (envelope: Envelope, line: string) => {
    if (envelope.method === "initialize") initializeId = envelope.id;
    if (envelope.method === "tools/list" && envelope.id !== undefined) {
      toAgent({ jsonrpc: "2.0", id: envelope.id, result: { tools: proxyTools(server) } });
      return;
    }
    if (envelope.method === "tools/call" && envelope.params?.name === FIND_TOOL) {
      const callArgs = isObject(envelope.params.arguments) ? envelope.params.arguments : {};
      toAgent(textResult(envelope.id, findResult(await innerTools(), callArgs)));
      return;
    }
    if (envelope.method === "tools/call" && envelope.params?.name === CALL_TOOL) {
      const callArgs = isObject(envelope.params.arguments) ? envelope.params.arguments : {};
      if (typeof callArgs.tool !== "string") {
        toAgent(textResult(envelope.id, `${CALL_TOOL} needs \`tool\`, an exact name.`, true));
        return;
      }
      const { name: _name, arguments: _arguments, ...rest } = envelope.params;
      toInner({
        jsonrpc: "2.0",
        id: envelope.id,
        method: envelope.method,
        params: { name: callArgs.tool, arguments: callArgs.arguments ?? {}, ...rest },
      });
      return;
    }
    inner.stdin.write(`${line}\n`);
  };

  NodeReadline.createInterface({ input: inner.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const envelope = parse(line);
    const id = typeof envelope?.id === "string" ? envelope.id : undefined;
    const waiter = id === undefined ? undefined : pending.get(id);
    if (envelope !== null && id !== undefined && waiter !== undefined) {
      pending.delete(id);
      waiter(envelope);
      return;
    }
    if (envelope?.method === "notifications/tools/list_changed") cached = null;
    if (envelope !== null && initializeId !== undefined && envelope.id === initializeId) {
      initializeId = undefined;
      if (!isObject(envelope.result)) {
        process.stdout.write(`${line}\n`);
        return;
      }
      const instructions =
        typeof envelope.result.instructions === "string"
          ? `${envelope.result.instructions}\n\n`
          : "";
      toAgent({
        ...envelope,
        result: {
          ...envelope.result,
          instructions: `${instructions}Reach this server's tools through ${FIND_TOOL} and ${CALL_TOOL}.`,
        },
      });
      return;
    }
    process.stdout.write(`${line}\n`);
  });

  NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
    if (line.trim().length === 0) return;
    const envelope = parse(line);
    if (envelope === null) {
      inner.stdin.write(`${line}\n`);
      return;
    }
    void fromAgent(envelope, line);
  });
  process.stdin.on("end", () => inner.stdin.end());

  await new Promise<void>((resolve) => {
    inner.on("exit", (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
    inner.on("error", (error) => {
      process.stderr.write(`acp-mcp-lazy could not start ${command}: ${error.message}\n`);
      process.exitCode = 1;
      resolve();
    });
  });
}
