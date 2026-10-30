import json
import os
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

from .install_provenance import file_digest
from .rehearsal_service import render
from .release_signatures import verify_cli


def identity(run):
    sandbox = run.service_label.startswith(("t3-rehearsal-", "com.t3-rehearsal."))
    label = run.service_label.removesuffix(".service") + "-connector" if sandbox else "com.t3tools.t3code-connector.service" if sys.platform == "darwin" else "t3code-connector"
    path = (run.home if sandbox else Path.home()) / "Library/LaunchAgents" / f"{label}.plist" if sys.platform == "darwin" else Path.home() / ".config/systemd/user" / f"{label}.service"
    return label, path


def ensure_connector(run):
    from .install_policy import recheck

    recheck(run)
    raw = getattr(run.args, "connector_artifact", "")
    launcher = getattr(run.args, "launcher_artifact", "")
    if not raw and not launcher:
        run.step("connector-artifact-kept", independently_pinned=(run.home / "runtime/connector-pin.json").is_file())
        return
    artifact = json.loads(Path(raw or launcher).read_text())
    if not raw:
        artifact = {**artifact, "schema": "t3nightly.connector-artifact/1", "protocol": 1}
    if artifact.get("schema") != "t3nightly.connector-artifact/1" or artifact.get("protocol") != 1:
        raise ValueError("separate connector artifact requires protocol 1")
    source = Path(artifact["runtimeDir"]).expanduser().resolve()
    verify_cli(source / "t3")
    if file_digest(source / "t3") != artifact["sha256"]:
        raise ValueError("connector artifact digest mismatch")
    pin = run.home / "runtime/connector-pin.json"
    destination = run.home / "runtime/connectors" / artifact["sha256"]
    if not destination.exists():
        from .rehearsal_storage import clone_tree, enabled, publish

        if enabled(run.home):
            clone_tree(publish(source), destination)
        else:
            shutil.copytree(source, destination, symlinks=True)
    label, path = identity(run)
    paths = [entry for entry in os.environ.get("PATH", "/usr/bin:/bin").split(os.pathsep) if not str(Path(entry).resolve()).startswith("/Volumes/")]
    environment = {"PATH": os.pathsep.join(paths), "T3CODE_HOME": str(run.home)}
    if run.service_label.startswith(("t3-rehearsal-", "com.t3-rehearsal.")):
        environment["HOME"] = str(run.home)
    if not run.args.rpc_tree:
        raise ValueError("connector unit installation requires --rpc-tree for production renderers")
    text = render(Path(run.args.rpc_tree).resolve(), run.home, path, [str(destination / "t3"), "__service-connector"], run.home / "userdata/logs/connector.log", environment, kind="connector")
    if sys.platform == "darwin":
        unit = plistlib.loads(text.encode())
        if unit["Label"] != label:
            raise ValueError("production renderer did not honor the connector unitPath")
        data = text.encode()
    else:
        data = text.encode()
    pin.write_text(json.dumps({**artifact, "unit": str(path), "label": label}) + "\n")
    pin.chmod(0o600)
    if path.exists() and path.read_bytes() == data:
        run.step("connector-service-kept", service=label)
    else:
        if path.exists():
            control(run, "stop")
        path.parent.mkdir(parents=True, exist_ok=True)
        staged = path.with_suffix(".next")
        staged.write_bytes(data)
        staged.chmod(0o600)
        os.replace(staged, path)
    control(run, "start")
    run.step("connector-artifact-pinned", service=label, digest=artifact["sha256"])


def control(run, action):
    from .install_policy import command_environment

    environment = command_environment(run)
    label, path = identity(run)
    if sys.platform == "darwin":
        target = f"gui/{os.getuid()}/{label}"
        if action == "stop":
            inspection = subprocess.run(["launchctl", "print", target], capture_output=True, text=True, timeout=15)
            if inspection.returncode:
                if "Could not find service" in inspection.stderr:
                    return
                raise ValueError("cannot inspect connector launch agent")
            command = ["launchctl", "bootout", "--wait", target]
        else:
            subprocess.run(["launchctl", "enable", target], env=environment, check=True, capture_output=True, timeout=30)
            inspection = subprocess.run(["launchctl", "print", target], capture_output=True, timeout=15)
            if inspection.returncode == 0:
                return
            command = ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)]
    else:
        subprocess.run(["systemctl", "--user", "daemon-reload"], env=environment, check=True, capture_output=True, timeout=30)
        if action == "stop":
            inspection = subprocess.run(["systemctl", "--user", "show", f"{label}.service", "--property=LoadState", "--value"], capture_output=True, text=True, timeout=15)
            if inspection.returncode == 0 and inspection.stdout.strip() == "not-found":
                return
        else:
            subprocess.run(["systemctl", "--user", "enable", f"{label}.service"], env=environment, check=True, capture_output=True, timeout=30)
        command = ["systemctl", "--user", action, f"{label}.service"]
    subprocess.run(command, env=environment, check=True, capture_output=True, timeout=120)


def uninstall(run):
    from .install_policy import command_environment, recheck

    recheck(run)
    label, path = identity(run)
    pin = run.home / "runtime/connector-pin.json"
    if not pin.is_file() or json.loads(pin.read_text()).get("unit") != str(path):
        raise ValueError("connector uninstall requires this home's owned pin receipt")
    control(run, "stop")
    if sys.platform != "darwin" and path.exists():
        subprocess.run(["systemctl", "--user", "disable", f"{label}.service"], env=command_environment(run), check=True, capture_output=True, timeout=30)
    path.unlink(missing_ok=True)
    pin.rename(pin.with_suffix(".uninstalled.json"))
    if sys.platform != "darwin":
        from .install_policy import command_environment

        subprocess.run(["systemctl", "--user", "daemon-reload"], env=command_environment(run), check=True, capture_output=True, timeout=30)
    run.step("connector-service-uninstalled", service=label, runtime_kept=True)
