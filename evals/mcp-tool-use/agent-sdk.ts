// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  query,
  type HookCallback,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

type Block = { readonly type: string; readonly [key: string]: unknown };
type Message = { readonly role: "user" | "assistant"; readonly content: ReadonlyArray<Block> };
type Tool = {
  readonly name: string;
  readonly description?: unknown;
  readonly input_schema?: unknown;
};
type Use = {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
};
type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};
type Rpc = {
  readonly id?: unknown;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
};

const T3_SERVER = "t3-code";
const T3_PREFIX = `mcp__${T3_SERVER}__`;
const RUN_FOR_REAL = new Set(["ToolSearch", "TodoWrite"]);
const EXIT_LINE = /^Exit code (\d+)\n?/;

type AgentSdkRun = {
  readonly bin: string;
  readonly model: string;
  readonly effort: string;
  readonly maxTurns: number;
  readonly systemPrompt: NonNullable<Options["systemPrompt"]>;
  readonly messages: ReadonlyArray<Message>;
  readonly t3Tools: ReadonlyArray<Tool>;
  readonly nativeName: (name: string) => string;
  readonly answer: (use: Use) => Promise<Block>;
  readonly onAssistant: (step: number, content: ReadonlyArray<Block>) => boolean;
  readonly afterResults: (content: ReadonlyArray<Block>) => boolean;
};

const blockText = (content: unknown) =>
  typeof content === "string" ? content : (JSON.stringify(content) ?? "");

const resultText = (content: unknown) =>
  Array.isArray(content)
    ? content
        .map((part: Block) => (typeof part.text === "string" ? part.text : blockText(part)))
        .join("\n")
    : blockText(content);

const emptyUsage = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

const addUsage = (total: Usage, usage: Partial<Usage> | undefined) => {
  total.input_tokens += usage?.input_tokens ?? 0;
  total.output_tokens += usage?.output_tokens ?? 0;
  total.cache_creation_input_tokens += usage?.cache_creation_input_tokens ?? 0;
  total.cache_read_input_tokens += usage?.cache_read_input_tokens ?? 0;
};

const readBody = async (request: NodeHttp.IncomingMessage) => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Rpc | Array<Rpc>;
};

