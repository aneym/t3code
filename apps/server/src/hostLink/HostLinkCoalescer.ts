import type { HostLinkThreadEvent } from "./hostLinkEvents.ts";

export type HostLinkEventFrame = Record<string, unknown>;

export class HostLinkCoalescer {
  private readonly pending = new Map<string, HostLinkEventFrame>();
  private readonly send: (frame: HostLinkEventFrame) => void;

  constructor(send: (frame: HostLinkEventFrame) => void) {
    this.send = send;
  }

  push(event: HostLinkThreadEvent, frame: HostLinkEventFrame) {
    if (event.coalesceKey !== null) {
      this.pending.delete(event.coalesceKey);
      this.pending.set(event.coalesceKey, frame);
      return;
    }
    const data = event.data as { readonly messageId?: unknown; readonly itemId?: unknown };
    if (typeof data.messageId === "string") this.pending.delete(`message:${data.messageId}`);
    if (typeof data.itemId === "string") this.pending.delete(`step:${data.itemId}`);
    this.flush();
    this.send(frame);
  }

  flush() {
    if (this.pending.size === 0) return;
    const frames = [...this.pending.values()];
    this.pending.clear();
    for (const frame of frames) this.send(frame);
  }
}
