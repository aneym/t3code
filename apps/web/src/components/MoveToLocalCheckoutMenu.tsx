import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type ThreadMoveToLocalCheckoutResult,
} from "@t3tools/contracts";
import { FolderInputIcon } from "lucide-react";
import { cloneElement, useState, type ReactElement, type ReactNode } from "react";

import { useQuietThreadShell } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { MoveToLocalCheckoutDialog } from "./MoveToLocalCheckoutDialog";
import { describeMoveResult } from "./MoveToLocalCheckoutDialog.logic";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface MoveToLocalCheckoutTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string;
}

/** Wraps a worktree thread's locked workspace label in a menu that moves it to the local checkout. */
export function MoveToLocalCheckoutMenu(props: {
  readonly target: MoveToLocalCheckoutTarget;
  /** The label's element without children; it becomes the menu trigger when the move is allowed. */
  readonly trigger: ReactElement;
  readonly children: ReactNode;
}) {
  const { environmentId, threadId } = props.target;
  const composerMenuProps = useComposerMenuProps();
  const thread = useQuietThreadShell(scopeThreadRef(environmentId, threadId));
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const [confirming, setConfirming] = useState(false);

  if (!canWriteSourceControl || !canOperate) {
    return cloneElement(props.trigger, undefined, props.children);
  }

  const running = (thread?.runtime?.activeRunId ?? null) !== null;

  const moved = (result: ThreadMoveToLocalCheckoutResult) => {
    // Refreshing re-reads both checkouts' branch lists, which still show the old worktree.
    const refreshed = [result.localCheckoutPath];
    if (result.previousWorktreeKept) refreshed.push(result.previousWorktreePath);
    for (const cwd of refreshed) {
      void refreshVcsStatus({ environmentId, input: { cwd } });
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Moved to the local checkout",
        description: describeMoveResult(result),
      }),
    );
  };

  return (
    <>
      <Menu modal={false}>
        <MenuTrigger render={props.trigger} aria-label="Workspace actions">
          {props.children}
        </MenuTrigger>
        <MenuPopup align="start" {...composerMenuProps}>
          <MenuItem disabled={running} onClick={() => setConfirming(true)}>
            <FolderInputIcon />
            {running
              ? "Move to local checkout (wait for the turn to end)"
              : "Move to local checkout…"}
          </MenuItem>
        </MenuPopup>
      </Menu>
      <MoveToLocalCheckoutDialog
        environmentId={environmentId}
        threadId={threadId}
        open={confirming}
        onOpenChange={setConfirming}
        onMoved={moved}
        onFailed={(message) =>
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Couldn't move to the local checkout",
              description: message,
            }),
          )
        }
      />
    </>
  );
}
