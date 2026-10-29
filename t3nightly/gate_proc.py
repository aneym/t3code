import os
import re
import signal
import subprocess
import time
from pathlib import Path

SECRET = re.compile(
    r'(token=|Token: |"token":\s*"|"access_token":\s*"|wsTicket=|Bearer )[^\s"&]+'
)


class CheckFailed(Exception):
    pass


class Deadline:
    def __init__(self, seconds):
        self.end = time.monotonic() + seconds

    def left(self, cap=None):
        remaining = self.end - time.monotonic()
        if remaining <= 0:
            raise CheckFailed("check ran out of time")
        return remaining if cap is None else min(cap, remaining)


def clean_env(extra=None):
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("T3CODE_", "T3_", "VITE_"))
    }
    env["T3CODE_TELEMETRY_ENABLED"] = "false"
    env.update(extra or {})
    return env


def stop_group(proc, grace=15):
    if proc.poll() is not None:
        return True
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 5)):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            return True
        try:
            proc.wait(timeout=wait)
            return True
        except subprocess.TimeoutExpired:
            continue
    return proc.poll() is not None


def run(cmd, log, deadline, cap=None, cwd=None, env=None, secret_out=None):
    timeout = deadline.left(cap)
    with open(log, "ab") as handle:
        handle.write(("$ %s\n" % " ".join(cmd)).encode())
        handle.flush()
        secret = (
            open(
                secret_out, "wb", opener=lambda path, flags: os.open(path, flags, 0o600)
            )
            if secret_out
            else None
        )
        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=secret or subprocess.PIPE,
                stderr=handle,
                cwd=cwd,
                env=env or clean_env(),
                start_new_session=True,
            )
            try:
                stdout, _ = proc.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                stop_group(proc, grace=5)
                raise CheckFailed(
                    "%s timed out after %ds"
                    % (
                        Path(cmd[1] if cmd[0].endswith("node") else cmd[0]).name,
                        timeout,
                    )
                )
        finally:
            if secret is not None:
                secret.close()
        text = (stdout or b"").decode(errors="replace")
        handle.write(text.encode())
        handle.write(("[exit %d]\n" % proc.returncode).encode())
    return proc.returncode, text


def spawn(cmd, log, cwd=None, env=None):
    handle = open(log, "ab")
    handle.write(("$ %s\n" % " ".join(cmd)).encode())
    handle.flush()
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=handle,
        stderr=subprocess.STDOUT,
        cwd=cwd,
        env=env or clean_env(),
        start_new_session=True,
    )
    handle.close()
    return proc


def redact_tree(root):
    for path in Path(root).rglob("*"):
        if path.is_file():
            text = path.read_text(errors="replace")
            cleaned = SECRET.sub(r"\1REDACTED", text)
            if cleaned != text:
                path.write_text(cleaned)
