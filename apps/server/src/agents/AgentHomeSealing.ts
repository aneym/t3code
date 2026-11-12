export type AgentHomeSealing = "sealed" | "open" | "invalid";

export const agentHomeSealing = (doc: Readonly<Record<string, unknown>>): AgentHomeSealing =>
  doc.sealed === true
    ? "sealed"
    : doc.sealed === undefined || doc.sealed === false
      ? "open"
      : "invalid";
