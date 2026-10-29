import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

from .release_graph import FAST_DEADLINE, FAST_GRAPH, SUCCESS_OUTCOMES, critical_path
from .release_job_runner import TERM_GRACE_S
from .release_jobs import HostJobs, TERMINAL, status, submit, write_status
from .release_timeline import Timeline, utc_now

HANG_GUARD = 10
LIVE_NODES = {"IM", "IL", "S", "F", "LM", "H", "AS"}


def stage_spec(node, args):
    root = str(args.run) if node.host == "studio" else args.remote_run
    tools = str(Path(__file__).resolve().parent) if node.host == "studio" else args.remote_tools
    python = sys.executable if node.host == "studio" else "python3"
    command = [python, f"{tools}/release-fast-stage", "--stage", node.id, "--host", node.host,
               "--version", args.version, "--topic", args.topic, "--run", root,
               "--remote-run", args.remote_run, "--remote-tools", args.remote_tools, "--base", args.base]
    install = node.id in ("IM", "IL")
    return {"label": f"com.agent-rails.t3fast-{args.version}-{node.id}",
            "command": command, "host": node.host,
            "budget": node.budget * HANG_GUARD, "resources": node.resources, "outcomes": node.outcomes,
            "lockRoot": str(Path.home() / ".t3nightly/resource-locks") if node.host == "studio"
            else "/home/jobs/t3nightly/resource-locks",
            "install": install, "result": f"{root}/install-{node.host}/outcome.json" if install else None}


def remote_engine():
    engine = Path(__file__).resolve().parent
    commit = subprocess.run(["git", "-C", str(engine), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    return f"/home/jobs/t3nightly/engine-{commit[:12]}/t3nightly"


def drive_fast(args):
    args.run.mkdir(parents=True, exist_ok=True)
    jobs = HostJobs(args.run, args.remote_run, args.remote_tools, args.dry_run)
    timeline = Timeline(args.run / "timeline.jsonl")
    inputs = {"version": args.version, "topic": args.topic,
              "remoteRun": args.remote_run, "remoteTools": args.remote_tools, "dryRun": args.dry_run,
              "rehearseOnly": args.rehearse_only}
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
    done, failed, running = set(), set(), {}
    pending = {node.id: node for node in FAST_GRAPH if not (args.rehearse_only and node.id in LIVE_NODES)}
    recorded = set(existing.get("recorded", []))
    completed_at = existing.get("releaseSeconds")
    while pending or running:
        for key, node in list(pending.items()):
            if set(node.needs) & failed:
                failed.add(key)
                del pending[key]
                now = time.monotonic()
                timeline.record_fast(node, {"outcome": "failed", "reason": "dependency-failed",
                                           "evidence": [], "resourceWaitSeconds": 0,
                                           "monotonicStart": now, "monotonicEnd": now,
                                           "seconds": 0, "start": utc_now(), "end": utc_now()})
            elif set(node.needs) <= done:
                spec = stage_spec(node, args)
                row = jobs.request(node, "submit", spec)
                running[key] = (node, row, time.monotonic())
                del pending[key]
        for key, (node, row, submitted_at) in list(running.items()):
            if row["outcome"] not in TERMINAL:
                try:
                    latest = jobs.request(node, "status")
                except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
                    latest = {"outcome": "status-unavailable"}
                if latest.get("outcome") != "status-unavailable":
                    row = latest
                if time.monotonic() > submitted_at + node.budget * HANG_GUARD + TERM_GRACE_S + 5:
                    row = dict(row, outcome="timed-out", seconds=time.monotonic() - submitted_at,
                               host=node.host, evidence=row.get("evidence", []),
                               error="coordinator deadline exceeded")
                running[key] = (node, row, submitted_at)
            if row["outcome"] not in TERMINAL:
                continue
            if args.dry_run and node.id in ("IM", "IL"):
                row = dict(row, outcome="installed")
            success = row["outcome"] in SUCCESS_OUTCOMES if node.id in ("IM", "IL") else row["outcome"] == "passed"
            (done if success else failed).add(key)
            if key not in recorded:
                timeline.record_fast(node, row)
                recorded.add(key)
            del running[key]
        if "F" in done and completed_at is None:
            completed_at = time.monotonic() - start
        write_status(state, {"start": started_at, "monotonicStart": start,
                            "seconds": time.monotonic() - start, "releaseSeconds": completed_at,
                            "done": sorted(done), "failed": sorted(failed), "recorded": sorted(recorded)})
        if running and not args.dry_run:
            time.sleep(0.2)
    gating_failures = failed & {node.id for node in FAST_GRAPH if node.gating}
    print(json.dumps({"done": sorted(done), "failed": sorted(failed), "releaseSeconds": completed_at,
                      "dryRun": args.dry_run, "rehearseOnly": args.rehearse_only, "gatingFailures": sorted(gating_failures)}))
    if args.rehearse_only:
        return 1 if gating_failures else 0
    return 1 if gating_failures or completed_at is None or completed_at >= 900 else 0


def main(argv):
    parser = argparse.ArgumentParser(description="Durable fast-release dependency scheduler")
    parser.add_argument("--fast", action="store_true", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--topic", required=True)
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--rehearse-only", action="store_true")
    parser.add_argument("--coordinator", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--run", type=Path)
    parser.add_argument("--remote-run")
    parser.add_argument("--remote-tools")
    parser.add_argument("--base", default="", help="base ref to build on instead of the serving release head; must contain it")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"\d+\.\d+\.\d+-nightly\.\d+\.\d+\.aneym\.\d+", args.version):
        parser.error("version must be an upstream nightly plus .aneym.N")
    args.run = (args.run or Path.home() / ".t3nightly/runs" / args.version / "fast").resolve()
    args.remote_run = args.remote_run or f"/home/jobs/t3nightly/runs/{args.version}/fast"
    args.remote_tools = args.remote_tools or remote_engine()
    if args.plan:
        path, seconds = critical_path()
        print(json.dumps({"deadline": FAST_DEADLINE, "criticalPath": path, "criticalSeconds": seconds,
                          "nodes": [dict(id=node.id, name=node.name, needs=node.needs,
                                         gating=node.gating, **stage_spec(node, args)) for node in FAST_GRAPH]}, indent=2))
        return 0
    if args.dry_run or args.coordinator:
        return drive_fast(args)
    coordinator = args.run / "coordinator"
    previous = status(coordinator)
    if previous.get("outcome") in {"failed", "timed-out", "environment-blocked"}:
        attempt = 1
        while (args.run / f"coordinator-{attempt}").exists():
            attempt += 1
        coordinator = args.run / f"coordinator-{attempt}"
    command = [sys.executable, str(Path(__file__).resolve().with_name("release")),
               "--fast", "--version", args.version, "--topic", args.topic,
               "--run", str(args.run), "--remote-run", args.remote_run,
               "--remote-tools", args.remote_tools, "--base", args.base, "--coordinator", *(["--rehearse-only"] if args.rehearse_only else [])]
    spec = {"label": f"com.agent-rails.t3fast-{args.version}-coordinator-{coordinator.name}", "host": "studio",
            "command": command, "budget": sum(node.budget for node in FAST_GRAPH) * HANG_GUARD + 60,
            "resources": ["fast-release-run"], "lockRoot": str(Path.home() / ".t3nightly/resource-locks")}
    print(json.dumps(submit(coordinator, spec)))
    return 0
