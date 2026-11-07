import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@t3tools/contracts";

export interface ConfirmDialogChoice {
  readonly id: string;
  readonly label: string;
  readonly variant?: "default" | "destructive" | "outline";
}

type ConfirmDialogContent = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  readonly choices?: ReadonlyArray<ConfirmDialogChoice>;
};

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | ({ readonly status: "confirming" } & ConfirmDialogContent)
  | ({ readonly status: "closing" } & ConfirmDialogContent);

type PendingConfirmation = ConfirmDialogContent & {
  readonly resolve: (choice: string | null) => void;
};

const CONFIRM_CHOICE = "confirm";

const contentOf = ({ message, variant, choices }: ConfirmDialogContent): ConfirmDialogContent =>
  choices === undefined ? { message, variant } : { message, variant, choices };

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function resolvePendingConfirmations(): void {
  activeConfirmation?.resolve(null);
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve(null);
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

/**
 * Only themed hosts subscribe, so a subscriber is a mounted host. When the last
 * one leaves, pending confirmations resolve as cancelled.
 */
export function subscribeConfirmDialogHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    resolvePendingConfirmations();
    publish(idleState);
  };
}

function enqueue(content: ConfirmDialogContent): Promise<string | null> {
  return new Promise((resolve) => {
    const pending: PendingConfirmation = { ...content, resolve };
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish({ status: "confirming", ...contentOf(pending) });
  });
}

/** Undefined means no themed host is available. */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
): Promise<boolean> | undefined {
  if (listeners.size === 0) return undefined;
  return enqueue({ message, variant: options?.variant ?? "default" }).then(
    (choice) => choice === CONFIRM_CHOICE,
  );
}

export function requestChoiceDialog(
  message: string,
  choices: ReadonlyArray<ConfirmDialogChoice>,
): Promise<string | null> | undefined {
  if (listeners.size === 0) return undefined;
  return enqueue({ message, variant: "default", choices });
}

export function isConfirmDialogActive(): boolean {
  return state.status !== "idle" || activeConfirmation !== null || queuedConfirmations.length > 0;
}

export function respondToConfirmDialog(response: boolean | string): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(response === true ? CONFIRM_CHOICE : response === false ? null : response);
  publish({ status: "closing", ...contentOf(state) });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  publish({ status: "confirming", ...contentOf(next) });
}

export function resetConfirmDialogForTests(): void {
  listeners.clear();
  resolvePendingConfirmations();
  publish(idleState);
}
