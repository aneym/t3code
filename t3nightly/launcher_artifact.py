import json
import os
import shutil
import subprocess
import sys
import re
from pathlib import Path

from .install_provenance import file_digest
from .install_runtime import activate
from .release_signatures import verify_cli


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


def ensure_launcher(run, version):
    runtime = run.home / "runtime"
    target = runtime / "launcher"
    pin = runtime / "launcher-pin.json"
    raw = getattr(run.args, "launcher_artifact", "")
    if raw and target.is_dir() and not changed(run):
        raw = ""
    if target.is_dir() and (not raw or getattr(run, "launcher_applied", False)):
        verify_cli(target / "t3")
        if pin.exists():
            previous = json.loads(pin.read_text())
            if previous.get("sha256", previous.get("digest")) != file_digest(target / "t3"):
                raise ValueError("pinned launcher bytes drifted; explicit launcher artifact repair required")
        if not pin.exists():
            pin.write_text(json.dumps({"protocol": 3, "digest": file_digest(target / "t3"), "source": "adopted-existing", "lastKnownGood": str(target)}) + "\n")
        run.step("launcher-kept", digest=file_digest(target / "t3"))
        return target / "t3"
    if not raw:
        raise ValueError("launcher bootstrap/change requires a separate --launcher-artifact; server updates never replace launcher bytes")
    manifest = json.loads(Path(raw).read_text())
    source = Path(manifest["runtimeDir"]).expanduser().resolve()
    if manifest.get("schema") != "t3nightly.launcher-artifact/1" or manifest.get("protocol") != 3:
        raise ValueError("launcher artifact requires schema, supported protocol 3 and exact runtime digest")
    verify_cli(source / "t3")
    if file_digest(source / "t3") != manifest["sha256"]:
        raise ValueError("launcher artifact bytes do not match its pin")
    ingress = manifest.get("ingress")
    if manifest.get("hotSwapProtocol") == 1:
        if not isinstance(ingress, dict) or ingress.get("protocol") != 1 or ingress.get("port") != run.args.port or ingress.get("manager") != ("launchd" if sys.platform == "darwin" else "systemd") or not 0 < ingress.get("measuredStartupMs", 0) < ingress.get("holdBudgetMs", 0) <= 300000 or not 1 <= ingress.get("maxQueued", 0) <= 8192 or not 1 <= ingress.get("maxTransfers", 0) <= 256 or not 0 <= run.args.drain_s <= 300:
            raise ValueError("launcher ingress requires matching endpoint/manager and measured bounded startup/queue budgets")
    staged = runtime / ".launcher-artifact-next"
    if staged.exists():
        raise ValueError("unfinished launcher artifact staging exists")
    shutil.copytree(source, staged, symlinks=True)
    run.launcher_previous_pin = pin.read_text() if pin.exists() else None
    config_path = runtime / "launcher-config.json"
    run.launcher_previous_config = config_path.read_text() if config_path.exists() else None
    backup = activate(staged, target)
    run.launcher_applied = True
    run.launcher_lkg = backup
    value = {**manifest, "lastKnownGood": str(backup) if backup else None, "version": manifest.get("version", manifest["sha256"])}
    pin.write_text(json.dumps(value) + "\n")
    pin.chmod(0o600)
    if manifest.get("hotSwapProtocol") == 1:
        config_path.write_text(json.dumps({**ingress, "drainTimeoutMs": run.args.drain_s * 1000}) + "\n")
        config_path.chmod(0o600)
    run.step("launcher-artifact-pinned", protocol=manifest["protocol"], digest=manifest["sha256"], last_known_good=str(backup) if backup else None)
    return target / "t3"


def rollback_launcher(run):
    backup = getattr(run, "launcher_lkg", None)
    if backup is None:
        return
    target = run.home / "runtime/launcher"
    failed = target.with_name(".launcher-watchdog-failed")
    if failed.exists():
        raise ValueError("launcher watchdog evidence already exists")
    os.replace(target, failed)
    os.replace(backup, target)
    pin = run.home / "runtime/launcher-pin.json"
    previous = getattr(run, "launcher_previous_pin", None)
    pin.write_text(previous or json.dumps({"protocol": 3, "digest": file_digest(target / "t3"), "source": "watchdog-last-known-good", "lastKnownGood": str(target)}) + "\n")
    config = run.home / "runtime/launcher-config.json"
    old_config = getattr(run, "launcher_previous_config", None)
    if old_config is not None:
        config.write_text(old_config)
    elif config.exists():
        config.rename(config.with_suffix(".watchdog-failed.json"))
    run.step("launcher-watchdog-rollback", digest=file_digest(target / "t3"), failed=str(failed))
    run.launcher_lkg = None


def changed(run):
    raw = getattr(run.args, "launcher_artifact", "")
    current = run.home / "runtime/launcher/t3"
    if not raw:
        return False
    manifest = json.loads(Path(raw).read_text())
    if not current.is_file() or manifest.get("sha256") != file_digest(current):
        return True
    pin = run.home / "runtime/launcher-pin.json"
    previous = json.loads(pin.read_text()) if pin.exists() else {"protocol": 3}
    if previous.get("protocol") != manifest.get("protocol") or previous.get("hotSwapProtocol") != manifest.get("hotSwapProtocol"):
        return True
    if manifest.get("hotSwapProtocol") == 1:
        config = run.home / "runtime/launcher-config.json"
        expected = {**manifest["ingress"], "drainTimeoutMs": run.args.drain_s * 1000}
        return not config.is_file() or json.loads(config.read_text()) != expected
    return False


def watchdog(run, version):
    import time
    from .install_hard import service

    if getattr(run, "launcher_lkg", None) is None:
        return
    deadline = time.monotonic() + run.args.health_s
    while time.monotonic() < deadline:
        if run.server_version() == version:
            run.step("launcher-watchdog-passed", version=version)
            return
        time.sleep(0.25)
    service(run, "stop")
    rollback_launcher(run)
    service(run, "start")
    deadline = time.monotonic() + run.args.health_s
    while time.monotonic() < deadline:
        if run.server_version() == version:
            run.step("launcher-watchdog-recovered", version=version, database_preserved=True)
            raise ValueError("new launcher failed health; last-known-good launcher restored with current database")
        time.sleep(0.25)
    raise ValueError("launcher watchdog could not recover; current database and last-known-good bytes preserved")
