# Live swap recorder

`live-swap-record` records a live host without restarting it. Run it locally on that host with a matching, dependency-installed production RPC source tree:

```sh
python3 t3nightly/live-swap-record --host studio --rpc-tree /internal/rpc-tree --start now --duration-s 900 --turn
```

Use `--until 2026-11-01T18:15:00Z` for an absolute end. Timestamps require a timezone. The command submits a launchd job on macOS or a transient systemd-user service on Linux and returns its label and receipt directory. It never connects to another host over SSH. Engine sources are snapshotted into the run; the job records its own PID, PGID, process identity and hard deadline. The default path is `~/.agent-rails/lanes/t3-hot-swap-cutover/proof/live-swap-<host>-<UTC timestamp>/`. Studio run and RPC paths must be internal storage.

`--turn` submits exactly one Claude Haiku turn through the running server's CLI in the already-registered `~/.t3/scratch` project. It does not register a project. The provider waits on a deadline-bound gate under the run directory. After NEW is observed and its replacement subscription attaches, the recorder releases the gate, allowing automatic continuation to complete with the original output nonce. Without a swap the gate releases during the last 45 seconds. It never sends a follow-up user prompt. Use `--thread ID` instead for read-only monitoring; that mode cannot produce a PASS because it lacks the provider-turn proof.

Authentication reuses the live install acceptance `restart_session`: the runtime's `auth session issue` CLI reaches the running server, writes the credential only into a private temporary 0600 bearer file, and revokes it at teardown. No direct write to live userdata is performed. Credentials and RPC errors are never logged. The temporary bearer directory is removed after revoke, and the bounded credential expires if revoke cannot reach the host.

The probe uses production EnvironmentSupervisor and ConnectionDriver with handoff client IDs, lifecycle hint, first reply and confirmation observations. It records all supervisor/presentation changes, physical WS connection and close events, fresh HTTP request outcomes/latency, keep-alive behavior, served versions and thread event cursors. Expected physical WS replacement during handoff is recorded separately from a disconnect presented to the user. Short read-only queries against only the selected thread compare persisted event IDs with received IDs; they do not hold a transaction across samples or infer gaps from globally noncontiguous sequence numbers.

Recording ends at the requested limit or after a version change and 60 seconds of NEW observations, whichever comes first. A truncated NEW settling interval fails. A successful swap grade requires no client offline/reconnecting/error/unsupported phase after initial connection, no failed HTTP or thread stream, no refused connection, no missed event or cursor reset, a version change, and automatic completion of the original provider turn on NEW without a follow-up prompt. A healthy recording with no version change is `NO-SWAP-OBSERVED`, never PASS. JSON and Markdown receipts retain the raw probe and turn evidence. Gate helper processes have their own deadline and captured identities; teardown releases the gate and signals only recorded matching PIDs.

No service restart, installer dispatch or live update RPC is part of this command. Linux uses `systemd-run --user` with `RuntimeMaxSec`; macOS uses its own launchd label and the worker's signal deadline. Normal recorder shutdown closes the client after taking the final continuity sample; that intentional close is not a presented disconnect.
