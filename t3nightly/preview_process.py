import os
import subprocess
import sys
import time
from pathlib import Path

from .headless_env import pin_settings, provider_env
from .preview_identity import process_start, stop_recorded
from .preview_output import shared_origin


def command_env():
    return {key: value for key, value in os.environ.items() if not key.startswith(("T3CODE_", "T3_", "VITE_"))}


def log_tail(log):
    with log.open("rb") as handle:
        handle.seek(max(0, log.stat().st_size - 4000))
        return handle.read().decode("utf-8", errors="replace")


def run_command(worktree, log, words, timeout=240):
    with log.open("a", encoding="utf-8") as handle:
        handle.write("$ %s\n" % " ".join(words))
    proc = subprocess.Popen(words, cwd=str(worktree), env=command_env(), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    redactor = None
    try:
        redactor = detached_redactor(proc.stdout, log, "-", worktree)
        try:
            code = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            raise RuntimeError("command timed out: %s" % " ".join(words)) from None
    except BaseException:
        try:
            os.killpg(proc.pid, 15)
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, 9)
            proc.wait(timeout=5)
        except ProcessLookupError:
            pass
        raise
    finally:
        if proc.stdout:
            proc.stdout.close()
        if redactor:
            redactor.wait(timeout=10)
    if code:
        raise RuntimeError("command failed with exit %d: %s\n%s" % (code, " ".join(words), log_tail(log)))


def wait_setup(worktree, log, timeout=240):
    marker = worktree / ".t3" / "setup-running"
    done = worktree / ".t3" / "setup-done"
    failed = worktree / ".t3" / "setup-failed"
    deadline = time.monotonic() + timeout
    while True:
        if failed.exists():
            raise RuntimeError("worktree setup failed; inspect .t3/setup-failed")
        if not marker.exists():
            if done.exists():
                return
            run_command(worktree, log, ["vp", "i"], timeout=max(1, deadline - time.monotonic()))
            if failed.exists():
                raise RuntimeError("worktree setup failed; inspect .t3/setup-failed")
            return
        if time.monotonic() >= deadline:
            raise RuntimeError("setup-running did not finish within %ds" % timeout)
        try:
            pid = int(marker.read_text().strip())
        except FileNotFoundError:
            continue
        except (OSError, ValueError) as exc:
            raise RuntimeError("cannot read setup-running") from exc
        if pid <= 0:
            raise RuntimeError("setup-running does not name a positive PID")
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            if failed.exists():
                raise RuntimeError("worktree setup failed; inspect .t3/setup-failed") from None
            if not marker.exists():
                continue
            raise RuntimeError("setup-running names a dead PID") from None
        time.sleep(0.5)


def require_sandbox_data(worktree):
    home = worktree / ".t3"
    for path in (home, home / "userdata", home / "userdata" / "statev2.sqlite"):
        if path.is_symlink():
            raise ValueError("preview data paths must not be symlinks")
    if not (home / "userdata" / "statev2.sqlite").is_file():
        raise ValueError("preview requires an existing isolated .t3/userdata/statev2.sqlite snapshot")


def detached_redactor(source, log, pairing_path, worktree):
    package_root = str(Path(__file__).resolve().parent.parent)
    env = command_env()
    env["PYTHONPATH"] = package_root
    proc = subprocess.Popen([sys.executable, "-m", "t3nightly.preview_output", str(log), str(pairing_path)],
                            cwd=str(worktree), env=env, stdin=source, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, start_new_session=True)
    return proc


def start_server(worktree, log, pairing_path, record_process, timeout=240):
    pairing_path.unlink(missing_ok=True)
    with log.open("w", encoding="utf-8"):
        os.chmod(log, 0o600)
    reader, writer = os.pipe()
    redactor = None
    proc = None
    process_started = None
    pgid = None
    try:
        redactor = detached_redactor(reader, log, pairing_path, worktree)
        os.close(reader)
        reader = None
        provider = worktree / ".t3" / "provider"
        pin_settings(worktree / ".t3" / "userdata" / "settings.json", provider, provider / "security-refusals.log")
        proc = subprocess.Popen(["vp", "run", "dev", "--share", "--home-dir", str(worktree / ".t3")],
                                cwd=str(worktree), env=dict(command_env(), **provider_env(provider)),
                                stdin=subprocess.DEVNULL, stdout=writer, stderr=subprocess.STDOUT, start_new_session=True)
        os.close(writer)
        writer = None
        try:
            process_started = process_start(proc.pid)
            pgid = os.getpgid(proc.pid)
        except ProcessLookupError:
            code = proc.poll()
            redactor.wait(timeout=5)
            raise RuntimeError("preview exited with code %s\n%s" % (code, log_tail(log))) from None
        record_process(proc, process_started, pgid)
        port_seen = False
        origin = None
        deadline = time.monotonic() + timeout
        with log.open(encoding="utf-8") as handle:
            while time.monotonic() < deadline:
                code = proc.poll()
                if code is not None:
                    redactor.wait(timeout=10)
                    raise RuntimeError("preview exited with code %d\n%s" % (code, log_tail(log)))
                if redactor.poll() is not None:
                    raise RuntimeError("preview log redactor exited with code %d" % redactor.returncode)
                for line in handle:
                    if "could not share on the tailnet" in line:
                        raise RuntimeError("preview tailnet sharing failed\n%s" % log_tail(log))
                    if "[dev-runner]" in line and "serverPort=" in line and "webPort=" in line:
                        port_seen = True
                    origin = shared_origin(line) or origin
                if port_seen and origin and pairing_path.exists():
                    return proc, process_started, pgid, origin
                time.sleep(0.2)
        raise RuntimeError("preview did not become ready within %ds\n%s" % (timeout, log_tail(log)))
    except BaseException:
        if proc:
            try:
                if process_started and pgid:
                    stop_recorded(proc.pid, pgid, process_started, worktree)
                elif proc.poll() is None:
                    proc.terminate()
                proc.wait(timeout=20)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                pass
        pairing_path.unlink(missing_ok=True)
        raise
    finally:
        for fd in (reader, writer):
            if fd is not None:
                os.close(fd)
