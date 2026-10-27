import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ThreadId,
  ThreadMoveToLocalCheckoutPreview,
  ThreadMoveToLocalCheckoutResult,
} from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  FolderGitIcon,
  FolderIcon,
  GitBranchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import {
  describeBranchDistance,
  describeChanges,
  FILE_CHANGE_LABEL,
  moveErrorMessage,
} from "./MoveToLocalCheckoutDialog.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { MiddleTruncate } from "./ui/middle-truncate";
import { Skeleton } from "./ui/skeleton";

// Listed inline rather than in a scroll box; the rest are counted.
const SHOWN_FILES = 8;

type PreviewState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly preview: ThreadMoveToLocalCheckoutPreview }
  | { readonly status: "failed"; readonly message: string };

function Section(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <div className="font-medium text-muted-foreground text-xs">{props.label}</div>
      {props.children}
    </div>
  );
}

function PathRow(props: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly path: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{props.icon}</span>
      <span className="shrink-0 text-muted-foreground">{props.label}</span>
      <code className="min-w-0 flex-1 text-xs">
        <MiddleTruncate value={props.path} />
      </code>
    </div>
  );
}

function PreviewBody(props: { readonly preview: ThreadMoveToLocalCheckoutPreview }) {
  const { preview } = props;
  const changes = describeChanges(preview.changes);
  const distance = describeBranchDistance(preview);
  const shown = preview.files.slice(0, SHOWN_FILES);
  const more = preview.files.length - shown.length + preview.filesOmitted;
  return (
    <div className="grid gap-4 px-6">
      <Section label="Where">
        <div className="grid gap-1 rounded-md border border-border/60 p-2.5">
          <PathRow icon={<FolderGitIcon />} label="Worktree" path={preview.worktreePath} />
          <ArrowDownIcon className="ms-0.5 size-3.5 text-muted-foreground" aria-hidden="true" />
          <PathRow icon={<FolderIcon />} label="Project folder" path={preview.localCheckoutPath} />
        </div>
      </Section>
      {preview.branch !== null ? (
        <Section label="Branch">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
            <GitBranchIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            <code className="text-xs">{preview.currentLocalBranch ?? "detached HEAD"}</code>
            <ArrowRightIcon className="size-3.5 text-muted-foreground" aria-label="becomes" />
            <code className="font-medium text-xs">{preview.branch}</code>
            {distance !== null ? (
              <span className="text-muted-foreground text-xs">· {distance}</span>
            ) : null}
          </div>
        </Section>
      ) : null}
      <Section label="Comes along">
        {changes === null ? (
          <p className="text-sm">No uncommitted changes. Only the branch switches.</p>
        ) : (
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-sm">
              <ChevronRightIcon
                className="size-3.5 text-muted-foreground transition-transform group-data-panel-open:rotate-90"
                aria-hidden="true"
              />
              {changes}
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <ul className="mt-1.5 grid gap-1 ps-5">
                {shown.map((file) => (
                  <li key={file.path} className="flex min-w-0 items-center gap-2 text-xs">
                    <Badge
                      size="sm"
                      variant={file.change === "untracked" ? "success" : "secondary"}
                    >
                      {FILE_CHANGE_LABEL[file.change]}
                    </Badge>
                    <code className="min-w-0 flex-1">
                      <MiddleTruncate value={file.path} />
                    </code>
                  </li>
                ))}
                {more > 0 ? (
                  <li className="text-muted-foreground text-xs">and {more} more</li>
                ) : null}
              </ul>
            </CollapsiblePanel>
          </Collapsible>
        )}
      </Section>
      <Section label="Stays behind">
        <p className="text-muted-foreground text-sm">
          {preview.worktreeOnDisk
            ? "The worktree folder keeps its own copy of these changes, on a detached HEAD. Ignored files there, like node_modules or .env, don't come along. Delete the folder once you no longer need it."
            : "The worktree folder is already gone, so only the branch moves."}
        </p>
      </Section>
    </div>
  );
}

function LoadingBody() {
  return (
    <div className="grid gap-3 px-6" aria-busy="true" aria-label="Checking what would move">
      <Skeleton className="h-16" shape="card" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-10" />
    </div>
  );
}

/** Shows exactly what a move would do, from a server-side dry run, before the user confirms. */
export function MoveToLocalCheckoutDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onMoved: (result: ThreadMoveToLocalCheckoutResult) => void;
  readonly onFailed: (message: string) => void;
}) {
  const { environmentId, threadId, open } = props;
  const moveThread = useAtomCommand(vcsEnvironment.moveThreadToLocalCheckout, {
    reportFailure: false,
  });
  // Subscribed only while open, with no cache, so each opening runs a fresh dry run.
  const query = useEnvironmentQuery(
    open ? vcsEnvironment.moveToLocalCheckoutPreview({ environmentId, input: { threadId } }) : null,
  );
  const [pending, setPending] = useState(false);
  const state: PreviewState =
    query.data !== null && !query.isPending
      ? { status: "ready", preview: query.data }
      : query.failure !== null || query.error !== null
        ? {
            status: "failed",
            message: moveErrorMessage(
              query.failure ?? query.error,
              "Couldn't check what would move.",
            ),
          }
        : { status: "loading" };

  const preview = state.status === "ready" ? state.preview : null;
  const blocker = preview?.blocker ?? null;
  const canMove = preview !== null && blocker === null && !pending;

  const confirm = async () => {
    setPending(true);
    const result = await moveThread({ environmentId, input: { threadId } });
    setPending(false);
    if (result._tag === "Success") {
      props.onOpenChange(false);
      props.onMoved(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const message = moveErrorMessage(squashAtomCommandFailure(result), "The thread couldn't move.");
    // A refusal usually means something changed since the check; show the fresh state.
    query.refresh();
    props.onFailed(message);
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && props.onOpenChange(next)}>
      <AlertDialogPopup className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Move to the local checkout</AlertDialogTitle>
          <AlertDialogDescription>
            The thread continues in the project folder from its next message.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {blocker !== null || state.status === "failed" ? (
          <div className="px-6">
            <Alert variant="error">
              <TriangleAlertIcon />
              <AlertTitle>Can't move yet</AlertTitle>
              <AlertDescription>
                {blocker?.message ?? (state.status === "failed" ? state.message : null)}
              </AlertDescription>
              <AlertAction>
                <Button size="xs" variant="outline" onClick={() => query.refresh()}>
                  Check again
                </Button>
              </AlertAction>
            </Alert>
          </div>
        ) : null}
        {preview?.interruptedMove ? (
          <div className="px-6">
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertTitle>An earlier move didn't finish</AlertTitle>
              <AlertDescription>
                Moving now first undoes what it left behind, then moves the thread.
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        {state.status === "loading" ? (
          <LoadingBody />
        ) : preview !== null && blocker === null && !preview.interruptedMove ? (
          <PreviewBody preview={preview} />
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" disabled={pending} />}>
            Cancel
          </AlertDialogClose>
          <Button size="sm" disabled={!canMove} onClick={() => void confirm()}>
            {pending ? "Moving…" : "Move"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
