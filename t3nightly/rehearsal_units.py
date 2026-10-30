import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


def unload(home, label):
    home = Path(home).resolve()
    if not re.fullmatch(r"(?:com\.)?t3-rehearsal[.-][A-Za-z0-9_.-]+", label):
        raise ValueError("refused teardown of non-rehearsal unit")
    if home.name != "home" or not home.parent.name.startswith("rehearsal-") or home.is_relative_to(Path.home() / ".t3"):
        raise ValueError("refused teardown outside an isolated rehearsal home")
    if sys.platform == "darwin":
        target = f"gui/{os.getuid()}/{label}"
        inspection = subprocess.run(["launchctl", "print", target], capture_output=True, text=True, timeout=15)
        if inspection.returncode == 0:
            subprocess.run(["launchctl", "bootout", "--wait", target], capture_output=True, check=True, timeout=120)
        elif "Could not find service" not in inspection.stderr:
            raise ValueError("cannot inspect recorded sandbox launch agent")
        for unit in (home / f"{label}.plist", home / "Library/LaunchAgents" / f"{label}.plist"):
            unit.unlink(missing_ok=True)
        return
    unit = Path.home() / ".config/systemd/user" / f"{label}.service"
    subprocess.run(["systemctl", "--user", "stop", unit.name], capture_output=True, timeout=120)
    if unit.exists():
        subprocess.run(["systemctl", "--user", "disable", unit.name], capture_output=True, check=True, timeout=30)
    unit.unlink(missing_ok=True)
    dropin = unit.with_suffix(".service.d")
    if dropin.is_dir() and not dropin.is_symlink():
        shutil.rmtree(dropin)
    subprocess.run(["systemctl", "--user", "reset-failed", unit.name], capture_output=True, timeout=30)
    subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True, check=True, timeout=30)
