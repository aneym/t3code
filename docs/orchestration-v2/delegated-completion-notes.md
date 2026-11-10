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
- the parent has no run preparing, starting, running or waiting;
- another async app-owned child of the parent has no result and is still
  working. A child waiting on its own children has no result yet, so it counts.

The note is a server-created user message with no run, sent as the child thread.
The task's delivery is marked `delivered` in the same commit, so a restart
neither repeats nor loses it, and the parent's next turn reads it through the
quiet-note context. Everything else keeps the upstream wake. Requiring an idle
parent means a note is always read at the next run's start; a busy parent keeps
the steer or queued-run delivery.

A follow-up through `t3_thread_send` copies the task row, so it keeps `awaited`
and needs a fresh `task_outcome`.
