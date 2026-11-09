import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

from .release_engine import require_engine, require_remote_engine
from .release_graph import FAST_DEADLINE, SUCCESS_OUTCOMES, critical_path, fast_graph
from .release_fast_spec import HANG_GUARD, defer_argv, stage_spec, wait_cap
from .release_job_runner import RESOURCE_WAIT_CAP_S, TERM_GRACE_S
from .release_jobs import HostJobs, TERMINAL, status, submit, write_status
from .release_targets import LINUX_TARGETS, linux_target, stage_action
from .release_timeline import Timeline, utc_now
from .release_uplink import UPLINK_KBPS, UPLINK_NODES, WINDOW, UplinkGate, parse_window
from .release_run_binding import bind_remote_runs
from .run_retention import finish_runs

LIVE_NODES = {"IM", "IL", "S", "F", "LM", "LR", "H", "AS", "W", "FW"}


def remote_engine():
    engine = Path(__file__).resolve().parent
    commit = subprocess.run(["git", "-C", str(engine), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    return f"/home/jobs/t3nightly/engine-{commit[:12]}/t3nightly"


def unavailable_host(node, unavailable):
    return next((host for host in (node.host, *node.writes) if host in unavailable), None)


def remote_engine_failures(args):
    failures = {}
    for host, address in LINUX_TARGETS.items():
        if host in args.defer_host:
            continue
        try:
            require_remote_engine(args.run / "candidate.json", args.remote_tools, address)
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
            failures[host] = f"{type(error).__name__}: {error}"
            print(f"release: warning: {host} engine verification failed: {error}", file=sys.stderr)
    return failures


def finish_fast(args):
    if not args.dry_run and not getattr(args, "engine_verified", False):
        return
    if not args.dry_run:
        try:
            require_engine(args.run / "candidate.json")
        except Exception as error:
            print(f"release: warning: final engine verification failed: {error}", file=sys.stderr)
        try:
            remote_engine_failures(args)
        except Exception as error:
            print(f"release: warning: final remote engine verification failed: {error}", file=sys.stderr)
    try:
        finish_runs(args.run, args.remote_run, args.remote_tools, dry_run=args.dry_run, linux_host=args.linux_host, hosts={host: address for host, address in LINUX_TARGETS.items() if host not in args.defer_host})
    except Exception as error:
        print(f"release: warning: run retention failed: {error}", file=sys.stderr)


def drive_fast(args):
    args.engine_verified = False
    unavailable = bind_remote_runs(args)
    graph = fast_graph(args.linux_host, args.defer_host, args.defer_reason)
    manifest = args.run / "candidate.json"
    engine_checked = False
    if not args.dry_run and manifest.is_file():
        require_engine(manifest)
        unavailable = {**remote_engine_failures(args), **unavailable}
        engine_checked = True
        args.engine_verified = True
    args.run.mkdir(parents=True, exist_ok=True)
    jobs = HostJobs(args.run, args.remote_run, args.remote_tools, args.dry_run, linux_host=args.linux_host)
    timeline = Timeline(args.run / "timeline.jsonl")
    inputs = {"version": args.version, "topic": args.topic,
              "remoteRun": args.remote_run, "remoteTools": args.remote_tools, "dryRun": args.dry_run,
              "rehearseOnly": args.rehearse_only, "overrideReason": args.override_reason,
              **({"deferredHosts": {host: args.defer_reason for host in args.defer_host}} if args.defer_host else {}),
              **({"advisoryWorkers": args.advisory_workers} if args.advisory_workers != 4 else {}),
              **({"rehearsalDrainS": args.rehearsal_drain_s} if args.rehearsal_drain_s != 45 else {}),
              **({"startupBusyOk": True} if args.startup_busy_ok else {}),
              **({"linuxHost": args.linux_host} if args.linux_host != "ax42" else {})}
    binding = args.run / "fast-inputs.json"
    try:
        with binding.open("x") as handle:
            json.dump(inputs, handle, sort_keys=True)
    except FileExistsError:
        if json.loads(binding.read_text()) != inputs:
            raise ValueError("fast run inputs changed; use a new run directory")
    state = args.run / "scheduler.json"
    existing = json.loads(state.read_text()) if state.exists() else {}
    coordinator_status = args.run / "coordinator/status.json"
    invocation = json.loads(coordinator_status.read_text()) if coordinator_status.exists() else {}
    start = existing.get("monotonicStart", invocation.get("monotonicStart", time.monotonic()))
    started_at = existing.get("start", utc_now())
    advisory = {node.id for node in graph if not node.gating}
    blocked = set(existing.get("blocked", []))
    done, failed, running = set(), (set(existing.get("failed", [])) - blocked) & advisory, {}
    pending = {node.id: node for node in graph if not (args.rehearse_only and (node.id in LIVE_NODES or stage_action(node.id) == "install"))}
    recorded = set(existing.get("recorded", [])) - set(existing.get("failed", []))
    completed_at = existing.get("releaseSeconds")
    uplink = UplinkGate(args.uplink_window, args.dry_run, existing.get("uplinkHeldSeconds", 0.0))
    last_status_poll = {}
    if not args.dry_run:
        for key, node in list(pending.items()):
            if node.defer_reason or unavailable_host(node, unavailable):
                continue
            try:
                last_status_poll[key] = time.monotonic()
                row = jobs.request(node, "status")
            except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
                if node.host == "studio":
                    raise
                row = {"outcome": "status-unavailable", "error": f"{type(error).__name__}: {error}"}
            if row.get("outcome") == "status-unavailable":
                unavailable[node.host] = row.get("error") or f"cannot recover durable job status for {key}; retry without changing job inputs"
                continue
            success = row.get("outcome") in SUCCESS_OUTCOMES if stage_action(key) == "install" else row.get("outcome") == "passed"
            if success:
                try:
                    row = jobs.request(node, "submit", stage_spec(node, args))
                except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
                    if node.host == "studio":
                        raise
                    unavailable[node.host] = f"{type(error).__name__}: {error}"
                    continue
                done.add(key)
                failed.discard(key)
                del pending[key]
                if key not in recorded:
                    timeline.record_fast(node, row)
                    recorded.add(key)
            elif row.get("outcome") == "cancelled":
                failed.add(key)
                del pending[key]
                if key not in recorded:
                    timeline.record_fast(node, row)
                    recorded.add(key)
            elif key in failed:
                del pending[key]
    while pending or running:
        if not args.dry_run and not engine_checked and "A" in done and manifest.is_file():
            require_engine(manifest)
            unavailable = {**remote_engine_failures(args), **unavailable}
            engine_checked = True
            args.engine_verified = True
        for key, node in list(pending.items()):
            lost = None if node.defer_reason else unavailable_host(node, unavailable)
            if lost or set(node.needs) & failed:
                failed.add(key)
                blocked.add(key)
                del pending[key]
                now = time.monotonic()
                timeline.record_fast(node, {"outcome": "failed", "reason": "host-unavailable" if lost else "dependency-failed",
                                           "error": unavailable.get(lost),
                                           "evidence": [], "resourceWaitSeconds": 0,
                                           "monotonicStart": now, "monotonicEnd": now,
                                           "seconds": 0, "start": utc_now(), "end": utc_now()})
            elif set(node.needs) <= done:
                if node.defer_reason:
                    now = time.monotonic()
                    row = {"outcome": "deferred", "reason": node.defer_reason, "seconds": 0,
                           "monotonicStart": now, "monotonicEnd": now, "start": utc_now(), "end": utc_now()}
                    outcome = args.run / f"install-{node.host}/outcome.json"
                    outcome.parent.mkdir(parents=True, exist_ok=True)
                    write_status(outcome, row)
                    if key not in recorded:
                        timeline.record_fast(node, row)
                        recorded.add(key)
                    done.add(key)
                    failed.discard(key)
                    blocked.discard(key)
                    del pending[key]
                    continue
                if uplink.hold(node):
                    continue
                spec = stage_spec(node, args)
                del pending[key]
                blocked.discard(key)
                try:
                    jobs.stage_inputs(node)
                    row = jobs.request(node, "submit", spec)
                except (OSError, RuntimeError, ValueError, subprocess.SubprocessError, json.JSONDecodeError) as error:
                    if node.gating and node.host == "studio":
                        raise
                    failed.add(key)
                    now = time.monotonic()
                    timeline.record_fast(node, {"outcome": "failed", "reason": "submit-failed", "error": f"{type(error).__name__}: {error}",
                                               "evidence": [], "resourceWaitSeconds": 0, "monotonicStart": now, "monotonicEnd": now,
                                               "seconds": 0, "start": utc_now(), "end": utc_now()})
                    recorded.add(key)
                    continue
                running[key] = (node, row, time.monotonic())
        for key, (node, row, submitted_at) in list(running.items()):
            if row["outcome"] not in TERMINAL:
                now = time.monotonic()
                if node.host == "studio" or key not in last_status_poll or now - last_status_poll[key] >= 2:
                    last_status_poll[key] = now
                    try:
                        latest = jobs.request(node, "status")
                    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
                        latest = {"outcome": "status-unavailable"}
                    if latest.get("outcome") != "status-unavailable":
                        row = latest
                if time.monotonic() > submitted_at + wait_cap(node) + node.budget * HANG_GUARD + TERM_GRACE_S + 5:
                    row = dict(row, outcome="timed-out", seconds=time.monotonic() - submitted_at,
                               host=node.host, evidence=row.get("evidence", []),
                               error="coordinator deadline exceeded")
                running[key] = (node, row, submitted_at)
            if row["outcome"] not in TERMINAL:
                continue
            if args.dry_run and stage_action(node.id) == "install":
                row = dict(row, outcome="installed")
            success = row["outcome"] in SUCCESS_OUTCOMES if stage_action(node.id) == "install" else row["outcome"] == "passed"
            (done if success else failed).add(key)
            if key not in recorded:
                timeline.record_fast(node, row)
                recorded.add(key)
            del running[key]
        if "F" in done and completed_at is None:
            completed_at = max(0.0, time.monotonic() - start - uplink.seconds)
        write_status(state, {"start": started_at, "monotonicStart": start,
                            "seconds": time.monotonic() - start, "releaseSeconds": completed_at,
                            "done": sorted(done), "failed": sorted(failed), "blocked": sorted(blocked & failed),
                            "recorded": sorted(recorded), "uplinkHeld": uplink.held, "uplinkHeldSeconds": uplink.seconds})
        uplink.pause(running, len(done) + len(failed))
    gating_failures = failed & {node.id for node in graph if node.gating}
    print(json.dumps({"done": sorted(done), "failed": sorted(failed), "releaseSeconds": completed_at, "uplinkHeldSeconds": round(uplink.seconds, 3),
                      "dryRun": args.dry_run, "rehearseOnly": args.rehearse_only, "gatingFailures": sorted(gating_failures),
                      **({"deferredHosts": inputs["deferredHosts"]} if "deferredHosts" in inputs else {})}))
    if args.rehearse_only:
        return 1 if gating_failures else 0
    return 1 if gating_failures or completed_at is None or completed_at >= 900 else 0


def main(argv):
    parser = argparse.ArgumentParser(description="Durable fast-release dependency scheduler")
    parser.add_argument("--fast", action="store_true", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--topic", required=True)
    parser.add_argument("--refresh-readiness", choices=tuple(LINUX_TARGETS))
    parser.add_argument("--refresh-reason", default="")
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--rehearse-only", action="store_true")
    parser.add_argument("--override-reason", default="")
    parser.add_argument("--coordinator", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--run", type=Path)
    parser.add_argument("--remote-run")
    parser.add_argument("--advisory-workers", type=int, default=4, help="maximum parallel advisory suite workers (default: 4)")
    parser.add_argument("--rehearsal-drain-s", type=int, choices=range(30, 61), default=45)
    parser.add_argument("--startup-busy-ok", action="store_true", help="window flag: hot-swap startup samples may run on a busy host (item 9)")
    parser.add_argument("--remote-tools")
    parser.add_argument("--linux-host", default="ax42", choices=(*LINUX_TARGETS, "pc-wsl"), help="shared Linux artifact builder (default: ax42)")
    parser.add_argument("--defer-host", action="append", default=[], choices=tuple(LINUX_TARGETS), help="skip a Linux host for this release (repeatable): no readiness probe, sandbox proofs or install")
    parser.add_argument("--defer-reason", default="", help="operator decision authorizing the deferral")
    parser.add_argument("--base", default="", help="base ref to build on instead of the serving release head; must contain it")
    parser.add_argument("--uplink-window", default=WINDOW, help=f"UTC span when bulk uploads may leave Studio (default {WINDOW}); off starts them at once")
    args = parser.parse_args(argv)
    try:
        parse_window(args.uplink_window)
    except ValueError as error:
        parser.error(str(error))
    args.defer_host = list(dict.fromkeys(args.defer_host))
    args.defer_reason = args.defer_reason.strip()
    if bool(args.defer_host) != bool(args.defer_reason):
        parser.error("--defer-host and a nonempty --defer-reason are required together")
    if args.advisory_workers < 1:
        parser.error("--advisory-workers must be positive")
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", args.linux_host):
        parser.error("--linux-host must be an SSH alias or hostname")
    if not re.fullmatch(r"\d+\.\d+\.\d+-nightly\.\d+\.\d+\.aneym\.\d+", args.version):
        parser.error("version must be an upstream nightly plus .aneym.N")
    args.linux_host = LINUX_TARGETS[linux_target(args.linux_host)]
    try:
        graph = fast_graph(args.linux_host, args.defer_host, args.defer_reason)
    except ValueError as error:
        parser.error(str(error))
    args.run = (args.run or Path.home() / ".t3nightly/runs" / args.version / "fast").resolve()
    args.remote_run = args.remote_run or f"/home/jobs/t3nightly/runs/{args.version}/fast"
    args.remote_tools = args.remote_tools or remote_engine()
    if args.refresh_readiness:
        if not args.refresh_reason.strip():
            parser.error("--refresh-readiness requires --refresh-reason")
        if args.plan or args.dry_run or args.coordinator:
            parser.error("readiness refresh cannot schedule or simulate a release")
        from .release_readiness_refresh import refresh

        return refresh(args, sys.stdout)
    if args.plan:
        path, seconds = critical_path(graph)
        print(json.dumps({"deadline": FAST_DEADLINE, "criticalPath": path, "criticalSeconds": seconds, "uplinkWindow": args.uplink_window, "uplinkKBps": UPLINK_KBPS,
                          "nodes": [dict(id=node.id, name=node.name, needs=node.needs, uplink=node.id in UPLINK_NODES,
                                         gating=node.gating, **stage_spec(node, args)) for node in graph]}, indent=2))
        return 0
    if args.dry_run or args.coordinator:
        try:
            return drive_fast(args)
        finally:
            finish_fast(args)
    if (args.run / "candidate.json").is_file():
        require_engine(args.run / "candidate.json")
    bind_remote_runs(args)
    coordinator = args.run / "coordinator"
    previous = status(coordinator)
    if previous.get("outcome") in {"failed", "timed-out", "environment-blocked", "cancelled"}:
        attempt = 1
        while (args.run / f"coordinator-{attempt}").exists():
            attempt += 1
        coordinator = args.run / f"coordinator-{attempt}"
    command = [sys.executable, str(Path(__file__).resolve().with_name("release")),
               "--fast", "--version", args.version, "--topic", args.topic,
               "--run", str(args.run), "--remote-run", args.remote_run, "--advisory-workers", str(args.advisory_workers), "--rehearsal-drain-s", str(args.rehearsal_drain_s), *(["--startup-busy-ok"] if args.startup_busy_ok else []),
               "--remote-tools", args.remote_tools, *(["--linux-host", args.linux_host] if args.linux_host != "ax42" else []), "--base", args.base, "--override-reason", args.override_reason, "--uplink-window", args.uplink_window, "--coordinator", *defer_argv(args), *(["--rehearse-only"] if args.rehearse_only else [])]
    spec = {"label": f"com.agent-rails.t3fast-{args.version}-coordinator-{coordinator.name}", "host": "studio",
            "command": command, "budget": sum(node.budget * HANG_GUARD + wait_cap(node) + TERM_GRACE_S + 5 for node in graph) + 60,
            "resourceWaitCapSeconds": RESOURCE_WAIT_CAP_S,
            "resources": ["fast-release-run"], "lockRoot": str(Path.home() / ".t3nightly/resource-locks")}
    print(json.dumps(submit(coordinator, spec)))
    return 0
