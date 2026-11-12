import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";

export type PlainSend = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "message.dispatch" }
>;

export const isPlainSend = (command: OrchestrationV2ServerCommand): command is PlainSend =>
  command.type === "message.dispatch" &&
  command.delegatedCompletion === undefined &&
  command.notification === undefined &&
  command.sourcePlanRef === undefined;
