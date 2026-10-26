import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { FolderInputIcon } from "lucide-react";
import { cloneElement, useState, type ReactElement, type ReactNode } from "react";

import { useProject, useQuietThreadShell } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface MoveToLocalCheckoutTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The thread could not be moved.";
}

/** Wraps a worktree thread's locked workspace label in a menu that moves it to the local checkout. */
export function MoveToLocalCheckoutMenu(props: {
  readonly target: MoveToLocalCheckoutTarget;
  /** The label's element without children; it becomes the menu trigger when the move is allowed. */
  readonly trigger: ReactElement;
  readonly children: ReactNode;
}) {
  const { environmentId, threadId, projectId, worktreePath } = props.target;
  const composerMenuProps = useComposerMenuProps();
  const thread = useQuietThreadShell(scopeThreadRef(environmentId, threadId));
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const moveThread = useAtomCommand(vcsEnvironment.moveThreadToLocalCheckout, {
    reportFailure: false,
  });
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  if (!canWriteSourceControl || !canOperate) {
    return cloneElement(props.trigger, undefined, props.children);
  }

  const running = (thread?.runtime?.activeRunId ?? null) !== null;
  const branch = thread?.branch ?? null;
  const localPath = project?.workspaceRoot ?? null;

  const confirm = async () => {
    setPending(true);
    const result = await moveThread({
      environmentId,
      input: { threadId },
    });
    setPending(false);
    if (result._tag === "Success") {
      setConfirming(false);
      const moved = result.value;
      // Refreshing re-reads both checkouts' branch lists, which still show the old worktree.
      const refreshed = [moved.localCheckoutPath];
      if (moved.previousWorktreeKept) refreshed.push(moved.previousWorktreePath);
      for (const cwd of refreshed) {
        void refreshVcsStatus({ environmentId, input: { cwd } });
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Moved to the local checkout on ${moved.branch}`,
          description: [
            moved.carriedChanges ? "Uncommitted changes came along." : null,
            moved.previousWorktreeKept
              ? "The old worktree folder is kept with its own copy of the changes."
              : null,
          ]
            .filter((line) => line !== null)
            .join(" "),
        }),
      );
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not move to the local checkout",
        description: errorMessage(squashAtomCommandFailure(result)),
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
      <AlertDialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Move this thread to the local checkout?</AlertDialogTitle>
            <AlertDialogDescription>
              {localPath ?? "The project folder"} switches to{" "}
              {branch === null ? "this thread's branch" : <code>{branch}</code>}, and the worktree's
              uncommitted changes come with it. The local checkout needs no uncommitted changes of
              its own. The agent continues there from its next message. The worktree folder at{" "}
              <code>{worktreePath}</code> stays, on a detached HEAD with its own copy of the
              changes. It isn't deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" disabled={pending} />}>
              Cancel
            </AlertDialogClose>
            <Button size="sm" disabled={pending} onClick={() => void confirm()}>
              {pending ? "Moving…" : "Move"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
