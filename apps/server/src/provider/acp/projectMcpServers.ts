import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

const T3_SERVER_NAME = "t3-code";
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

type JsonObject = Readonly<Record<string, unknown>>;

const isJsonObject = (value: unknown): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const readJsonObject = (fileSystem: FileSystem.FileSystem, file: string) =>
  fileSystem.readFileString(file).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((value) => (isJsonObject(value) ? value : undefined)),
    Effect.orElseSucceed(() => undefined),
  );

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter(Predicate.isString) : [];

function expand(text: string, env: NodeJS.ProcessEnv): string | undefined {
  let missing = false;
  const result = text.replace(VARIABLE, (_, name: string, fallback: string | undefined) => {
    const value = env[name];
    if (value !== undefined) return value;
    if (fallback !== undefined) return fallback;
    missing = true;
    return "";
  });
  return missing ? undefined : result;
}

function expandPairs(value: unknown, env: NodeJS.ProcessEnv) {
  if (value === undefined) return [];
  if (!isJsonObject(value)) return undefined;
  const pairs: Array<{ name: string; value: string }> = [];
  for (const [name, raw] of Object.entries(value)) {
    if (!Predicate.isString(raw)) return undefined;
    const expanded = expand(raw, env);
    if (expanded === undefined) return undefined;
    pairs.push({ name, value: expanded });
  }
  return pairs;
}

function toAcpServer(
  name: string,
  entry: JsonObject,
  env: NodeJS.ProcessEnv,
): EffectAcpSchema.McpServer | undefined {
  const type = entry.type ?? "stdio";
  if (type === "http" || type === "sse") {
    const url = Predicate.isString(entry.url) ? expand(entry.url, env) : undefined;
    const headers = expandPairs(entry.headers, env);
    if (url === undefined || headers === undefined) return undefined;
    return { type, name, url, headers };
  }
  if (type !== "stdio" || !Predicate.isString(entry.command)) return undefined;
  const command = expand(entry.command, env);
  const args = strings(entry.args).map((arg) => expand(arg, env));
  const vars = expandPairs(entry.env, env);
  if (command === undefined || vars === undefined || args.some((arg) => arg === undefined))
    return undefined;
  return { name, command, args: args.filter(Predicate.isString), env: vars };
}

export const readProjectMcpServers = Effect.fn("readProjectMcpServers")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const { fileSystem, path, cwd, env } = input;
  const project = yield* readJsonObject(fileSystem, path.join(cwd, ".mcp.json"));
  const declared = project?.mcpServers;
  if (!isJsonObject(declared)) return [];
  const settings = (yield* Effect.all([
    readJsonObject(fileSystem, path.join(cwd, ".claude", "settings.json")),
    readJsonObject(fileSystem, path.join(cwd, ".claude", "settings.local.json")),
  ])).filter(isJsonObject);
  const disabled = new Set(settings.flatMap((file) => strings(file.disabledMcpjsonServers)));
  const enabled = new Set(settings.flatMap((file) => strings(file.enabledMcpjsonServers)));
  const enableAll = settings.some((file) => file.enableAllProjectMcpServers === true);
  return Object.entries(declared).flatMap(([name, entry]) => {
    if (name === T3_SERVER_NAME || disabled.has(name) || !(enableAll || enabled.has(name)))
      return [];
    const server = isJsonObject(entry) ? toAcpServer(name, entry, env) : undefined;
    return server === undefined ? [] : [server];
  });
});
