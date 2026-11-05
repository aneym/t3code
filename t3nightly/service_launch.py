import json
import os
import plistlib
import subprocess
import sys
import uuid
from pathlib import Path

from .install_policy import command_environment
from .install_process import service_binary
from .install_provenance import file_digest


def capture(run):
    if sys.platform == "darwin":
        path = run.service_plist
        content = path.read_bytes()
        launcher = plistlib.loads(content)["ProgramArguments"][0]
    else:
        launcher = str(service_binary(run))
        path = Path(run.args.systemd_dropin).expanduser() / "20-hard-runtime.conf"
        try:
            content = path.read_bytes()
        except FileNotFoundError:
            content = None
    saved = {"target": launcher, "path": str(path), "bytesHex": content.hex() if content is not None else None}
    record = run.state / f"service-launch-{uuid.uuid4().hex}.json"
    with os.fdopen(os.open(record, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as handle:
        handle.write(json.dumps(saved) + "\n")
    run.service_launch = saved
    run.report["serviceLaunch"] = {"path": str(record), "sha256": file_digest(record)}
    run.step("service-launch-captured", **run.report["serviceLaunch"])


def reload(run):
    if sys.platform != "darwin":
        subprocess.run(["systemctl", "--user", "daemon-reload"], env=command_environment(run), check=True, capture_output=True, timeout=30)


def verify_restored(run):
    expected = Path(run.service_launch["target"])
    observed = service_binary(run)
    if observed != expected or not expected.is_file():
        raise ValueError(f"restored service launch target mismatch or missing: expected {expected}, observed {observed}; refusing start")
    return expected


def restore(run):
    saved = run.service_launch
    path = Path(saved["path"])
    content = saved["bytesHex"]
    if content is None:
        path.unlink(missing_ok=True)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        staged = path.with_suffix(".next")
        staged.write_bytes(bytes.fromhex(content))
        if sys.platform == "darwin":
            os.chmod(staged, 0o600)
        os.replace(staged, path)
    run.service_launch_restored = True
    reload(run)
    return verify_restored(run)


def write_launcher(run, launcher):
    if sys.platform == "darwin":
        with run.service_plist.open("rb") as handle:
            unit = plistlib.load(handle)
        unit["ProgramArguments"][0] = str(launcher)
        staged = run.service_plist.with_suffix(".next")
        staged.write_bytes(plistlib.dumps(unit))
        os.chmod(staged, 0o600)
        os.replace(staged, run.service_plist)
    else:
        dropin = Path(run.args.systemd_dropin).expanduser()
        dropin.mkdir(parents=True, exist_ok=True)
        override = dropin / "20-hard-runtime.conf"
        override.write_text(f'[Service]\nExecStart=\nExecStart="{launcher}" __service-launcher\n')
    reload(run)
