import json
import plistlib
import subprocess
import sys
import re
from pathlib import Path


def render(tree, home, unit, program, log, environment, kind="server", connector_unit=None):
    request = home / ".service-render.json"
    request.write_text(json.dumps({"tree": str(tree), "platform": sys.platform, "home": str(home), "unit": str(unit), "program": program, "log": str(log), "environment": environment, "kind": kind, "connectorUnit": str(connector_unit) if connector_unit else None}))
    try:
        result = subprocess.run(["node", str(Path(__file__).with_name("render_service.mjs")), str(request)], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise ValueError("production service renderer failed: " + result.stderr[-1500:])
        return result.stdout
    finally:
        request.unlink(missing_ok=True)


def boot(sandbox, argv, log):
    environment = sandbox.service_environment()
    if sys.platform == "darwin":
        from .rehearsal_internal import internal

        internal(sandbox.args.rpc_tree)

    if sandbox.args.hot_swap:
        from shutil import copy2

        fault = sandbox.home / "runtime/hot-swap-fault.cjs"
        copy2(Path(__file__).with_name("hot_swap_fault.cjs"), fault)
        hold = 0
        if getattr(sandbox.args, "queue_mode", "none") != "none":
            config = json.loads((sandbox.home / "runtime/launcher-config.json").read_text())
            hold = 2000 if sandbox.args.queue_mode == "capacity" else config["holdBudgetMs"] + 1000
        if getattr(sandbox.args, "watchdog_bad_launcher", ""):
            environment["T3_REHEARSAL_BAD_LAUNCHER"] = sandbox.args.watchdog_bad_launcher
            environment["T3_REHEARSAL_LAUNCHER_DEATHS"] = str(sandbox.evidence / "launcher-deaths.jsonl")
        environment["T3_REHEARSAL_VALIDATED_HOLD_MS"] = str(hold)
        environment["T3_REHEARSAL_IPC_RECEIPT"] = str(sandbox.evidence / "launcher-ipc.jsonl")
        environment.update(NODE_OPTIONS="--require=" + json.dumps(str(fault)), T3_REHEARSAL_FAULT="" if sandbox.args.inject == "none" else sandbox.args.inject, T3_REHEARSAL_FAULT_RECEIPT=str(sandbox.evidence / "fault-injected.json"))
    unit_path = sandbox.unit if sys.platform == "darwin" else sandbox.systemd_unit
    from .connector_artifact import identity

    text = render(sandbox.args.rpc_tree.resolve(), sandbox.home, unit_path, argv, log, environment, connector_unit=identity(connector_run(sandbox))[1])
    (sandbox.evidence / "rendered-main.unit").write_text(text)
    lines = []
    for key, value in environment.items():
        quote = "'" if "'" not in value else '"'
        if quote in value or any(char in value for char in "\n\r\x00"):
            raise ValueError("sandbox service environment cannot be encoded without changing its value")
        lines.append(f"{key}={quote}{value}{quote}")
    (sandbox.home / "service.env").write_text("\n".join(lines) + "\n")
    (sandbox.home / "service.env").chmod(0o600)
    sandbox.started = True
    if sandbox.args.launcher_artifact or sandbox.args.old_launcher_artifact or sandbox.args.connector_artifact:
        from .connector_artifact import ensure_connector

        ensure_connector(connector_run(sandbox, baseline=bool(sandbox.args.old_launcher_artifact)))
        connector_path = identity(connector_run(sandbox))[1]
        if connector_path.is_file():
            (sandbox.evidence / "rendered-connector.unit").write_bytes(connector_path.read_bytes())
    if sys.platform == "darwin":
        unit = plistlib.loads(text.encode())
        if unit["Label"] != sandbox.label:
            raise ValueError("production renderer did not honor the sandbox unitPath")
        if unit.get("ExitTimeOut") != 90:
            raise ValueError("production renderer does not provide ExitTimeOut 90")
        sandbox.unit.write_text(text)
        sandbox.unit.chmod(0o600)
        subprocess.run(["launchctl", "bootstrap", sandbox.domain, str(sandbox.unit)], check=True, timeout=60)
    else:
        if "KillMode=mixed" not in text or "TimeoutStopSec=90s" not in text:
            raise ValueError("production renderer lacks mixed kill mode / 90s stop timeout")
        sandbox.systemd_unit.parent.mkdir(parents=True, exist_ok=True)
        with sandbox.systemd_unit.open("x") as output:
            output.write(text)
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True, timeout=30)
        subprocess.run(["systemctl", "--user", "start", f"{sandbox.label}.service"], check=True, timeout=60)
    sandbox.unit_renderer = {"source": "apps/server/src/cloud/bootService.ts", "tree": str(sandbox.args.rpc_tree), "launcher": True, "stopSeconds": 90, "killMode": "mixed" if sys.platform == "linux" else None}


