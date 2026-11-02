import argparse
import json
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

from .release_hold_units import cleanup, inspect, install, read, signal, snapshot
from .release_hold_watch import worker
from .release_jobs import write_status
from .release_targets import LINUX_TARGETS

HOSTS = ("studio", "forge", "owl", "ax42")


def remote(config, operation):
    argv = ["python3", "-B", config["tools"] + "/release-holds", "host", operation]
    result = subprocess.run(["ssh", "-oBatchMode=yes", "-oConnectTimeout=5", LINUX_TARGETS[config["host"]],
                             shlex.join(argv)], input=json.dumps(config), capture_output=True,
                            text=True, timeout=40, check=True)
    return json.loads(result.stdout)


def host_action(config, operation):
    if operation == "start":
        return install(config)
    if operation == "status":
        cleanup(config)
        return inspect(config)
    if operation in ("release", "stop"):
        return signal(config, stop=operation == "stop")
    raise ValueError("unknown host operation")


def request(config, operation):
    return host_action(config, operation) if config["host"] == "studio" else remote(config, operation)


def configure(args, run):
    source_path = run / "release-holds/source.json"
    if source_path.exists():
        source = read(source_path)
        if args.operation == "start" and source != source_config(args, run):
            raise ValueError("hold inputs changed; repeat the original start arguments")
        if source["version"] != args.version:
            raise ValueError("hold version mismatch")
        return source
    if args.operation != "start":
        raise ValueError("hold watchers have not been configured")
    source = source_config(args, run)
    source_path.parent.mkdir(parents=True, exist_ok=True)
    write_status(source_path, source)
    return source


def source_config(args, run):
    if args.interval <= 0 or args.quarantine_seconds < 0:
        raise ValueError("invalid watcher interval or quarantine delay")
    if not args.sandbox and args.quarantine_seconds != 300:
        raise ValueError("live forge quarantine requires five minutes")
    if args.sandbox and (not args.lock_root or not args.remote_lock_root):
        raise ValueError("sandbox requires explicit local and remote lock roots")
    hosts = list(dict.fromkeys(args.hosts or HOSTS))
    if any(host != "studio" for host in hosts) and not args.remote_tools:
        raise ValueError("--remote-tools is required for Linux hold units")
    return {"version": args.version, "run": str(run), "hosts": hosts,
            "gate": str(Path(args.gate).expanduser().resolve()) if args.gate else str(run / "release-holds/gate.go"),
            "tools": str(Path(__file__).resolve().parent), "python": sys.executable,
            "leadHost": args.lead_host, "remoteRun": args.remote_run or f"/home/jobs/t3nightly/runs/{args.version}/fast",
            "remoteTools": args.remote_tools,
            "lockRoot": str(Path(args.lock_root).expanduser().resolve()) if args.lock_root else str(Path.home() / ".t3nightly/resource-locks"),
            "remoteLockRoot": args.remote_lock_root or "/home/jobs/t3nightly/resource-locks",
            "sandbox": args.sandbox, "interval": args.interval, "quarantineSeconds": args.quarantine_seconds}


def host_config(source, host):
    local = host == "studio"
    return {"host": host, "version": source["version"],
            "run": source["run"] if local else source["remoteRun"],
            "tools": source["tools"] if local else source["remoteTools"],
            "lockRoot": source["lockRoot"] if local else source["remoteLockRoot"],
            "sourceRun": source["run"], "sourceTools": source["tools"], "sourcePython": source["python"],
            "leadHost": source["leadHost"], "sandbox": source["sandbox"],
            "interval": source["interval"], "quarantineSeconds": source["quarantineSeconds"]}


def main(argv):
    if argv and argv[0] == "worker":
        return worker(argv[1])
    if argv and argv[0] == "host":
        print(json.dumps(host_action(json.load(sys.stdin), argv[1])))
        return 0
    if argv and argv[0] == "snapshot":
        source = read(Path(argv[1]) / "release-holds/source.json")
        print(json.dumps(snapshot(source, argv[2], json.load(sys.stdin))))
        return 0
    parser = argparse.ArgumentParser(description="Durable per-host live-install holds and release watchers; never stops release runs.")
    parser.add_argument("operation", choices=("start", "status", "release", "stop"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--run", type=Path, help="lead fast run directory")
    parser.add_argument("--remote-run")
    parser.add_argument("--remote-tools")
    parser.add_argument("--hosts", nargs="+", choices=HOSTS)
    parser.add_argument("--host", choices=HOSTS, help="one host for release, status or stop")
    parser.add_argument("--gate", help="lead approval marker; default RUN/release-holds/gate.go")
    parser.add_argument("--lock-root")
    parser.add_argument("--remote-lock-root")
    parser.add_argument("--lead-host", default="studio")
    parser.add_argument("--interval", type=float, default=20)
    parser.add_argument("--quarantine-seconds", type=float, default=300)
    parser.add_argument("--sandbox", action="store_true", help="no live secret DB reads or fleet-drain calls")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.version):
        parser.error("invalid version")
    if args.operation == "release" and not args.host:
        parser.error("release requires --host; ax42 is always manual")
    run = (args.run or Path.home() / ".t3nightly/runs" / args.version / "fast").expanduser().resolve()
    source = configure(args, run)
    hosts = [args.host] if args.host else source["hosts"]
    if any(host not in source["hosts"] for host in hosts):
        parser.error("host is not configured for this run")
    values = {}
    for host in hosts:
        config = host_config(source, host)
        values[host] = request(config, args.operation)
    if args.operation == "stop":
        deadline = time.monotonic() + 90
        while any(value["unitActive"] for value in values.values()):
            if time.monotonic() >= deadline:
                raise RuntimeError("stop files written; units still exiting, inspect status (no runs killed)")
            time.sleep(min(source["interval"], 1))
            values = {host: request(host_config(source, host), "status") for host in hosts}
    print(json.dumps({"version": args.version, "run": str(run), "hosts": values}, sort_keys=True))
    return 0
