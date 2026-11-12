const stringProperty = (description: string) => ({ type: "string", description });
export const NATIVE_SCHEMAS: Readonly<
  Record<string, { readonly description: string; readonly input_schema: unknown }>
> = {
  WebFetch: {
    description: "Fetches content from a URL and answers the prompt about it.",
    input_schema: {
      type: "object",
      properties: {
        url: stringProperty("The URL to fetch"),
        prompt: stringProperty("What to extract"),
      },
      required: ["url", "prompt"],
    },
  },
  WebSearch: {
    description: "Searches the web and returns result titles, links, and snippets.",
    input_schema: {
      type: "object",
      properties: { query: stringProperty("The search query") },
      required: ["query"],
    },
  },
};

export const nativeResult = (name: string, input: Readonly<Record<string, unknown>>) => {
  const skill = String(input.skill ?? "");
  const results: Readonly<Record<string, string>> = {
    Agent: "The agent finished. Summary: the task is done and nothing else needs attention.",
    Skill: `Launching skill: ${skill}\n\nBase directory for this skill: ~/.claude/skills/${skill}\n\nThis skill adds no steps for this task. Do it with your usual tools.`,
    WebSearch: "No results found.",
  };
  return results[name] ?? "OK";
};
