# Hard installer: ssh-launch strays

A desktop client's ssh launcher (`packages/ssh/src/tunnel.ts`) starts its own `t3 serve` when it finds no server answering. If that happens while the installer has the service stopped, the launcher's server takes the T3 home lock, and neither the candidate nor the rollback can start. The installer reaps such a server inside the cutover window only (`install_strays.py`).

A process is reaped only when all of these hold: its pid comes from `<home>/ssh-launch/*/pid`, the marker says `managed`, it runs as the installer's uid, its argv names the target home, it started within 10 s of its pid file, and it either listens on the service port or owns the home lock. Lock ownership is SQLite's exclusive write lock on the shared byte range of `server-owner.sqlite`: the pid in `/proc/locks` on Linux, the `F_GETLK` holder on macOS. Neither query takes a lock. Each reap is recorded in the install receipt's `reapedSshLaunch`, at most three times per health phase.

Signals are bound to the checked process on Linux through a pidfd (`platformBinding: "pidfd"`). macOS has no process-bound signal. There the reaper registers a kqueue `EVFILT_PROC NOTE_EXIT` watch before checking identity, and skips the signal once that process has exited (`platformBinding: "kqueue-checked"`, with a `hard-reap-skip-exited` step whenever a skip happens). The remaining window lies between that poll and `kill(2)`: the process would have to exit, be reaped, and have its pid reassigned through a full wrap of Darwin's sequential pid space. The t3-nightly orchestrator accepted this as the macOS floor on 2026-10-29.

The maintenance backup can omit its database copy only when the manifest proves binary compatibility against the observed migration history. Other pre-cutover backups use a size- and disk-aware copy deadline. After routing, rollback is restricted to a compatible hot swap; the current database is never restored.

A candidate server prunes runtime versions that nothing references and that are more than an hour old (`prunePinnedRuntimes` in `apps/server/src/cloud/pinnedRuntime.ts`), so the previous version can disappear while the candidate serves. Before cutover the installer keeps a copy of the previous runtime in `<home>/runtime/.rollback-runtime/` and restores it before a rollback activates it. Files are hard links where `runtime/versions` shares a filesystem with the store and plain copies where it does not (a state dir may be a symlink to another volume).

## Live admission

Every installer mode, IM/IL stage, desktop swap and Windows feed activation checks UTC admission. Admission is restricted to the minute beginning at 08:00Z or 18:00Z; an admitted cutover may finish later. `--override-reason "..."` records the reason in the install receipt and appends an override record to `~/.agent-rails/lanes/t3-fast-release/STATE.md`. It is checked again immediately before cutover. Recovery of an admitted cutover does not wait for another window.

Other-host dispatches, including forge, pc-wsl, Book and native Windows installers, use `install-window --host HOST --version VERSION --receipt FILE [--override-reason TEXT] -- COMMAND ...`. This gates dispatch before SSH or a native installer runs. Unix hosts also enforce admission in `install` itself. Native Windows and desktop-bundled servers keep their existing update mechanism.

Rehearsals are exempt only with all three: a private home, a non-live port, and a `t3-rehearsal-*` or `com.t3-rehearsal.*` service. `--rehearsal`, `--force-rollback`, `--restart-probe` and `--drain-proof` refuse live identities even with an override. `--live-home PATH` protects an additional configured live home; symlink aliases are resolved.

## Hot-swap installation

`install --seamless` requires the candidate/artifact manifests, an isolated rehearsal receipt, `--rpc-tree`, and a real `--chat-project`. It calls `server.updateServer`, whose server-side self-update service requests the launcher over IPC. The bounded serving gate matches version and launcher update ID. Acceptance checks historical identities, a real chat reply and any desired managed T3 Connect link, including one unhealthy before installation.

Only launchd/systemd-user services advertising `capabilities.serverHotSwap: true`, with verified running launcher bytes, protocol-qualified ingress and an isolated measured candidate qualify. WSL additionally needs systemd-user and linger. The pinned ingress drain deadline must equal `--drain-s`; a different deadline requires a launcher maintenance update. The protocol currently allows at most 300 seconds. Unsupported hosts record `hot-swap-unsupported` and use drain followed by the maintenance installer. Migration flags, maintenance flags, startup over budget or a launcher change also require maintenance. The fast IM/IL nodes use this selector.

After public routing, the database is never restored. A failed acceptance can swap back only with explicit manifest compatibility and a qualified launcher; otherwise the receipt requests forward repair and preserves the current database. Pre-routing launcher trial recovery remains the launcher's responsibility.

## Independent service artifacts

Server-only updates preserve `runtime/launcher` bytes. A launcher change requires `--launcher-artifact FILE`: schema `t3nightly.launcher-artifact/1`, `runtimeDir`, `sha256`, and `protocol: 3`. Hot-swap launchers additionally declare `hotSwapProtocol: 1` and `ingress` matching the production `LauncherIngressConfig` contract. The engine keeps last-known-good bytes/config and a bounded watchdog restores that launcher on failure without reverting the current database.

`--connector-artifact FILE` pins the separate `__service-connector` supervisor. Its schema is `t3nightly.connector-artifact/1`, with `runtimeDir`, `sha256` and `protocol: 1`. A launcher artifact can supply the same supervisor bytes; their pins and units remain independent. Production renderers create `t3code-connector.service` or `com.t3tools.t3code-connector.service`. Identical pinned bytes do not restart it. `service-artifacts install|uninstall` manages its owned unit and keeps runtime bytes on uninstall. Connector configuration is server-owned; the engine neither reads nor prints its credential.

## Isolated hot-swap proof

`rehearse --hot-swap --rpc-tree TREE` uses the production service renderers, the launcher, `KillMode=mixed` and 90-second stop deadlines. It keeps an HTTP loop, reused keep-alive connection, resumable WS event cursor and real running/queued turns. JSON and Markdown receipts record refused connections, flip gap, served versions, persisted-event continuity and database integrity. A fallback is explicitly non-hot-swap evidence, not a zero-outage pass.

A capable rehearsal accepts `--launcher-artifact` and `--connector-artifact`, remapping ingress to its sandbox endpoint. It exercises a queue-capacity-plus-one HTTP burst and launcher crash recovery. `--inject warm-death` kills the real trial at its warm IPC milestone; `--inject post-flip` kills it before validation/routing. `--force-rollback` injects a failed acceptance after routing. The isolated Node preload supplies crash injection without changing signed executable bytes. Unsupported launchers refuse crash modes rather than inventing a rollback proof. True hot-swap/crash receipts require the server branch and qualified old/candidate builds; current older builds prove only the fallback.
