import type { ContextMenuItem } from "@t3tools/contracts";
import { projectGroupPinOrder } from "@t3tools/client-runtime/state/project-pins";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";

export function buildProjectContextMenu(input: {
  project: SidebarProjectSnapshot;
  canPin: boolean;
  togglePin: () => Promise<void>;
  canEdit: (member: SidebarProjectGroupMember) => boolean;
  rename: (member: SidebarProjectGroupMember) => void;
  group: (member: SidebarProjectGroupMember) => void;
  copyPath: (member: SidebarProjectGroupMember) => void;
  remove: (member: SidebarProjectGroupMember) => Promise<void>;
  settings: () => void;
}) {
  const { project } = input;
  const handlers = new Map<string, () => Promise<void> | void>();
  const targeted = (
    action: "rename" | "group" | "copyPath" | "remove",
    label: string,
  ): ContextMenuItem<string> => {
    const leaves = project.memberProjects.map((member): ContextMenuItem<string> => {
      const id = `${action}:${member.physicalProjectKey}`;
      handlers.set(id, () => input[action](member));
      return {
        id,
        label:
          project.groupedProjectCount <= 1
            ? member.title
            : member.environmentLabel
              ? `${member.environmentLabel}: ${member.workspaceRoot}`
              : member.workspaceRoot,
        ...(action === "remove" ? { destructive: true } : {}),
        ...((action === "rename" || action === "remove") && !input.canEdit(member)
          ? { disabled: true }
          : {}),
      };
    });
    return leaves.length === 1
      ? { ...leaves[0]!, label, ...(action === "remove" ? { icon: "trash" } : {}) }
      : {
          id: `${action}:submenu`,
          label,
          children: leaves,
          ...(action === "remove" ? { icon: "trash" } : {}),
        };
  };
  handlers.set("pin-project", input.togglePin);
  handlers.set("project-settings", input.settings);
  const items: ContextMenuItem<string>[] = [
    {
      id: "pin-project",
      label: projectGroupPinOrder(project) === null ? "Pin project" : "Unpin project",
      disabled: !input.canPin,
    },
    targeted("rename", "Rename"),
    targeted("group", "Group into..."),
    targeted("copyPath", "Copy Path"),
    { id: "project-settings", label: "Project settings", icon: "settings" },
    targeted("remove", "Remove"),
  ];
  return {
    items,
    run: async (id: string) => {
      await handlers.get(id)?.();
    },
  };
}
