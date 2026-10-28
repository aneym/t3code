import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CircleCheckIcon, CircleDashedIcon, EyeOffIcon, PinIcon } from "lucide-react";
import { useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { useEnvironmentIdentities } from "../../state/environments";
import { cn } from "~/lib/utils";
import { deriveProjectIdentity } from "../../projectIdentity";
import { ProjectMonogram } from "../ProjectMonogram";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { SidebarSection } from "../sidebar/SidebarSection";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DEFAULT_PINNED_AGENT_HANDLES,
  type RailsAgent,
  railsAgentFaceUrl,
  railsAgentThreadKey,
  useRailsAgents,
} from "./railsAgents";

const PINNED_AGENTS_KEY = "t3code:sidebar-agents:pinned";
const PinnedAgentHandles = Schema.Array(Schema.String);

export function SidebarAgents({ onNavigate }: { readonly onNavigate: () => void }) {
  const agents = useRailsAgents();
  const [pinnedHandles, setPinnedHandles] = useLocalStorage(
    PINNED_AGENTS_KEY,
    DEFAULT_PINNED_AGENT_HANDLES,
    PinnedAgentHandles,
  );
  const routeTarget = useThreadRouteTarget();
  const environmentLabelById = new Map(
    useEnvironmentIdentities().map((environment) => [environment.environmentId, environment.label]),
  );
  const activeThreadKey =
    routeTarget?.kind === "server"
      ? `${routeTarget.threadRef.environmentId}:${routeTarget.threadRef.threadId}`
      : null;
  if (agents.length === 0) return null;

  const agentByHandle = new Map(agents.map((agent) => [agent.handle, agent] as const));
  const pinned = pinnedHandles.flatMap((handle) => agentByHandle.get(handle) ?? []);
  const hidden = agents
    .filter((agent) => !pinnedHandles.includes(agent.handle))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const rowProps = (agent: RailsAgent) => ({
    agent,
    active: agent.thread !== null && railsAgentThreadKey(agent.thread) === activeThreadKey,
    machines: [agent.projectRef.environmentId, ...agent.environmentIds]
      .flatMap((id) => environmentLabelById.get(id) ?? [])
      .filter((label, index, all) => all.indexOf(label) === index)
      .join(" · "),
    onNavigate,
  });

  return (
    <div className="mt-2">
      <SidebarSection label="Agents" storageKey="t3code:sidebar-section:agents:expanded">
        <ul aria-label="Agents" className="flex flex-col">
          {pinned.map((agent) => (
            <AgentRow
              key={agent.handle}
              {...rowProps(agent)}
              toggle={{
                label: `Hide ${agent.name}`,
                icon: EyeOffIcon,
                onClick: () =>
                  setPinnedHandles((handles) => handles.filter((h) => h !== agent.handle)),
              }}
            />
          ))}
        </ul>
        {hidden.length > 0 ? (
          <SidebarSection
            label="Hidden"
            storageKey="t3code:sidebar-section:agents-hidden:expanded"
            defaultExpanded={false}
            count={hidden.length}
          >
            <ul aria-label="Hidden agents" className="flex flex-col">
              {hidden.map((agent) => (
                <AgentRow
                  key={agent.handle}
                  {...rowProps(agent)}
                  muted
                  toggle={{
                    label: `Pin ${agent.name}`,
                    icon: PinIcon,
                    onClick: () => setPinnedHandles((handles) => [...handles, agent.handle]),
                  }}
                />
              ))}
            </ul>
          </SidebarSection>
        ) : null}
      </SidebarSection>
    </div>
  );
}

function AgentRow(props: {
  readonly agent: RailsAgent;
  readonly active: boolean;
  readonly muted?: boolean;
  readonly machines: string;
  readonly onNavigate: () => void;
  readonly toggle: {
    readonly label: string;
    readonly icon: typeof PinIcon;
    readonly onClick: () => void;
  };
}) {
  const { agent } = props;
  const handleNewThread = useNewThreadHandler();
  const rowClassName = cn(
    "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset",
    props.active
      ? "bg-sidebar-row-active text-sidebar-foreground"
      : cn(
          "group-hover/agent-row:bg-sidebar-row-hover",
          props.muted ? "text-sidebar-muted-foreground" : "text-sidebar-foreground",
        ),
  );
  const content = (
    <>
      <AgentFace handle={agent.handle} name={agent.name} />
      <span className="min-w-0 flex-1 truncate">{agent.name}</span>
      {agent.thread === null ? null : (
        <span className="flex shrink-0 group-focus-within/agent-row:invisible group-hover/agent-row:invisible">
          <AgentStatus thread={agent.thread} />
        </span>
      )}
      {props.machines === "" ? null : (
        <span className="mr-6 hidden shrink-0 text-xs text-sidebar-muted-foreground group-focus-within/agent-row:inline group-hover/agent-row:inline">
          {props.machines}
        </span>
      )}
    </>
  );
  const ToggleIcon = props.toggle.icon;
  return (
    <li className="group/agent-row relative flex items-center">
      {agent.thread === null ? (
        <button
          type="button"
          className={rowClassName}
          onClick={() => {
            props.onNavigate();
            void handleNewThread(agent.projectRef);
          }}
        >
          {content}
        </button>
      ) : (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: agent.thread.environmentId, threadId: agent.thread.id }}
          aria-current={props.active ? "page" : undefined}
          className={rowClassName}
          onClick={props.onNavigate}
        >
          {content}
        </Link>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={props.toggle.label}
              onClick={props.toggle.onClick}
              className="absolute right-1 inline-flex size-6 items-center justify-center rounded-md text-sidebar-muted-foreground opacity-0 hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover/agent-row:opacity-100"
            >
              <ToggleIcon aria-hidden className="size-3.5" />
            </button>
          }
        />
        <TooltipPopup side="top">{props.toggle.label}</TooltipPopup>
      </Tooltip>
    </li>
  );
}

function AgentFace(props: { readonly handle: string; readonly name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    const identity = deriveProjectIdentity(props.name);
    return (
      <ProjectMonogram
        text={Array.from(identity.monogram)[0] ?? ""}
        color={identity.color}
        className="size-5 [&>svg]:rounded-full"
      />
    );
  }
  return (
    <img
      src={railsAgentFaceUrl(props.handle)}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(true)}
      className="size-5 shrink-0 rounded-full"
    />
  );
}

function AgentStatus({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const status = resolveSidebarThreadStatus(thread);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, undefined);
  if (status === "working") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-sidebar-muted-foreground">
        <CircleDashedIcon aria-hidden className="size-3.5" />
        Working
      </span>
    );
  }
  if (status === "approval" || status === "input" || status === "request") {
    return <span className="shrink-0 text-xs font-medium text-sidebar-foreground">Needs you</span>;
  }
  if (status === "waiting") {
    return <span className="shrink-0 text-xs text-sidebar-muted-foreground">Waiting</span>;
  }
  if (hasUnseenCompletion({ ...thread, lastVisitedAt })) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-sidebar-muted-foreground">
        <CircleCheckIcon aria-hidden className="size-3.5" />
        Done
      </span>
    );
  }
  return null;
}
