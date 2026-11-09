import sys
from pathlib import Path

from .release_job_runner import LIVE_HOLD_WAIT_S, RESOURCE_WAIT_CAP_S
from .release_targets import stage_action

HANG_GUARD = 10


def stage_spec(node, args):
    if node.defer_reason:
        return {"outcome": "deferred", "reason": node.defer_reason, "budget": 0, "resources": node.resources}
    root = str(args.run) if node.host == "studio" else args.remote_run
    tools = str(Path(__file__).resolve().parent) if node.host == "studio" else args.remote_tools
    python = sys.executable if node.host == "studio" else "python3"
    command = [python, f"{tools}/release-fast-stage", "--stage", node.id, "--host", node.host,
               "--version", args.version, "--topic", args.topic, "--run", root, "--advisory-workers", str(args.advisory_workers), "--rehearsal-drain-s", str(args.rehearsal_drain_s), *(["--startup-busy-ok"] if args.startup_busy_ok else []),
               "--remote-run", args.remote_run, "--remote-tools", args.remote_tools, *(["--linux-host", args.linux_host] if args.linux_host != "ax42" else []), "--base", args.base, "--override-reason", args.override_reason, *defer_argv(args)]
    install = stage_action(node.id) == "install"
    return {"label": f"com.agent-rails.t3fast-{args.version}-{node.id}",
            "command": command, "host": node.host,
            "budget": node.budget * HANG_GUARD, "resourceWaitCapSeconds": wait_cap(node),
            "resources": node.resources, "outcomes": node.outcomes,
            "lockRoot": str(Path.home() / ".t3nightly/resource-locks") if node.host == "studio"
            else "/home/jobs/t3nightly/resource-locks",
            "install": install, "result": f"{root}/install-{node.host}/outcome.json" if install else None}


def defer_argv(args):
    return [*(word for host in args.defer_host for word in ("--defer-host", host)), "--defer-reason", args.defer_reason] if args.defer_host else []


def wait_cap(node):
    return LIVE_HOLD_WAIT_S if any(resource.startswith("live-install:") for resource in node.resources) else RESOURCE_WAIT_CAP_S
