# Delegated completion notes

Fork setting `childCompletionNotes`, on by default. With it off, every delegated
completion wakes its parent exactly as upstream.

## The signal

A delegated child, local or remote, calls `task_outcome` with `clean` or `gaps`
before its final reply. The instruction is appended to the task text the child
receives while the setting is on. The tool dispatches the internal
`run.outcome.report` command, which stores `reportedOutcome` on the child's
running turn; the run upsert keeps that field when a later full-row write leaves
it out. When the turn finishes, the parent's task row takes the outcome of its
result run. Nothing is read from the reply's prose. A remote child's outcome comes
back in the thread-wait `resultRun` and rides on `delegated_task.remote.complete`.

## When a completion is a note

A completion becomes a quiet note only when all of these hold:

- the setting is on and the task completed with `reportedOutcome: "clean"`;
- the task is not `awaited` (`delegate_task` `awaited: true`, or any
  `mode: "wait"` task, so one that outlives its wait still wakes);
- the child has no pending runtime request;
- another async app-owned child of the parent has no result and is still
  working. A child waiting on its own children has no result yet, so it counts.

The note is a server-created user message with no run, sent as the child thread.
The task's delivery is marked `delivered` in the same commit, so a restart
neither repeats nor loses it, and the parent's next turn reads it through the
quiet-note context. Everything else keeps the upstream wake. The parent may be
idle or mid-turn: a run reads the notes created since the previous run started,
so a note written during a turn reaches the turn after it, and the note never
starts or steers a run of its own. The last child out wakes the parent, which
queues behind a turn in progress as upstream does.

A follow-up through `t3_thread_send` copies the task row, so it keeps `awaited`
and needs a fresh `task_outcome`.
