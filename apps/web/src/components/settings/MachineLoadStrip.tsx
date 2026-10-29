import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { useContext, useEffect } from "react";
import { Atom } from "effect/reactivity";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { cn } from "../../lib/utils";
import { useOptionalSettingsScope } from "./SettingsScopeContext";

const visibleClock = Atom.make((get) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    if (document.visibilityState === "visible") timer = setTimeout(() => get.refreshSelf(), 5_000);
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") get.refreshSelf();
    else clearTimeout(timer);
  };
  document.addEventListener("visibilitychange", onVisibility);
  get.addFinalizer(() => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  });
  schedule();
  return Date.now();
});

function LoadBar({
  label,
  value,
  warning,
}: {
  label: string;
  value: number | null;
  warning: number;
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-6 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {value === null ? String.fromCharCode(8212) : `${Math.round(value)}%`}
        </span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value ?? undefined}
        aria-valuetext={value === null ? "Unavailable" : undefined}
      >
        <div
          className={cn("h-full", value !== null && value >= warning ? "bg-warning" : "bg-primary")}
          style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }}
        />
      </div>
    </div>
  );
}

function MachineLoad({ environment, now }: { environment: EnvironmentPresentation; now: number }) {
  const registry = useContext(RegistryContext);
  const query = serverEnvironment.hostResources({
    environmentId: environment.environmentId,
    input: {},
  });
  const result = useAtomValue(query);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the host on the shared visible clock
  useEffect(() => {
    const current = registry.get(query);
    if (current.waiting) return;
    if (current._tag !== "Success" || now - current.timestamp >= 4_000) registry.refresh(query);
  }, [now, registry, query]);
  const resources =
    result._tag === "Success" && now - result.timestamp <= 15_000 ? result.value : null;
  return (
    <>
      <LoadBar
        label="CPU"
        value={resources?.cpuUtilization == null ? null : resources.cpuUtilization * 100}
        warning={70}
      />
      <LoadBar
        label="Memory"
        value={
          resources && resources.totalMemoryBytes > 0
            ? (1 - resources.availableMemoryBytes / resources.totalMemoryBytes) * 100
            : null
        }
        warning={85}
      />
    </>
  );
}

function MachineCard({ environment, now }: { environment: EnvironmentPresentation; now: number }) {
  const scope = useOptionalSettingsScope();
  const online = environment.connection.phase === "connected";
  const selected = scope?.environment?.environmentId === environment.environmentId;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`Diagnostics for ${environment.label}`}
      onClick={() => scope?.selectScope({ machine: environment.environmentId })}
      className={cn(
        "w-48 shrink-0 space-y-3 rounded-lg border p-3 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "border-primary bg-accent" : "border-border bg-card hover:bg-accent",
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <span
          aria-label={online ? "Online" : "Offline"}
          className={cn(
            "size-2 shrink-0 rounded-full",
            online ? "bg-success" : "bg-muted-foreground",
          )}
        />
        <span className="truncate">{environment.label}</span>
        {!online && <span className="text-xs text-muted-foreground">offline</span>}
      </div>
      {online ? (
        <MachineLoad environment={environment} now={now} />
      ) : (
        <>
          <LoadBar label="CPU" value={null} warning={70} />
          <LoadBar label="Memory" value={null} warning={85} />
        </>
      )}
    </button>
  );
}

function MachineLoadStrip() {
  const { environments } = useEnvironments();
  const now = useAtomValue(visibleClock);
  return (
    <div aria-label="Machine resources" className="flex gap-3 overflow-x-auto pb-1">
      {environments.map((environment) => (
        <MachineCard key={environment.environmentId} environment={environment} now={now} />
      ))}
    </div>
  );
}

export function DiagnosticsMachineStrip() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return pathname === "/settings/diagnostics" ? <MachineLoadStrip /> : null;
}