def serving_digest(sandbox):
    from .install_process import descends
    from .install_strays import port_listeners
    from .rehearsal_sandbox import sha256

    state = json.loads((sandbox.home / "userdata/server-runtime.json").read_text())
    pid = str(state["pid"])
    if sys.platform == "darwin":
        result = subprocess.run(["launchctl", "print", f"{sandbox.domain}/{sandbox.label}"], capture_output=True, text=True, check=True, timeout=10)
        roots = re.findall(r"^\s*pid = (\d+)\s*$", result.stdout, re.MULTILINE)
        files = subprocess.run(["lsof", "-a", "-p", pid, "-d", "txt", "-Fn"], capture_output=True, text=True, check=True, timeout=10)
        paths = [Path(line[1:]) for line in files.stdout.splitlines() if line.startswith("n") and Path(line[1:]).name == "t3"]
    else:
        result = subprocess.run(["systemctl", "--user", "show", "--property=MainPID", "--value", f"{sandbox.label}.service"], capture_output=True, text=True, check=True, timeout=10)
        roots = [result.stdout.strip()]
        paths = [Path(f"/proc/{pid}/exe").resolve()]
    processes = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True, check=True, timeout=10)
    parents = dict(line.split() for line in processes.stdout.splitlines() if len(line.split()) == 2)
    from .rehearsal_storage import owns

    if len(roots) != 1 or not descends(pid, roots[0], parents) or len(paths) != 1 or not owns(sandbox.home, paths[0]):
        raise ValueError("serving runtime is not a child of the sandbox launcher")
    if not any(descends(listener, roots[0], parents) for listener in port_listeners(sandbox.port)):
        raise ValueError("public port does not belong to the sandbox launcher")
    return sha256(paths[0])


def connector_run(sandbox, baseline=False):
    from types import SimpleNamespace

    from .install_policy import window

    args = SimpleNamespace(**vars(sandbox.args))
    args.version = sandbox.old.name
    if not getattr(sandbox, "artifact_admission", None):
        sandbox.artifact_admission = window(args.version, sandbox=True)
    if baseline:
        args.launcher_artifact = sandbox.args.old_launcher_artifact
        args.connector_artifact = ""
    return SimpleNamespace(args=args, home=sandbox.home, service_label=sandbox.label if sys.platform == "darwin" else sandbox.label + ".service", report={"installWindow": sandbox.artifact_admission}, cutover_admitted=True, step=lambda name, **fields: print(json.dumps({"step": name, **fields}), flush=True))


def pin_artifacts(sandbox):
    from .launcher_artifact import ensure_launcher

    for name in ("launcher_artifact", "old_launcher_artifact"):
        raw = getattr(sandbox.args, name)
        if not raw:
            continue
        artifact = json.loads(Path(raw).read_text())
        if artifact.get("ingress"):
            artifact["ingress"] = {**artifact["ingress"], "port": sandbox.port, "host": "127.0.0.1"}
        path = sandbox.evidence / f"sandbox-{name}.json"
        path.write_text(json.dumps(artifact) + "\n")
        setattr(sandbox.args, name, str(path))
    if sandbox.args.old_launcher_artifact:
        ensure_launcher(connector_run(sandbox, baseline=True), sandbox.old.name)
