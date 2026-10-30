// @effect-diagnostics nodeBuiltinImport:off -- Accepted handles belong to the standalone supervisor.
// @effect-diagnostics globalTimers:off -- Queue and transfer deadlines follow the measured hold budget.
import type * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type { LauncherIngressConfig } from "./serviceLauncherConfig.ts";

export class ServiceLauncherIngress {
  #server: NodeNet.Server | undefined;
  #destination: NodeChildProcess.ChildProcess | undefined;
  readonly #queue = new Map<NodeNet.Socket, NodeJS.Timeout>();
  readonly #pending = new Map<
    number,
    { child: NodeChildProcess.ChildProcess; socket: NodeNet.Socket; timer: NodeJS.Timeout }
  >();
  #address: string | undefined;
  #sequence = 0;
  #backpressure = false;
  readonly #budget: number;
  readonly #capacity: number;
  readonly #window: number;

  constructor(config?: LauncherIngressConfig) {
    this.#budget = config?.holdBudgetMs ?? 1;
    this.#capacity = config?.maxQueued ?? 1;
    this.#window = config?.maxTransfers ?? 1;
  }

  async bind(host: string, port: number): Promise<void> {
    const address = `${host}:${port}`;
    if (this.#server !== undefined) {
      if (this.#address !== address) throw new Error("Public ingress cannot change during a swap.");
      return;
    }
    const server = NodeNet.createServer({ pauseOnConnect: true }, (socket) => {
      socket.on("error", () => socket.destroy());
      if (this.#queue.size + this.#pending.size >= this.#capacity) {
        socket.destroy();
        return;
      }
      const timer = setTimeout(() => {
        this.#queue.delete(socket);
        socket.destroy();
      }, this.#budget);
      this.#queue.set(socket, timer);
      socket.once("close", () => {
        clearTimeout(timer);
        this.#queue.delete(socket);
      });
      this.#flush();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#server = server;
    this.#address = address;
  }

  route(child?: NodeChildProcess.ChildProcess): void {
    this.#destination = child;
    this.#backpressure = false;
    if (child !== undefined)
      child.once("exit", () => {
        if (this.#destination === child) this.#destination = undefined;
        for (const [id, transfer] of this.#pending)
          if (transfer.child === child) {
            clearTimeout(transfer.timer);
            transfer.socket.destroy();
            this.#pending.delete(id);
          }
      });
    this.#flush();
  }

  ack(child: NodeChildProcess.ChildProcess, transferId: number): void {
    const transfer = this.#pending.get(transferId);
    if (transfer?.child !== child) return;
    clearTimeout(transfer.timer);
    this.#pending.delete(transferId);
    transfer.socket.destroy();
    this.#flush();
  }

  #flush(): void {
    const child = this.#destination;
    if (!child?.connected || this.#backpressure) return;
    for (const [socket, timer] of this.#queue) {
      if (this.#pending.size >= this.#window || this.#backpressure) break;
      clearTimeout(timer);
      this.#queue.delete(socket);
      if (socket.destroyed) continue;
      const transferId = ++this.#sequence;
      const timeout = setTimeout(() => {
        this.#pending.delete(transferId);
        socket.destroy();
        this.#flush();
      }, this.#budget);
      this.#pending.set(transferId, { child, socket, timer: timeout });
      try {
        const writable = child.send(
          { type: "socket", transferId },
          socket,
          { keepOpen: true },
          (error) => {
            this.#backpressure = false;
            if (error !== null) {
              clearTimeout(timeout);
              this.#pending.delete(transferId);
              socket.destroy();
            }
            this.#flush();
          },
        );
        if (!writable) this.#backpressure = true;
      } catch {
        clearTimeout(timeout);
        this.#pending.delete(transferId);
        socket.destroy();
      }
    }
  }

  async close(): Promise<void> {
    this.route();
    for (const [socket, timer] of this.#queue) {
      clearTimeout(timer);
      socket.destroy();
    }
    for (const transfer of this.#pending.values()) {
      clearTimeout(transfer.timer);
      transfer.socket.destroy();
    }
    this.#pending.clear();
    this.#queue.clear();
    const server = this.#server;
    this.#server = undefined;
    this.#address = undefined;
    server?.close();
  }
}

export function probeServiceChild(
  port: number,
  instanceId: string,
  updateId?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get(
      { host: "127.0.0.1", port, path: "/__t3_service_health", agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const identity: unknown = JSON.parse(body);
            if (
              response.statusCode !== 200 ||
              typeof identity !== "object" ||
              identity === null ||
              !("instanceId" in identity) ||
              identity.instanceId !== instanceId ||
              (updateId !== undefined &&
                (!("updateId" in identity) || identity.updateId !== updateId))
            ) {
              reject(new Error("Trial identity probe did not match this update."));
            } else resolve();
          } catch {
            reject(new Error("Trial identity probe returned an invalid response."));
          }
        });
      },
    );
    request.setTimeout(5000, () => request.destroy(new Error("Trial identity probe timed out.")));
    request.on("error", reject);
  });
}
