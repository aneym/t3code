import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { Fragment } from "react";

const ULTRACODE = "ultracode";

const RAINBOW = [
  "text-red-600 dark:text-red-400",
  "text-orange-600 dark:text-orange-400",
  "text-yellow-600 dark:text-yellow-400",
  "text-green-600 dark:text-green-400",
  "text-blue-600 dark:text-blue-400",
  "text-indigo-600 dark:text-indigo-400",
  "text-violet-600 dark:text-violet-400",
];

function activeUltracodeLabel(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  for (const descriptor of descriptors) {
    if (descriptor.type === "boolean") {
      if (descriptor.id === ULTRACODE && descriptor.currentValue === true) return descriptor.label;
    } else if (descriptor.currentValue === ULTRACODE) {
      return descriptor.options.find((option) => option.id === ULTRACODE)?.label;
    }
  }
  return undefined;
}

export function TraitWords(props: {
  labels: ReadonlyArray<string>;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  rainbow: boolean;
}) {
  const ultracode = props.rainbow ? activeUltracodeLabel(props.descriptors) : undefined;
  return props.labels.map((label, index) => (
    <Fragment key={label}>
      {index > 0 ? " · " : null}
      {label === ultracode
        ? Array.from(label, (letter, letterIndex) => (
            <span key={letterIndex} className={RAINBOW[letterIndex % RAINBOW.length]}>
              {letter}
            </span>
          ))
        : label}
    </Fragment>
  ));
}
