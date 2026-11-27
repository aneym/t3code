import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { decideFallback, type FallbackInput, type FallbackStep } from "./ModelFallbackChain.ts";
import { carriedRunFields } from "./RunCarryOver.ts";
import { fallbackMessageId, keepsThreadModelSelection } from "./runLocalModelSelection.ts";

const step = (label: string, instanceId: string, model: string, personChatOnly?: true) => ({
  label,
  ...(personChatOnly ? { personChatOnly } : {}),
  modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model },
});

const neon = step("Neon high", "gemini", "gemini-4-neon");
const opus = step("Opus 5.5 high", "claudeAgent", "claude-opus-5-5", true);
const sol = step("Sol high", "codex", "gpt-6.2-sol");
const liveChain: ReadonlyArray<FallbackStep> = [neon, opus, sol];
const sel = (s: FallbackStep) => s.modelSelection;

const input = (overrides: Partial<FallbackInput>): FallbackInput => ({
  chain: liveChain,
  run: sel(sol),
  stored: sel(sol),
  personChat: false,
  allowed: () => true,
  pool: () => undefined,
  ...overrides,
});

const target = (decision: ReturnType<typeof decideFallback>) =>
  decision.type === "fallback" ? decision.to.label : decision.type;

describe("decideFallback", () => {
  it.each([
    ["Sol lane falls to Neon", input({}), "Neon high"],
    [
      "sol-latest alias matches Sol",
      input({
        run: { ...sel(sol), model: "sol-latest" },
        stored: { ...sel(sol), model: "sol-latest" },
      }),
      "Neon high",
    ],
    ["Neon after Sol falls to Opus", input({ run: sel(neon) }), "Opus 5.5 high"],
    [
      "Opus after Sol and Neon has nothing left",
      input({ run: sel(opus), pool: (s) => ({ exhausted: s !== opus }) }),
      "exhausted",
    ],
    [
      "exhausted Neon pool skips to Opus",
      input({ pool: (s) => (s === neon ? { exhausted: true } : undefined) }),
      "Opus 5.5 high",
    ],
    ["disallowed Neon skips to Opus", input({ allowed: (s) => s !== neon }), "Opus 5.5 high"],
    [
      "model outside the chain is left alone",
      input({ run: { ...sel(sol), instanceId: ProviderInstanceId.make("opencode") } }),
      "none",
    ],
    ["person chat on Sol keeps the old linear end", input({ personChat: true }), "none"],
    [
      "person chat on Neon still falls to Opus",
      input({ personChat: true, run: sel(neon), stored: sel(neon) }),
      "Opus 5.5 high",
    ],
  ])("%s", (_name, given, expected) => {
    expect(target(decideFallback(given))).toBe(expected);
  });

  it("names every provider and its reset when no model is free", () => {
    const resets: Record<string, string> = {
      "Sol high": "2026-12-02T06:37:00.000Z",
      "Neon high": "2026-11-26T18:00:00.000Z",
    };
    const decision = decideFallback(
      input({ pool: (s) => ({ exhausted: true, resetsAt: resets[s.label] }) }),
    );
    expect(decision).toEqual({
      type: "exhausted",
      from: sol,
      providers: [
        { label: "Sol high", resetsAt: resets["Sol high"] },
        { label: "Neon high", resetsAt: resets["Neon high"] },
        { label: "Opus 5.5 high", resetsAt: undefined },
      ],
    });
  });
});

describe("fallback keeps the stored model", () => {
  const fallback = {
    fromProvider: ProviderInstanceId.make("codex"),
    fromModel: "gpt-6.2-sol",
    toProvider: ProviderInstanceId.make("gemini"),
    toModel: "gemini-4-neon",
    reasonKind: "no_accounts" as const,
    reason: "Sol high was out of quota",
    resetsAt: "2026-12-02T06:37:00.000Z",
    at: "2026-11-26T17:00:00.000Z",
  };

  it("marks the resend as run-local and carries its fallback record", () => {
    const messageId = fallbackMessageId(RunId.make("run-1"));
    expect(keepsThreadModelSelection(messageId)).toBe(true);
    expect(carriedRunFields({ messageId, fallback }).fallback).toEqual(fallback);
  });

  it("drops a fallback record on an ordinary message, which may change the model", () => {
    expect(keepsThreadModelSelection("message-1")).toBe(false);
    expect(carriedRunFields({ messageId: "message-1", fallback }).fallback).toBeUndefined();
  });
});
