import fcntl
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager, nullcontext
from pathlib import Path

from .install_strays import SQLITE_SHARED_FIRST, SQLITE_SHARED_SIZE, process_argv, serves_home


def invalid_constant(value):
    raise ValueError("non-finite JSON constant")


def json_object(data, source):
    try:
        value = json.loads(data, parse_constant=invalid_constant)
        json.dumps(value, allow_nan=False)
    except (ValueError, UnicodeError):
        raise ValueError(f"{source} must contain a JSON object") from None
    if not isinstance(value, dict):
        raise ValueError(f"{source} must contain a JSON object")
    return value


def load():
    path = Path.home() / ".t3nightly/install-settings.json"
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        if path.is_symlink():
            raise ValueError("install-settings.json is a dangling symlink; nothing stopped") from None
        return None
    return json_object(data, "install-settings.json")


def dry_run():
    settings = load()
    if settings is not None:
        print(json.dumps({"serverSettingsWouldApply": sorted(settings)}), flush=True)


def sha256(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def read(path):
    try:
        with path.open("rb") as handle:
            return handle.read(), stat.S_IMODE(os.fstat(handle.fileno()).st_mode)
    except FileNotFoundError:
        return None, 0o600


def atomic_write(path, data, mode, *, before_replace=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(raw)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fchmod(handle.fileno(), mode)
            os.fsync(handle.fileno())
        if before_replace is not None and not before_replace():
            return False
        os.replace(temporary, path)
        sync_directory(path.parent)
        return True
    finally:
        temporary.unlink(missing_ok=True)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def stopped(home):
    home = Path(home).resolve()
    userdata = home / "userdata"
    userdata.mkdir(parents=True, exist_ok=True)
    with (userdata / "server-owner.sqlite").open("a+b") as handle:
        try:
            fcntl.lockf(handle, fcntl.LOCK_EX | fcntl.LOCK_NB, SQLITE_SHARED_SIZE, SQLITE_SHARED_FIRST)
        except BlockingIOError:
            raise ValueError("server settings unchanged: a server still owns this T3 home") from None
        try:
            processes = subprocess.run(["ps", "-ww", "-axo", "pid=,args="], capture_output=True, text=True, check=True, timeout=15)
            for line in processes.stdout.splitlines():
                fields = line.split(None, 1)
                if len(fields) == 2 and serves_home(fields[1].split(), home):
                    raise ValueError("server settings unchanged: a server process still uses this T3 home")
            runtime = userdata / "server-runtime.json"
            if runtime.is_file():
                pid = str(json.loads(runtime.read_bytes()).get("pid", ""))
                if pid.isdigit() and process_argv(pid):
                    raise ValueError("server settings unchanged: the recorded server process has not exited")
            yield
        finally:
            fcntl.lockf(handle, fcntl.LOCK_UN, SQLITE_SHARED_SIZE, SQLITE_SHARED_FIRST)


def security_pins(settings):
    keys = ("cursorKeychainUsageEnabled", "providerInstances") if sys.platform == "darwin" else ("cursorKeychainUsageEnabled",)
    return {key: settings[key] for key in keys if key in settings}


def service_absent(run):
    if getattr(run, "server_settings", None) is None or sys.platform != "darwin":
        return False
    target = f"gui/{os.getuid()}/{run.service_label}"
    result = subprocess.run(["launchctl", "print", target], capture_output=True, text=True, timeout=15)
    return result.returncode != 0 and "Could not find service" in result.stderr


class SettingsChange:
    def __init__(self, home, settings, *, sandbox=False, mode="stopped"):
        self.home = Path(home)
        self.path = self.home / "userdata/settings.json"
        self.settings = settings
        self.sandbox = sandbox
        self.apply_mode = mode
        self.captured = False
        self.before, self.mode = read(self.path)
        if self.before is not None:
            json_object(self.before, "settings.json")

    def capture(self):
        if not self.captured:
            self.before, self.mode = read(self.path)
            if self.before is not None:
                json_object(self.before, "settings.json")
            self.captured = True

    def apply(self):
        self.capture()
        with stopped(self.home):
            data, mode = read(self.path)
            current = json_object(data, "settings.json") if data is not None else {}
            pins = security_pins(current) if self.sandbox else {}
            merged = {**current, **self.settings, **pins}
            after = (json.dumps(merged, indent=2, allow_nan=False) + "\n").encode()
            atomic_write(self.path, after, mode)
        return {"keys": sorted(self.settings), "beforeSha256": sha256(self.before), "afterSha256": sha256(after), "mode": "stopped"}

    def apply_live(self):
        self.capture()
        evidence = {"keys": sorted(self.settings), "beforeSha256": sha256(self.before), "afterSha256": None,
                    "mode": "live-after-swap", "state": "failed", "check": "file", "attempts": []}
        for attempt in range(2):
            row = {}
            evidence["attempts"].append(row)
            try:
                data, mode = read(self.path)
                row["readSha256"] = sha256(data)
                current = json_object(data, "settings.json") if data is not None else {}
                pins = security_pins(current) if self.sandbox else {}
                merged = {**current, **self.settings, **pins}
                after = (json.dumps(merged, indent=2, allow_nan=False) + "\n").encode()

                def unchanged():
                    live, _ = read(self.path)
                    row["beforeRenameSha256"] = sha256(live)
                    return row["readSha256"] == row["beforeRenameSha256"]

                if not atomic_write(self.path, after, mode, before_replace=unchanged):
                    row["result"] = "changed-before-rename"
                    continue
                time.sleep(0.3)
                live, _ = read(self.path)
                evidence["afterSha256"] = sha256(live)
                observed = json_object(live, "settings.json") if live is not None else {}
                expected = {key: merged[key] for key in self.settings}
                actual = {key: observed[key] for key in self.settings if key in observed}
                if json.dumps(actual, sort_keys=True) == json.dumps(expected, sort_keys=True):
                    row["result"] = "confirmed"
                    evidence["state"] = "applied"
                    return evidence
                row["result"] = "lost-after-rename"
            except (OSError, ValueError) as error:
                row["result"] = type(error).__name__
        try:
            evidence["afterSha256"] = sha256(read(self.path)[0])
        except OSError:
            pass
        evidence["binaryRollback"] = False
        return evidence

    def restore(self):
        if not self.captured:
            return
        with stopped(self.home) if self.apply_mode == "stopped" else nullcontext():
            if self.before is None:
                self.path.unlink(missing_ok=True)
                sync_directory(self.path.parent)
            else:
                atomic_write(self.path, self.before, self.mode)


def prepare(run, *, mode="stopped"):
    settings = load()
    run.settings_rollback = False
    run.server_settings = None if settings is None else SettingsChange(run.home, settings, sandbox=run.args.rehearsal, mode=mode)
    if mode == "live-after-swap":
        capture(run)


def capture(run):
    if run.server_settings is not None:
        run.server_settings.capture()


def apply(run):
    if run.server_settings is not None:
        run.report["serverSettingsApplied"] = run.server_settings.apply()


def live_after_swap(run):
    if run.server_settings is None:
        return True
    evidence = run.report["serverSettingsApplied"] = run.server_settings.apply_live()
    if evidence["state"] == "failed":
        run.report["mcpEventsProof"] = "blocked-settings"
        run.step("server-settings-failed", binaryRollback=False, mcpEventsProof="blocked-settings")
        return False
    return True


def restore(run):
    if getattr(run, "server_settings", None) is not None:
        run.server_settings.restore()


@contextmanager
def rollback(run):
    try:
        restore(run)
        yield
    finally:
        restore(run)


def result_line(run, line):
    if run.report.get("mcpEventsProof") == "blocked-settings":
        return line + "; settings failed; new binary kept, no binary rollback; MCP Events proof blocked-settings"
    return line


def receipt(run):
    return {key: run.report[key] for key in ("serverSettingsApplied", "mcpEventsProof") if key in run.report}


def sandbox_settings(path, pinned):
    settings = load()
    if settings is not None:
        change = SettingsChange(Path(path).parent.parent, {**settings, **security_pins(pinned)}, sandbox=True)
        change.apply()
        return json_object(Path(path).read_bytes(), "settings.json")
    return pinned
