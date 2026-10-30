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
    path = run.home / f"{label}.plist" if sys.platform == "darwin" else Path.home() / ".config/systemd/user" / f"{label}.service"
    return label, path


def ensure_connector(run):
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
    if pin.is_file() and json.loads(pin.read_text()).get("sha256") == artifact["sha256"]:
        run.step("connector-artifact-kept", digest=artifact["sha256"])
        return
    destination = run.home / "runtime/connectors" / artifact["sha256"]
    if not destination.exists():
        shutil.copytree(source, destination, symlinks=True)
    label, path = identity(run)
    environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "T3CODE_HOME": str(run.home)}
    if not run.args.rpc_tree:
        raise ValueError("connector unit installation requires --rpc-tree for production renderers")
    text = render(Path(run.args.rpc_tree).resolve(), run.home, path, [str(destination / "t3"), "__service-connector"], run.home / "userdata/logs/connector.log", environment, kind="connector")
    if sys.platform == "darwin":
        unit = plistlib.loads(text.encode())
        unit["Label"] = label
        unit["EnvironmentVariables"]["T3_BOOT_SERVICE_UNIT"] = label + ".plist"
        unit["EnvironmentVariables"].update(environment)
        data = plistlib.dumps(unit)
    else:
        data = text.replace("T3_BOOT_SERVICE_UNIT=t3code.service", f"T3_BOOT_SERVICE_UNIT={label}.service").encode()
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
    pin.write_text(json.dumps({**artifact, "unit": str(path), "label": label}) + "\n")
    pin.chmod(0o600)
    run.step("connector-artifact-pinned", service=label, digest=artifact["sha256"])


def control(run, action):
    from .install_policy import command_environment

    environment = command_environment(run)
    label, path = identity(run)
    if sys.platform == "darwin":
        command = ["launchctl", "bootout", "--wait", f"gui/{os.getuid()}/{label}"] if action == "stop" else ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)]
    else:
        subprocess.run(["systemctl", "--user", "daemon-reload"], env=environment, check=True, capture_output=True, timeout=30)
        command = ["systemctl", "--user", action, f"{label}.service"]
    subprocess.run(command, env=environment, check=True, capture_output=True, timeout=120)


def uninstall(run):
    label, path = identity(run)
    pin = run.home / "runtime/connector-pin.json"
    if not pin.is_file() or json.loads(pin.read_text()).get("unit") != str(path):
        raise ValueError("connector uninstall requires this home's owned pin receipt")
    control(run, "stop")
    path.unlink()
    pin.rename(pin.with_suffix(".uninstalled.json"))
    if sys.platform != "darwin":
        from .install_policy import command_environment

        subprocess.run(["systemctl", "--user", "daemon-reload"], env=command_environment(run), check=True, capture_output=True, timeout=30)
    run.step("connector-service-uninstalled", service=label, runtime_kept=True)
