import json
import os
import shutil
import sys
import uuid
from pathlib import Path

from .install_provenance import file_digest
from .install_runtime import activate
from .release_signatures import verify_cli


def ensure_launcher(run, version, *, update_config=True):
    runtime = run.home / "runtime"
    target = runtime / "launcher"
    pin = runtime / "launcher-pin.json"
    validate_drain_pin(run)
    raw = getattr(run.args, "launcher_artifact", "")
    if not update_config and (not target.is_dir() or changed(run)):
        raise ValueError("launcher change requires a stopped service window")
    if raw and target.is_dir() and not changed(run):
        raw = ""
    if target.is_dir() and (not raw or getattr(run, "launcher_applied", False)):
        verify_cli(target / "t3")
        if pin.exists():
            previous = json.loads(pin.read_text())
            if previous.get("sha256", previous.get("digest")) != file_digest(target / "t3"):
                raise ValueError("pinned launcher bytes drifted; explicit launcher artifact repair required")
        if not pin.exists():
            atomic_text(pin, json.dumps({"protocol": 3, "digest": file_digest(target / "t3"), "source": "adopted-existing", "lastKnownGood": str(target)}) + "\n")
        config_path = runtime / "launcher-config.json"
        if update_config and config_path.is_file():
            validate_drain_pin(run)
            config = json.loads(config_path.read_text())
            desired = run.args.drain_s * 1000
            if config.get("drainTimeoutMs") != desired:
                if not hasattr(run, "launcher_previous_config"):
                    run.launcher_previous_config = config_path.read_text()
                atomic_text(config_path, json.dumps({**config, "drainTimeoutMs": desired}) + "\n")
                run.step("launcher-drain-pin-updated", drainTimeoutMs=desired)
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
    from .rehearsal_storage import clone_tree, enabled, publish

    if enabled(run.home):
        clone_tree(publish(source), staged)
    else:
        shutil.copytree(source, staged, symlinks=True)
    run.launcher_previous_pin = pin.read_text() if pin.exists() else None
    config_path = runtime / "launcher-config.json"
    run.launcher_previous_config = config_path.read_text() if config_path.exists() else None
    backup = activate(staged, target)
    run.launcher_applied = True
    run.launcher_lkg = backup
    value = {**manifest, "lastKnownGood": str(backup) if backup else None, "version": manifest.get("version", manifest["sha256"])}
    atomic_text(pin, json.dumps(value) + "\n")
    pin.chmod(0o600)
    if manifest.get("hotSwapProtocol") == 1:
        atomic_text(config_path, json.dumps({**ingress, "measuredStartupMs": ingress["holdBudgetMs"] // 2, "drainTimeoutMs": run.args.drain_s * 1000}) + "\n")
        config_path.chmod(0o600)
    run.step("launcher-artifact-pinned", protocol=manifest["protocol"], digest=manifest["sha256"], last_known_good=str(backup) if backup else None)
    return target / "t3"


def rollback_launcher(run):
    backup = getattr(run, "launcher_lkg", None)
    if backup is None:
        previous = getattr(run, "launcher_previous_config", None)
        if previous is not None:
            atomic_text(run.home / "runtime/launcher-config.json", previous)
        return
    target = run.home / "runtime/launcher"
    failed = target.with_name(".launcher-watchdog-failed-" + uuid.uuid4().hex)
    os.replace(target, failed)
    try:
        os.replace(backup, target)
    except OSError:
        os.replace(failed, target)
        raise
    pin = run.home / "runtime/launcher-pin.json"
    previous = getattr(run, "launcher_previous_pin", None)
    pin.write_text(previous or json.dumps({"protocol": 3, "digest": file_digest(target / "t3"), "source": "watchdog-last-known-good", "lastKnownGood": str(target)}) + "\n")
    config = run.home / "runtime/launcher-config.json"
    old_config = getattr(run, "launcher_previous_config", None)
    if old_config is not None:
        config.write_text(old_config)
    elif config.exists():
        config.rename(config.with_name(".launcher-config-watchdog-failed-" + uuid.uuid4().hex + ".json"))
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
        expected = {**manifest["ingress"], "measuredStartupMs": manifest["ingress"]["holdBudgetMs"] // 2, "drainTimeoutMs": run.args.drain_s * 1000}
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
    from .install_policy import begin_recovery

    begin_recovery(run)
    service(run, "stop")
    try:
        rollback_launcher(run)
    finally:
        service(run, "start")
    deadline = time.monotonic() + run.args.health_s
    while time.monotonic() < deadline:
        if run.server_version() == version:
            run.step("launcher-watchdog-recovered", version=version, database_preserved=True)
            raise ValueError("new launcher failed health; last-known-good launcher restored with current database")
        time.sleep(0.25)
    raise ValueError("launcher watchdog could not recover; current database and last-known-good bytes preserved")


def atomic_text(path, text):
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(text)
        temporary.chmod(0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def validate_drain_pin(run):
    if not 0 <= run.args.drain_s <= 300:
        raise ValueError("unsupported drain deadline")
    path = run.home / "runtime/launcher-config.json"
    if path.exists() and not isinstance(json.loads(path.read_text()), dict):
        raise ValueError("launcher config must be an object")
    pin = run.home / "runtime/launcher-pin.json"
    binary = run.home / "runtime/launcher/t3"
    if pin.exists() and not changed(run):
        value = json.loads(pin.read_text())
        if not isinstance(value, dict) or value.get("sha256", value.get("digest")) != file_digest(binary):
            raise ValueError("pinned launcher bytes drifted before install")
