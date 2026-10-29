import os
import subprocess
import sys
import time
from pathlib import Path


FEED = "https://studio.tailf266ac.ts.net:8972"
FEED_SETTLE_S = 30


def persist_release_feed(args, version):
    if sys.platform == "darwin":
        return
    path = Path(args.service_env).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    values = []
    if path.is_file():
        values = [line for line in path.read_text().splitlines() if not line.startswith("T3CODE_RELEASE_BASE_URL=")]
    if ".aneym." in version:
        values.append(f"T3CODE_RELEASE_BASE_URL={FEED}")
    temp = path.with_name(f".{path.name}.next")
    temp.write_text("\n".join(values) + ("\n" if values else ""))
    os.chmod(temp, 0o600)
    os.replace(temp, path)
    dropin = Path(args.systemd_dropin).expanduser()
    dropin.mkdir(parents=True, exist_ok=True)
    release = dropin / "release-feed.conf"
    release.write_text("[Service]\nEnvironmentFile=-%s\n" % path)
    os.chmod(release, 0o600)
    if not args.dry_run:
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True, timeout=120)


def service_feed():
    result = subprocess.run(["systemctl", "--user", "show", "--property=MainPID", "--value", "t3code.service"], capture_output=True, text=True, check=True, timeout=120)
    pid = int(result.stdout.strip())
    if pid <= 0:
        return None
    try:
        environ = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    except OSError:
        return None
    return [entry for entry in environ if entry.startswith(b"T3CODE_RELEASE_BASE_URL=")]


def verify_release_feed(args, version):
    if sys.platform == "darwin" or args.dry_run:
        return
    expected = [f"T3CODE_RELEASE_BASE_URL={FEED}".encode()] if ".aneym." in version else []
    deadline = time.monotonic() + FEED_SETTLE_S
    while True:
        values = service_feed()
        if values == expected:
            return
        if time.monotonic() >= deadline:
            break
        time.sleep(0.5)
    if values is None:
        raise ValueError("service has no readable main process after restart")
    raise ValueError("service release feed environment does not match its version after restart")
