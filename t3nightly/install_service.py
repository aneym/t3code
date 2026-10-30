import os
import plistlib
import re
import subprocess
import sys
from pathlib import Path


DEFAULT_LABEL = "com.t3tools.t3code.service"


def service_identity(args, run):
    label = getattr(args, "service_label", DEFAULT_LABEL)
    raw = getattr(args, "service_plist", "")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]+", label):
        raise ValueError("invalid service label")
    path = (
        Path(raw).expanduser()
        if raw
        else Path.home() / "Library/LaunchAgents" / f"{label}.plist"
    )
    if sys.platform != "darwin":
        if label == DEFAULT_LABEL:
            label = "t3code.service"
        if not label.endswith(".service"):
            raise ValueError("Linux service identity must name a service unit")
        if label != "t3code.service":
            expected = Path.home() / ".config/systemd/user" / f"{label}.d"
            if Path(args.systemd_dropin).expanduser() != expected:
                raise ValueError("sandbox drop-in does not match intended service")
        return label, path
    if label != DEFAULT_LABEL:
        if not raw or path.is_symlink() or path.resolve().parent != run.home.resolve():
            raise ValueError(
                "isolated service plist must be directly inside its private T3 home"
            )
        with path.open("rb") as handle:
            unit = plistlib.load(handle)
        argv = unit.get("ProgramArguments", [])
        if (
            unit.get("Label") != label
            or not (
                ("--base-dir" in argv and argv[argv.index("--base-dir") + 1] == str(run.home))
                or (argv[:1] == ["/usr/bin/env"] and argv[-2:] == [str(run.home / "runtime/launcher/t3"), "__service-launcher"] and f"HOME={run.home}" in argv and f"T3CODE_HOME={run.home}" in argv and unit.get("EnvironmentVariables", {}).get("T3CODE_HOME") == str(run.home))
                or (argv[1:] == ["__service-launcher"] and unit.get("EnvironmentVariables", {}).get("T3CODE_HOME") == str(run.home))
            )
        ):
            raise ValueError("isolated service identity does not match its home")
    return label, path


def restart_launcher(run, launcher):
    from .install_policy import command_environment

    environment = command_environment(run)
    if run.service_label == DEFAULT_LABEL:
        return subprocess.run(
            [str(launcher), "service", "restart", "--base-dir", str(run.home)],
            capture_output=True,
            env=environment,
            timeout=240,
            check=False,
        ).returncode
    domain = f"gui/{os.getuid()}"
    stopped = subprocess.run(
        ["launchctl", "bootout", "--wait", f"{domain}/{run.service_label}"],
        capture_output=True,
        env=environment,
        timeout=120,
        check=False,
    )
    if stopped.returncode:
        return stopped.returncode
    return subprocess.run(
        ["launchctl", "bootstrap", domain, str(run.service_plist)],
        capture_output=True,
        env=environment,
        timeout=120,
        check=False,
    ).returncode


def internal_path(raw):
    path = Path(raw).expanduser()
    return path.is_absolute() and not path.resolve().is_relative_to("/Volumes")


def safe_launch_environment(unit, home, launcher):
    if not internal_path(str(home)) or not internal_path(str(launcher)):
        raise ValueError("headless launcher and T3 home must use internal storage")
    env = unit.setdefault("EnvironmentVariables", {})
    removed = []
    entries = []
    for entry in env.get("PATH", "").split(":"):
        if entry and internal_path(entry):
            entries.append(entry)
        elif entry:
            removed.append("PATH:" + entry)
    env["PATH"] = ":".join(
        dict.fromkeys(
            [str(launcher.parent), *entries, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        )
    )
    for key, value in list(env.items()):
        if (
            key != "PATH"
            and isinstance(value, str)
            and value.startswith("/")
            and not internal_path(value)
        ):
            removed.append(key)
            del env[key]
    env["HOME"] = str(Path.home())
    tmp = home / "runtime" / "tmp"
    if not internal_path(str(tmp)):
        raise ValueError(
            "headless launcher temporary directory escapes internal storage"
        )
    tmp.mkdir(mode=0o700, parents=True, exist_ok=True)
    env["TMPDIR"] = str(tmp)
    unit["WorkingDirectory"] = str(home)
    return removed
