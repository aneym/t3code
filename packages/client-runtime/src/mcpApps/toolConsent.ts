import { McpAppHostRefusal } from "./host.ts";

const DECLINE_COOLDOWN_MS = 60_000;

export type McpAppToolConsentChoice = "allow" | "always" | "deny-card" | "cancel";

export interface McpAppToolConsentRequest {
  readonly name: string;
  readonly title: string;
  readonly arguments: unknown;
}

export type McpAppToolConsentNotice =
  | { readonly kind: "cooldown"; readonly tool: string; readonly blocked: number }
  | { readonly kind: "denied"; readonly tool: string; readonly blocked: number };

export interface McpAppToolConsentOptions {
  readonly now: () => number;
  readonly isGranted: (tool: string) => boolean;
  readonly canRemember: () => boolean;
  readonly ask: (
    request: McpAppToolConsentRequest,
    canRemember: boolean,
  ) => Promise<McpAppToolConsentChoice>;
  readonly remember: (tool: string) => void;
  readonly onNotice: (notice: McpAppToolConsentNotice | null) => void;
}

export interface McpAppToolConsent {
  readonly approve: (request: McpAppToolConsentRequest) => Promise<void>;
  readonly confirm: (label: string, ask: () => Promise<boolean>) => Promise<void>;
  readonly reset: () => void;
}

const declined = () => new McpAppHostRefusal("Declined by the user.");

export function makeMcpAppToolConsent(options: McpAppToolConsentOptions): McpAppToolConsent {
  const deniedTools = new Set<string>();
  let pending = false;
  let cooldownUntil = Number.NEGATIVE_INFINITY;
  let notice: McpAppToolConsentNotice | null = null;

  const show = (next: McpAppToolConsentNotice | null) => {
    notice = next;
    options.onNotice(next);
  };
  const block = (kind: McpAppToolConsentNotice["kind"], tool: string) => {
    const blocked =
      notice !== null && notice.kind === kind && notice.tool === tool ? notice.blocked : 0;
    show({ kind, tool, blocked: blocked + 1 });
    return declined();
  };
  const cancelled = (label: string) => {
    cooldownUntil = options.now() + DECLINE_COOLDOWN_MS;
    show({ kind: "cooldown", tool: label, blocked: 0 });
    return false;
  };

  const gate = async (label: string, decide: () => Promise<boolean>) => {
    if (options.now() < cooldownUntil) throw block("cooldown", notice?.tool ?? label);
    if (pending) {
      throw new McpAppHostRefusal("Another request from this app is waiting for approval.");
    }
    pending = true;
    show(null);
    try {
      if (!(await decide())) throw declined();
    } finally {
      pending = false;
    }
  };

  return {
    approve: async (request) => {
      if (deniedTools.has(request.name)) throw block("denied", request.name);
      if (options.canRemember() && options.isGranted(request.name)) return;
      await gate(request.name, async () => {
        const canRemember = options.canRemember();
        const choice = await options.ask(request, canRemember);
        if (choice === "allow") return true;
        if (choice === "always" && canRemember) {
          options.remember(request.name);
          return true;
        }
        if (choice !== "deny-card") return cancelled(request.name);
        deniedTools.add(request.name);
        show({ kind: "denied", tool: request.name, blocked: 0 });
        return false;
      });
    },
    confirm: (label, ask) => gate(label, async () => (await ask()) || cancelled(label)),
    reset: () => {
      deniedTools.clear();
      cooldownUntil = Number.NEGATIVE_INFINITY;
      show(null);
    },
  };
}
