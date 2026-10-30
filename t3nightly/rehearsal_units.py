import os
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


def record(sandbox):
    from .connector_artifact import identity
    from .rehearsal_service import connector_run

    connector_label, connector_path = identity(connector_run(sandbox))
    unit = sandbox.unit if sys.platform == "darwin" else sandbox.systemd_unit
    return {"home": str(sandbox.home), "label": sandbox.label, "port": sandbox.port, "units": {sandbox.label: str(unit), connector_label: str(connector_path)}}


def unload(home, label):
    home = Path(home).resolve()
    if not re.fullmatch(r"(?:com\.)?t3-rehearsal[.-][A-Za-z0-9_.-]+", label):
        raise ValueError("refused teardown of non-rehearsal unit")
    recorded = home / ".rehearsal-unit.json"
    if not recorded.is_file():
        recorded = home.parent / "rehearsal-target.json"
    if recorded.is_symlink():
        raise ValueError("refused symlinked sandbox identity")
    target = json.loads(recorded.read_text())
    main = target["label"]
    if Path(target["home"]).resolve() != home or label not in (main, main + "-connector") or home.is_relative_to(Path.home() / ".t3"):
        raise ValueError("refused teardown of an unrecorded sandbox unit")
    units = target.get("units")
    if units is not None and label not in units:
        raise ValueError("unit is absent from the sandbox identity receipt")
    if units is None:
        units = {}
        if label != main:
            pin = json.loads((home / "runtime/connector-pin.json").read_text())
            if pin.get("label") != label:
                raise ValueError("connector identity was not recorded by this sandbox")
            units[label] = pin["unit"]
    expected = home / f"{label}.plist" if sys.platform == "darwin" else Path.home() / ".config/systemd/user" / f"{label}.service"
    if sys.platform == "darwin" and label == main + "-connector":
        expected = home / "Library/LaunchAgents" / f"{label}.plist"
    unit = Path(units.get(label, str(expected)))
    if unit != expected:
        raise ValueError("recorded sandbox unit path drifted")
    if sys.platform == "darwin":
        target = f"gui/{os.getuid()}/{label}"
        inspection = subprocess.run(["launchctl", "print", target], capture_output=True, text=True, timeout=15)
        if inspection.returncode == 0:
            subprocess.run(["launchctl", "bootout", "--wait", target], capture_output=True, check=True, timeout=120)
        elif "Could not find service" not in inspection.stderr:
            raise ValueError("cannot inspect recorded sandbox launch agent")
        unit.unlink(missing_ok=True)
        return
    subprocess.run(["systemctl", "--user", "stop", unit.name], capture_output=True, timeout=120)
    if unit.exists():
        subprocess.run(["systemctl", "--user", "disable", unit.name], capture_output=True, check=True, timeout=30)
    unit.unlink(missing_ok=True)
    dropin = unit.with_suffix(".service.d")
    if dropin.is_dir() and not dropin.is_symlink():
        shutil.rmtree(dropin)
    subprocess.run(["systemctl", "--user", "reset-failed", unit.name], capture_output=True, timeout=30)
    subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True, check=True, timeout=30)
    inspection = subprocess.run(["systemctl", "--user", "show", unit.name, "--property=LoadState", "--value"], capture_output=True, text=True, timeout=15)
    if inspection.returncode or inspection.stdout.strip() != "not-found":
        raise ValueError("recorded rehearsal unit remained loaded after teardown")
