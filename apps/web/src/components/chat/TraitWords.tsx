import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { Fragment, memo } from "react";

const ULTRACODE = "ultracode";

const RAINBOW = [
  "text-red-600 dark:text-red-400",
  "text-orange-700 dark:text-orange-400",
  "text-yellow-700 dark:text-yellow-400",
  "text-green-700 dark:text-green-400",
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

const RainbowWord = memo(function RainbowWord(props: { label: string }) {
  return Array.from(props.label, (letter, index) => (
    <span key={index} className={RAINBOW[index % RAINBOW.length]}>
      {letter}
    </span>
  ));
});

function Word(props: { label: string; rainbowLabel: string | undefined }) {
  return props.label === props.rainbowLabel ? <RainbowWord label={props.label} /> : props.label;
}

export function EffortWord(props: {
  label: string;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  rainbow: boolean | undefined;
}) {
  const rainbowLabel = props.rainbow ? activeUltracodeLabel(props.descriptors) : undefined;
  return (
    <span data-composer-control-label>
      <Word label={props.label} rainbowLabel={rainbowLabel} />
    </span>
  );
}

export function SecondaryTraitWords(props: {
  labels: ReadonlyArray<string>;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  rainbow: boolean | undefined;
}) {
  const rainbowLabel = props.rainbow ? activeUltracodeLabel(props.descriptors) : undefined;
  return (
    <span
      aria-hidden="true"
      data-composer-control-label
      data-composer-secondary-trait
      className="max-w-28 truncate"
    >
      {props.labels.map((label, index) => (
        <Fragment key={label}>
          {index > 0 ? " · " : null}
          <Word label={label} rainbowLabel={rainbowLabel} />
        </Fragment>
      ))}
    </span>
  );
}