const serveT3 = async (
  tools: ReadonlyArray<Tool>,
  call: (name: string, input: unknown) => Promise<Block>,
) => {
  const listed = tools.map((tool) => ({
    name: tool.name.slice(T3_PREFIX.length),
    description: blockText(tool.description ?? ""),
    inputSchema: tool.input_schema,
  }));
  const rpc = async ({ id, method, params }: Rpc) => {
    const result =
      method === "initialize"
        ? {
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: T3_SERVER, version: "eval" },
          }
        : method === "tools/list"
          ? { tools: listed }
          : method === "tools/call"
            ? await call(`${T3_PREFIX}${String(params?.name)}`, params?.arguments ?? {}).then(
                (block) => ({
                  content: [{ type: "text", text: blockText(block.content) }],
                  isError: block.is_error === true,
                }),
              )
            : method === "ping"
              ? {}
              : undefined;
    return result === undefined
      ? { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } }
      : { jsonrpc: "2.0", id, result };
  };
  const server = NodeHttp.createServer((request, response) => {
    const send = (status: number, body?: unknown) => {
      response.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (request.method !== "POST") return send(request.method === "DELETE" ? 200 : 405);
    readBody(request)
      .then(async (body) => {
        const batch = Array.isArray(body) ? body : [body];
        const replies = await Promise.all(batch.filter((m) => m.id !== undefined).map(rpc));
        if (replies.length === 0) return send(202);
        send(200, Array.isArray(body) ? replies : replies[0]);
      })
      .catch((error: unknown) => send(500, { error: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  return {
    config: { type: "http" as const, url: `http://127.0.0.1:${port}/mcp` },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const projectDir = (cwd: string) =>
  NodePath.join(configDir(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));

const configDir = () => process.env.CLAUDE_CONFIG_DIR ?? NodePath.join(NodeOS.homedir(), ".claude");

const writeSession = (cwd: string, model: string, history: ReadonlyArray<Message>) => {
  const sessionId = NodeCrypto.randomUUID();
  const dir = projectDir(cwd);
  NodeFS.mkdirSync(dir, { recursive: true });
  let parentUuid: string | null = null;
  const lines = history.map((message, index) => {
    const uuid = NodeCrypto.randomUUID();
    const entry = {
      parentUuid,
      isSidechain: false,
      userType: "external",
      cwd,
      sessionId,
      type: message.role,
      uuid,
      timestamp: `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      message:
        message.role === "user"
          ? { role: "user", content: message.content }
          : {
              id: `msg_prior_${index}`,
              type: "message",
              role: "assistant",
              model,
              content: message.content,
              stop_reason: message.content.some((block) => block.type === "tool_use")
                ? "tool_use"
                : "end_turn",
              stop_sequence: null,
              usage: emptyUsage(),
            },
    };
    parentUuid = uuid;
    return JSON.stringify(entry);
  });
  const file = NodePath.join(dir, `${sessionId}.jsonl`);
  NodeFS.writeFileSync(file, `${lines.join("\n")}\n`);
  return { sessionId };
};

const renamed = (message: Message, nativeName: (name: string) => string): Message => ({
  ...message,
  content: message.content.map((block) =>
    block.type === "tool_use" && typeof block.name === "string" && !block.name.startsWith(T3_PREFIX)
      ? { ...block, name: nativeName(block.name) }
      : block,
  ),
});

const promptText = (message: Message) =>
  message.content.map((block) => (typeof block.text === "string" ? block.text : "")).join("\n\n");

export const runAgentSdk = async (run: AgentSdkRun) => {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync("/tmp/mcp-eval-"));
  const cwd = NodePath.join(root, "app");
  NodeFS.mkdirSync(cwd);
  const history = run.messages.slice(0, -1).map((message) => renamed(message, run.nativeName));
  const resumable = history.some((message) => message.role === "assistant");
  const prompt = (resumable ? run.messages.slice(-1) : run.messages).map(promptText).join("\n\n");
  const session = resumable ? writeSession(cwd, run.model, history) : undefined;
  const pending = new Map<string, Array<Use>>();
  let unnamed = 0;
  const t3 = await serveT3(run.t3Tools, (name, input) => {
    const use = pending.get(name)?.shift() ?? {
      type: "tool_use",
      id: `toolu_mcp_${unnamed++}`,
      name,
      input,
    };
    return run.answer({ ...use, input });
  });
  let outputs = 0;
  const preToolUse: HookCallback = async (input, toolUseId) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const use: Use = {
      type: "tool_use",
      id: toolUseId ?? input.tool_use_id,
      name: input.tool_name,
      input: input.tool_input,
    };
    if (use.name.startsWith(T3_PREFIX)) {
      pending.set(use.name, [...(pending.get(use.name) ?? []), use]);
      return {};
    }
    if (RUN_FOR_REAL.has(use.name)) return {};
    const result = await run.answer(use);
    const output = blockText(result.content);
    const tool_input = (input.tool_input ?? {}) as Record<string, unknown>;
    const file = NodePath.join(root, `output-${outputs++}.txt`);
    if (use.name === "Bash") {
      const exit = EXIT_LINE.exec(output);
      NodeFS.writeFileSync(file, exit ? output.slice(exit[0].length) : output);
      const command = `cat '${file}'${exit ? `; exit ${exit[1]}` : ""}`;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { ...tool_input, command },
        },
      };
    }
    if (use.name === "Read" && result.is_error !== true) {
      NodeFS.writeFileSync(file, output.replace(/^ *\d+[\t→]/gm, ""));
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { ...tool_input, file_path: file, offset: undefined, limit: undefined },
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: output,
      },
    };
  };
  const abortController = new AbortController();
  const transcript: Array<Message> = [];
  const usage = emptyUsage();
  const steps = new Map<string, number>();
  let stopReason = "unknown";
  let finalText = "";
  let lastTexts: Array<string> = [];
  const options: Options = {
    model: run.model,
    ...(run.effort ? { effort: run.effort as NonNullable<Options["effort"]> } : {}),
    maxTurns: run.maxTurns,
    cwd,
    ...(session ? { resume: session.sessionId } : {}),
    systemPrompt: run.systemPrompt,
    pathToClaudeCodeExecutable: run.bin,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { [T3_SERVER]: t3.config },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    abortController,
    env: { ...process.env, ENABLE_TOOL_SEARCH: "true" },
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    stderr: () => undefined,
  };
  const handle = (message: SDKMessage) => {
    if (message.type === "assistant") {
      const {
        id,
        content,
        usage: used,
      } = message.message as unknown as {
        id: string;
        content: ReadonlyArray<Block>;
        usage?: Partial<Usage>;
      };
      const known = steps.get(id);
      const step = known ?? steps.size;
      if (known === undefined) {
        steps.set(id, step);
        addUsage(usage, used);
        lastTexts = [];
      }
      transcript.push({ role: "assistant", content });
      lastTexts.push(
        ...content.flatMap((block) =>
          typeof block.text === "string" && block.type === "text" ? [block.text] : [],
        ),
      );
      return run.onAssistant(step, content);
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      const content = message.message.content as unknown as ReadonlyArray<Block>;
      transcript.push({ role: "user", content });
      return run.afterResults(
        content
          .filter((block) => block.type === "tool_result")
          .map((block) => ({ ...block, content: resultText(block.content) })),
      );
    }
    if (message.type === "result") {
      stopReason =
        message.subtype === "success"
          ? "end_turn"
          : message.subtype === "error_max_turns"
            ? "max_steps"
            : message.subtype;
      finalText = message.subtype === "success" ? lastTexts.join("\n\n") : "";
    }
    return false;
  };
  try {
    for await (const message of query({ prompt, options })) {
      if (handle(message)) {
        stopReason = "failed_early";
        abortController.abort();
        break;
      }
    }
  } catch (error) {
    if (stopReason === "unknown") throw error;
  } finally {
    await t3.close();
    NodeFS.rmSync(projectDir(cwd), { recursive: true, force: true });
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
  return { transcript, usage, stopReason, finalText };
};

export const claudePrint = (
  bin: string,
  body: {
    readonly model: string;
    readonly system: string;
    readonly messages: ReadonlyArray<{ readonly content: ReadonlyArray<Block> }>;
    readonly output_config: { readonly format: { readonly schema: unknown } };
  },
) =>
  new Promise<{ content: ReadonlyArray<Block>; stop_reason: string; usage: Usage }>(
    (resolve, reject) => {
      const cwd = NodeFS.realpathSync(NodeOS.tmpdir());
      const child = NodeChildProcess.spawn(
        bin,
        [
          "-p",
          "--model",
          body.model,
          "--effort",
          "low",
          "--system-prompt",
          body.system,
          "--json-schema",
          JSON.stringify(body.output_config.format.schema),
          "--tools",
          "",
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--no-session-persistence",
          "--disable-slash-commands",
          "--output-format",
          "json",
        ],
        { cwd, stdio: ["pipe", "pipe", "ignore"] },
      );
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        try {
          const reply = JSON.parse(stdout) as {
            is_error?: boolean;
            result?: string;
            structured_output?: unknown;
            usage?: Partial<Usage>;
          };
          if (code !== 0 || reply.is_error)
            throw new Error(`claude -p exited ${code}: ${reply.result ?? ""}`);
          const usage = emptyUsage();
          addUsage(usage, reply.usage);
          const text =
            reply.structured_output === undefined
              ? (reply.result ?? "")
              : JSON.stringify(reply.structured_output);
          resolve({ content: [{ type: "text", text }], stop_reason: "end_turn", usage });
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(
        body.messages
          .flatMap((message) => message.content.map((block) => blockText(block.text)))
          .join("\n\n"),
      );
    },
  );
