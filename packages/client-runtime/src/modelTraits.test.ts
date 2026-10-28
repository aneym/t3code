import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTraitsTriggerDisplay } from "./modelTraits.ts";

const EFFORT: ProviderOptionDescriptor = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  currentValue: "max",
};

function display(ultracode: boolean) {
  return buildTraitsTriggerDisplay({
    provider: ProviderDriverKind.make("claudeAgent"),
    descriptors: [
      EFFORT,
      { id: "ultracode", label: "Ultracode", type: "boolean", currentValue: ultracode },
    ],
    primarySelectDescriptorId: "effort",
    ultrathinkPromptControlled: false,
  });
}

describe("buildTraitsTriggerDisplay", () => {
  it("names Ultracode only while it is on", () => {
    expect(display(false)).toEqual({ label: "Max" });
    expect(display(true)).toEqual({ label: "Max · Ultracode" });
  });
});
