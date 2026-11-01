import json
import os
import re
import subprocess
import sys
from pathlib import Path

from .install_provenance import file_digest


def qualify(run):
    reasons = []
    if sys.platform == "darwin":
        if not run.service_plist.is_file():
            reasons.append("launchd service plist missing")
    elif sys.platform == "linux":
        result = subprocess.run(["systemctl", "--user", "show", run.service_label, "--property=LoadState", "--value"], capture_output=True, text=True, timeout=15)
        if result.returncode or result.stdout.strip() != "loaded":
            reasons.append("systemd-user service not loaded")
        if "microsoft" in Path("/proc/sys/kernel/osrelease").read_text().lower():
            linger = subprocess.run(["loginctl", "show-user", str(os.getuid()), "--property=Linger", "--value"], capture_output=True, text=True, timeout=15)
            if linger.returncode or linger.stdout.strip() != "yes":
                reasons.append("pc-wsl requires systemd-user and linger=yes")
    else:
        reasons.append("native Windows and desktop-bundled servers keep legacy update")
    return {"qualified": not reasons, "platform": sys.platform, "reasons": reasons}


def ingress_qualified(run):
    try:
        pin = json.loads((run.home / "runtime/launcher-pin.json").read_text())
        config = json.loads((run.home / "runtime/launcher-config.json").read_text())
        if pin.get("hotSwapProtocol") != 1 or config.get("protocol") != 1 or config.get("port") != run.args.port or config.get("drainTimeoutMs") != run.args.drain_s * 1000:
            return False
        if sys.platform == "darwin":
            result = subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{run.service_label}"], capture_output=True, text=True, check=True, timeout=10)
            roots = re.findall(r"^\s*pid = (\d+)\s*$", result.stdout, re.MULTILINE)
            if len(roots) != 1:
                return False
            files = subprocess.run(["lsof", "-a", "-p", roots[0], "-d", "txt", "-Fn"], capture_output=True, text=True, check=True, timeout=10)
            paths = [Path(line[1:]) for line in files.stdout.splitlines() if line.startswith("n") and Path(line[1:]).name == "t3"]
        elif sys.platform == "linux":
            root = subprocess.run(["systemctl", "--user", "show", run.service_label, "--property=MainPID", "--value"], capture_output=True, text=True, check=True, timeout=10).stdout.strip()
            paths = [Path(f"/proc/{int(root)}/exe")]
        else:
            return False
        return len(paths) == 1 and file_digest(paths[0]) == pin.get("sha256", pin.get("digest")) and qualify(run)["qualified"]
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return False
