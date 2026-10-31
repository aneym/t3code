// @effect-diagnostics nodeBuiltinImport:off -- The tunnel outlives individual server children.
// @effect-diagnostics globalTimers:off -- Connector crash recovery uses bounded backoff.
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import type { ServiceConnectorConfig } from "./cloud/serviceProtocol.ts";
import { ChildTerminator } from "./serviceChildTerminator.ts";

export class ServiceConnectorProcess {
  #child: NodeChildProcess.ChildProcess | undefined;
  #config: ServiceConnectorConfig | null = null;
  #retry: NodeJS.Timeout | undefined;
  #delay = 1000;
  #metrics: string | undefined;
  #protocol: string | null = null;
  readonly #terminator = new ChildTerminator();

  async apply(config: ServiceConnectorConfig | null): Promise<number | null> {
    if (
      config !== null &&
      JSON.stringify(config) === JSON.stringify(this.#config) &&
      this.#child?.exitCode === null &&
      this.#child.signalCode === null
    )
      return this.#child.pid ?? null;
    clearTimeout(this.#retry);
    const previous = this.#child;
    this.#child = undefined;
    this.#config = config;
    if (previous !== undefined) await this.#terminator.terminate(previous);
    if (config === null) return null;
    return this.#spawn(config);
  }

  async inspect() {
    const child = this.#child;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null)
      return { pid: null, facts: null };
    const ready: unknown =
      this.#metrics === undefined ? null : await readMetrics(`http://${this.#metrics}/ready`);
    const config: unknown =
      this.#metrics === undefined ? null : await readMetrics(`http://${this.#metrics}/config`);
    const ingress =
      typeof config === "object" &&
      config !== null &&
      "config" in config &&
      typeof config.config === "object" &&
      config.config !== null &&
      "ingress" in config.config
        ? config.config.ingress
        : undefined;
    const hostname = Array.isArray(ingress)
      ? ingress.find(
          (rule: unknown) =>
            typeof rule === "object" &&
            rule !== null &&
            "hostname" in rule &&
            typeof rule.hostname === "string",
        )?.hostname
      : null;
    return {
      pid: child.pid ?? null,
      facts: {
        readyConnections:
          typeof ready === "object" &&
          ready !== null &&
          "readyConnections" in ready &&
          typeof ready.readyConnections === "number"
            ? ready.readyConnections
            : null,
        hostname: typeof hostname === "string" ? hostname : null,
        protocol: this.#protocol,
      },
    };
  }

  async #spawn(config: ServiceConnectorConfig): Promise<number | null> {
    const child = NodeChildProcess.spawn(
      config.executable,
      [
        "tunnel",
        "--no-autoupdate",
        "--loglevel",
        "info",
        "--output",
        "default",
        "--metrics",
        "127.0.0.1:0",
        "run",
      ],
      {
        env: { ...process.env, TUNNEL_TOKEN: config.token },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.#child = child;
    this.#metrics = undefined;
    this.#protocol = null;
    const observe = (chunk: Buffer) => {
      const line = chunk.toString();
      const address = /Starting metrics server on (127\.0\.0\.1:\d+)\/metrics/u.exec(line)?.[1];
      if (address !== undefined) this.#metrics = address;
      const protocol = /\bprotocol=(\w+)/u.exec(line)?.[1];
      if (protocol !== undefined) this.#protocol = protocol;
      if (line.includes("Registered tunnel connection")) this.#delay = 1000;
    };
    child.stdout?.on("data", observe);
    child.stderr?.on("data", observe);
    const retry = () => {
      if (this.#child !== child || this.#config !== config) return;
      this.#child = undefined;
      this.#retry = setTimeout(() => {
        void this.#spawn(config);
      }, this.#delay);
      this.#delay = Math.min(this.#delay * 2, 60_000);
    };
    child.once("exit", retry);
    return new Promise((resolve) => {
      child.once("error", () => {
        retry();
        resolve(null);
      });
      child.once("spawn", () => resolve(child.pid ?? null));
    });
  }
}

function readMetrics(url: string): Promise<unknown> {
  return new Promise((resolve) => {
    const request = NodeHttp.get(url, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        if (body.length < 65_536) body += chunk.toString();
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
      response.on("error", () => resolve(null));
    });
    request.setTimeout(2000, () => request.destroy());
    request.on("error", () => resolve(null));
  });
}
