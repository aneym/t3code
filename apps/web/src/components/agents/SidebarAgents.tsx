import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  GripVerticalIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  PinOffIcon,
  PinIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { useEnvironmentIdentities } from "../../state/environments";
import { cn } from "~/lib/utils";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";
import { SidebarSection } from "../sidebar/SidebarSection";
import { JumpHintBadge } from "../sidebar/SidebarThreadRow";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentFace } from "./AgentFace";
import type { RailsAgent } from "./railsAgents";
import { useAgentFocusAction } from "./agentFocus";
import { AGENTS_SECTION_STORAGE_KEY, sidebarAgentJumpKey } from "./sidebarAgentLists";
import { useSidebarPins } from "./sidebarPins";

export function SidebarAgents({
  onNavigate,
  pinned,
  hidden,
  jumpLabelByKey,
  setProjectScope,
}: {
  readonly onNavigate: () => void;
  readonly pinned: ReadonlyArray<RailsAgent>;
  readonly hidden: ReadonlyArray<RailsAgent>;
  readonly jumpLabelByKey: ReadonlyMap<string, string> | null;
  readonly setProjectScope: (keys: readonly string[]) => void;
}) {
  const { toggle, setOrder, showMenu } = useSidebarPins();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handles = pinned.map((agent) => agent.handle);
  const name = (id: string | number) =>
    pinned.find((agent) => agent.handle === id)?.name ?? String(id);
  const focusAction = useAgentFocusAction(setProjectScope);
  const routeTarget = useThreadRouteTarget();
  const environmentLabelById = new Map(
    useEnvironmentIdentities().map((environment) => [environment.environmentId, environment.label]),
  );
  const activeThreadKey =
    routeTarget?.kind === "server"
      ? `${routeTarget.threadRef.environmentId}:${routeTarget.threadRef.threadId}`
      : null;

  if (pinned.length === 0 && hidden.length === 0) return null;
  const rowProps = (agent: RailsAgent) => ({
    agent,
    active:
      agent.target !== null &&
      `${agent.target.environmentId}:${agent.target.threadId}` === activeThreadKey,
    machines: agent.environmentIds
      .flatMap((id) => environmentLabelById.get(id) ?? [])
      .filter((label, index, all) => all.indexOf(label) === index)
      .join(" · "),
    onNavigate,
    focus: focusAction(agent),
    onContextMenu: (position: { x: number; y: number }) => {
      void showMenu(agent.handle, agent.name, position);
    },
  });

  return (
    <div className="mt-2">
      <SidebarSection label="Agents" storageKey={AGENTS_SECTION_STORAGE_KEY}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          accessibility={{
            screenReaderInstructions: {
              draggable:
                "Press Space to pick up an agent. Use the arrow keys to move it, Space to drop, or Escape to cancel.",
            },
            announcements: {
              onDragStart: ({ active }) => `Picked up ${name(active.id)}.`,
              onDragOver: ({ active, over }) =>
                over
                  ? `${name(active.id)} is at position ${handles.indexOf(String(over.id)) + 1} of ${handles.length}, over ${name(over.id)}.`
                  : `${name(active.id)} is outside the list.`,
              onDragEnd: ({ active, over }) =>
                over
                  ? `Dropped ${name(active.id)} at position ${handles.indexOf(String(over.id)) + 1} of ${handles.length}.`
                  : `Dropped ${name(active.id)} without moving.`,
              onDragCancel: ({ active }) => `Reordering ${name(active.id)} cancelled.`,
            },
          }}
          onDragEnd={({ active, over }) => {
            if (over === null || active.id === over.id) return;
            const from = handles.indexOf(String(active.id));
            const to = handles.indexOf(String(over.id));
            if (from < 0 || to < 0) return;
            setOrder(arrayMove(handles, from, to));
          }}
        >
          <SortableContext items={handles} strategy={verticalListSortingStrategy}>
            <ul aria-label="Agents" className="flex flex-col">
              {pinned.map((agent) => (
                <AgentRow
                  key={agent.handle}
                  {...rowProps(agent)}
                  jumpLabel={jumpLabelByKey?.get(sidebarAgentJumpKey(agent)) ?? null}
                  toggle={{
                    label: `Unpin ${agent.name}`,
                    icon: PinOffIcon,
                    onClick: () => toggle(agent.handle),
                  }}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
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
                    onClick: () => toggle(agent.handle),
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
  readonly jumpLabel?: string | null;
  readonly machines: string;
  readonly onNavigate: () => void;
  readonly onContextMenu: (position: { x: number; y: number }) => void;
  readonly focus: AgentRowAction | null;
  readonly toggle: AgentRowAction;
}) {
  const { agent } = props;
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: agent.handle, disabled: props.muted === true });
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();
  const { openMenu } = useThreadActionMenu({
    threadRef:
      agent.thread === null
        ? null
        : { environmentId: agent.thread.environmentId, threadId: agent.thread.id },
    projectCwd: null,
    onStartRename: () => {
      if (agent.thread === null) return;
      props.onNavigate();
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: agent.thread.environmentId, threadId: agent.thread.id },
      });
    },
    canShareWithGuest: false,
    agentPin: { label: props.toggle.label, onToggle: props.toggle.onClick },
  });
  const showMenu = (position: { x: number; y: number }) => {
    if (agent.thread === null) props.onContextMenu(position);
    else openMenu(position);
  };
  const rowClassName = cn(
    "flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pr-1 pl-2 text-left text-sm outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset",
    props.muted && !props.active ? "text-sidebar-muted-foreground" : "text-sidebar-foreground",
  );
  const content = (
    <>
      <AgentFace agent={agent} />
      <span className="min-w-[min(8ch,100%)] flex-1 truncate">{agent.name}</span>
      <span className="flex shrink-0 text-xs text-sidebar-muted-foreground group-focus-within/agent-row:hidden group-hover/agent-row:hidden">
        {agent.thread !== null ? (
          <AgentStatus thread={agent.thread} />
        ) : agent.target ? (
          "Loading"
        ) : agent.remoteHost ? (
          `On ${agent.remoteHost}`
        ) : null}
      </span>
      {props.machines === "" ? null : (
        <span className="hidden min-w-0 shrink-[999] truncate text-xs text-sidebar-muted-foreground group-focus-within/agent-row:block group-hover/agent-row:block">
          {props.machines}
        </span>
      )}
    </>
  );
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group/agent-row relative flex h-8 items-center rounded-md",
        props.active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        isDragging && "z-10 bg-sidebar-row-active",
      )}
      onContextMenu={(event) => {
        event.preventDefault();
        showMenu({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        showMenu({ x: rect.left, y: rect.bottom });
      }}
    >
      {agent.target === null ? (
        <button
          type="button"
          className={rowClassName}
          onClick={() => {
            if (agent.remoteHost) {
              toastManager.add({
                type: "info",
                title: `${agent.name}'s main thread is on ${agent.remoteHost}`,
                description: `Connect ${agent.remoteHost} to open it here.`,
              });
              return;
            }
            props.onNavigate();
            if (agent.projectRef === null) return;
            void handleNewThread(agent.projectRef);
          }}
        >
          {content}
        </button>
      ) : (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: agent.target.environmentId, threadId: agent.target.threadId }}
          aria-current={props.active ? "page" : undefined}
          className={rowClassName}
          onClick={props.onNavigate}
        >
          {content}
        </Link>
      )}
      <span className="mr-1 flex shrink-0">
        {props.muted ? null : (
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${agent.name}`}
            className="inline-flex h-6 w-5 shrink-0 touch-none cursor-grab items-center justify-center overflow-hidden rounded-md text-sidebar-muted-foreground opacity-0 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-focus-within/agent-row:opacity-100 group-hover/agent-row:opacity-100 active:cursor-grabbing"
          >
            <GripVerticalIcon aria-hidden className="size-3.5" />
          </button>
        )}
        {props.focus ? <AgentRowButton action={props.focus} /> : null}
        <AgentRowButton action={props.toggle} />
      </span>
      {props.jumpLabel ? <JumpHintBadge label={props.jumpLabel} /> : null}
    </li>
  );
}

interface AgentRowAction {
  readonly label: string;
  readonly icon: typeof PinIcon;
  readonly active?: boolean;
  readonly onClick: () => void;
}

function AgentRowButton({ action }: { readonly action: AgentRowAction }) {
  const Icon = action.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={action.label}
            aria-pressed={action.active}
            onClick={action.onClick}
            className={cn(
              "inline-flex h-6 shrink-0 items-center justify-center overflow-hidden rounded-md hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              action.active
                ? "w-6 text-sidebar-foreground"
                : "w-0 text-sidebar-muted-foreground opacity-0 group-focus-within/agent-row:w-6 group-focus-within/agent-row:opacity-100 group-hover/agent-row:w-6 group-hover/agent-row:opacity-100",
            )}
          >
            <Icon aria-hidden className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="top">{action.label}</TooltipPopup>
    </Tooltip>
  );
}

const AGENT_STATUS: Partial<
  Record<
    SidebarThreadStatus,
    { readonly label: string; readonly icon: typeof PinIcon; readonly className: string }
  >
> = {
  working: { label: "Working", icon: CircleDashedIcon, className: "text-info-foreground" },
  waiting: {
    label: "Waiting",
    icon: CircleDotDashedIcon,
    className: "text-sidebar-muted-foreground",
  },
  approval: { label: "Approval", icon: ShieldQuestionIcon, className: "text-warning-foreground" },
  input: {
    label: "Input",
    icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  request: { label: "Request", icon: UserRoundIcon, className: "text-guest-foreground" },
  limited: { label: "Limited", icon: CircleAlertIcon, className: "text-warning-foreground" },
  failed: { label: "Failed", icon: CircleAlertIcon, className: "text-error-foreground" },
};

function AgentStatus({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const showText = useClientSettings((settings) => settings.sidebarThreadShowStatusText);
  const status = AGENT_STATUS[resolveSidebarThreadStatus(thread)];
  if (status === undefined) return null;
  const Icon = status.icon;
  return (
    <span
      role={showText ? undefined : "img"}
      aria-label={showText ? undefined : status.label}
      className={cn("inline-flex items-center gap-1 font-medium", status.className)}
    >
      <Icon aria-hidden className="size-3.5" />
      {showText ? status.label : null}
    </span>
  );
}
