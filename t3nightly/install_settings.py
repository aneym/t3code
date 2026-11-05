import fcntl
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import ExitStack, contextmanager, nullcontext
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


def atomic_write(path, data, mode, *, before_replace=None, after_replace=None):
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
        if after_replace is not None:
            after_replace()
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


class ServerRunning(ValueError):
    pass


def server_argv(argv, home):
    if len(argv) < 2 or Path(argv[0]).name != "t3" or argv[1] not in ("serve", "start"):
        return False
    if "--base-dir" in argv:
        return serves_home(["serve", *argv], home)
    executable = Path(argv[0])
    return executable.is_absolute() and executable.is_relative_to(home / "runtime")


@contextmanager
def stopped(home):
    home = Path(home).resolve()
    userdata = home / "userdata"
    with ExitStack() as stack:
        try:
            handle = stack.enter_context((userdata / "server-owner.sqlite").open("r+b"))
        except FileNotFoundError:
            handle = None
        if handle is not None:
            try:
                fcntl.lockf(handle, fcntl.LOCK_EX | fcntl.LOCK_NB, SQLITE_SHARED_SIZE, SQLITE_SHARED_FIRST)
            except BlockingIOError:
                raise ServerRunning("server settings unchanged: a server still owns this T3 home") from None
        try:
            processes = subprocess.run(["ps", "-ww", "-axo", "pid=,args="], capture_output=True, text=True, check=True, timeout=15)
            for line in processes.stdout.splitlines():
                fields = line.split(None, 1)
                if len(fields) == 2 and server_argv(fields[1].split(), home):
                    raise ServerRunning("server settings unchanged: a server process still uses this T3 home")
            runtime = userdata / "server-runtime.json"
            try:
                state = json_object(runtime.read_bytes(), "server-runtime.json")
            except (FileNotFoundError, ValueError):
                state = {}
            pid = str(state.get("pid", ""))
            if pid.isdigit() and server_argv(process_argv(pid), home):
                raise ServerRunning("server settings unchanged: the recorded server process has not exited")
            yield
        finally:
            if handle is not None:
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
        self.applied = False
        self.before, self.mode = read(self.path)
        if self.before is not None:
            json_object(self.before, "settings.json")
        self.evidence = {"keys": sorted(settings), "beforeSha256": sha256(self.before), "afterSha256": None, "mode": mode}

    def capture(self):
        if not self.captured:
            self.before, self.mode = read(self.path)
            if self.before is not None:
                json_object(self.before, "settings.json")
            self.captured = True

    def published(self, before, mode, after):
        if not self.applied:
            self.before, self.mode = before, mode
            self.evidence["beforeSha256"] = sha256(before)
        self.applied = True
        self.evidence["afterSha256"] = sha256(after)

    def merge(self, data):
        current = json_object(data, "settings.json") if data is not None else {}
        pins = security_pins(current) if self.sandbox else {}
        return {**current, **self.settings, **pins}

    def matches(self, data, merged):
        current = json_object(data, "settings.json") if data is not None else {}
        expected = {key: merged[key] for key in self.settings}
        actual = {key: current[key] for key in self.settings if key in current}
        return json.dumps(actual, sort_keys=True) == json.dumps(expected, sort_keys=True)

    def apply(self):
        self.capture()
        with stopped(self.home):
            data, mode = read(self.path)
            after = (json.dumps(self.merge(data), indent=2, allow_nan=False) + "\n").encode()
            atomic_write(self.path, after, mode, after_replace=lambda: self.published(data, mode, after))
        return self.evidence

    def apply_live(self):
        self.apply_mode = "live-after-swap"
        evidence = self.evidence
        evidence.update(mode=self.apply_mode, state="failed", check="file", attempts=[])
        for attempt in range(2):
            row = {}
            evidence["attempts"].append(row)
            try:
                data, mode = read(self.path)
                row["readSha256"] = sha256(data)
                if not self.applied:
                    self.before, self.mode = data, mode
                    evidence["beforeSha256"] = row["readSha256"]
                merged = self.merge(data)
                after = (json.dumps(merged, indent=2, allow_nan=False) + "\n").encode()

                def unchanged():
                    live, _ = read(self.path)
                    row["beforeRenameSha256"] = sha256(live)
                    return row["readSha256"] == row["beforeRenameSha256"]

                if not atomic_write(self.path, after, mode, before_replace=unchanged, after_replace=lambda: self.published(data, mode, after)):
                    row["result"] = "changed-before-rename"
                    continue
                row["checksSha256"] = []
                for check in range(2):
                    time.sleep(1)
                    live, _ = read(self.path)
                    row["checksSha256"].append(sha256(live))
                    if not self.matches(live, merged):
                        break
                else:
                    row["result"] = "confirmed"
                    evidence["state"] = "applied"
                    return evidence
                row["result"] = "lost-after-rename"
            except (OSError, ValueError) as error:
                row["result"] = type(error).__name__
        evidence["binaryRollback"] = False
        return evidence

    def restore(self):
        if not self.applied:
            return
        live_mode = self.apply_mode == "live-after-swap"
        with nullcontext() if live_mode else stopped(self.home):
            def unchanged():
                current = sha256(read(self.path)[0])
                self.evidence["restoreCurrentSha256"] = current
                return not live_mode or current == self.evidence["afterSha256"]

            if self.before is None:
                restored = unchanged()
                if restored:
                    self.path.unlink(missing_ok=True)
                    sync_directory(self.path.parent)
            else:
                restored = atomic_write(self.path, self.before, self.mode, before_replace=unchanged)
            self.evidence["restore"] = "restored" if restored else "restore-conflict"
            self.applied = False


def prepare(run, *, mode="stopped"):
    settings = load()
    run.settings_rollback = False
    run.server_settings = None if settings is None else SettingsChange(run.home, settings, sandbox=run.args.rehearsal, mode=mode)


def capture(run):
    if run.server_settings is not None:
        run.server_settings.capture()


def apply(run):
    if run.server_settings is not None:
        run.report["serverSettingsApplied"] = run.server_settings.evidence
        run.server_settings.apply()


def live_after_swap(run):
    if run.server_settings is None:
        return True
    evidence = run.report["serverSettingsApplied"] = run.server_settings.apply_live()
    if evidence["state"] == "failed":
        run.report["mcpEventsProof"] = "blocked-settings"
        run.step("server-settings-failed", binaryRollback=False, mcpEventsProof="blocked-settings")
        return False
    run.report.pop("mcpEventsProof", None)
    return True


def current(run):
    change = getattr(run, "server_settings", None)
    if change is not None:
        try:
            data, _ = read(change.path)
            reflected = change.matches(data, change.merge(data))
        except (OSError, ValueError):
            reflected = False
        if not reflected:
            live_after_swap(run)


def restore(run):
    change = getattr(run, "server_settings", None)
    if change is None or not change.applied:
        return
    evidence = run.report["serverSettingsApplied"] = change.evidence
    try:
        change.restore()
    except ServerRunning:
        evidence["restore"] = "skipped-server-running"
    except (OSError, ValueError, subprocess.SubprocessError):
        evidence["restore"] = "failed"
    if evidence.get("restore") != "restored":
        run.step("server-settings-restore", **evidence)


@contextmanager
def rollback(run):
    try:
        yield
    finally:
        restore(run)


def exit_code(run, outcome):
    return 0 if outcome in ("installed", "current") and run.report.get("mcpEventsProof") != "blocked-settings" else 1


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
