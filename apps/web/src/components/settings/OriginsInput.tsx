import { useState } from "react";

import { Input } from "../ui/input";

function parseOrigins(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function OriginsInput({
  saved,
  label,
  placeholder,
  onCommit,
}: {
  readonly saved: ReadonlyArray<string>;
  readonly label: string;
  readonly placeholder: string;
  readonly onCommit: (origins: string[]) => void;
}) {
  const savedText = saved.join(" ");
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== savedText) onCommit(parseOrigins(draft));
  };
  return (
    <Input
      size="sm"
      className="w-72"
      aria-label={label}
      placeholder={placeholder}
      value={draft ?? savedText}
      onValueChange={setDraft}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}
