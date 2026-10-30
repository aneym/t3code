import hashlib
import json
import os
import plistlib
import re
import shlex
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
from contextlib import closing
from pathlib import Path

from .codex_isolation import isolated_codex_home
from .headless_env import claude_lb_lines, headless_bin, pin_settings
from .install_strays import port_listeners
from .release_manifest import history_digest

SERVER_OWNED_EXIT = 78
OWNED_RETRIES = 3


def sha256(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def wait_for(fn, seconds, what):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(0.25)
    raise TimeoutError(f"timed out waiting for {what}")


def provider_wrapper(binary, evidence, destination):
    provider_home = destination.parent.parent
    config = provider_home / "claude-home"
    guard_home = provider_home if sys.platform == "darwin" else Path.home()
    config.mkdir(exist_ok=True, mode=0o700)
    lines = ["#!/bin/sh", "export ENABLE_TOOL_SEARCH=false", f"export HOME={shlex.quote(str(guard_home))}", f"export CLAUDE_CONFIG_DIR={shlex.quote(str(config))}",
             f"export CLAUDE_CODE_TMPDIR={shlex.quote(str(destination.parent / 'tmp'))}"]
    if sys.platform == "darwin":
        lines.extend(claude_lb_lines(headless_bin(destination.parent / "headless-bin", evidence / "security-refusals.log")))
    else:
        lines.extend(claude_lb_lines(destination.parent / "headless-bin"))
    lines.append(f'exec {shlex.quote(str(binary))} --setting-sources "" --tools Bash,Read,Write,Edit,Glob,Grep "$@" 2>>{shlex.quote(str(evidence / "provider-stderr.log"))}')
    destination.write_text("\n".join(lines) + "\n")
    destination.chmod(0o700)
    return destination


class Sandbox:
    def __init__(self, args):
        self.args = args
        self.home = args.home.expanduser().resolve()
        self.evidence = args.evidence.expanduser().resolve()
        self.old = args.old_runtime.expanduser().absolute()
        self.label = args.label
        self.port = args.port
        self.domain = f"gui/{os.getuid()}"
        self.started = False
        self.unit = self.home / f"{self.label}.plist"
        self.cli = self.home / "runtime/launcher/t3"
        self.db = self.home / "userdata/statev2.sqlite"
        self.project = self.home / "project"
        self.os_home = self.home / "installer-home"
        self.systemd_unit = Path.home() / ".config/systemd/user" / f"{self.label}.service"
        self.systemd_dropin = self.systemd_unit.with_suffix(".service.d")

    def validate(self):
        if not re.fullmatch(r"(?:com\.)?t3-rehearsal[.-][A-Za-z0-9_.-]+", self.label):
            raise ValueError("label must have a unique t3-rehearsal- or com.t3-rehearsal. prefix")
        from .install_policy import refuse_probe

        refuse_probe(self.home, self.port, self.label, getattr(self.args, "live_home", []))
        live = [Path.home() / ".t3", Path.home() / ".t3nightly"]
        if self.home.is_relative_to(live[0]) or self.evidence.is_relative_to(live[0]):
            raise ValueError("sandbox cannot be inside the live T3 home")
        for path in (self.home, self.evidence):
            if path.is_relative_to(live[1]) and not path.relative_to(live[1]).parts[0].startswith("rehearsal-"):
                raise ValueError("nightly sandbox paths require a rehearsal- prefix")
        for path in (self.home, self.evidence):
            if path in (Path("/"), Path.home()) or any(root == path or root.is_relative_to(path) or path.is_relative_to(root / "userdata") or path.is_relative_to(root / "runtime") for root in live):
                raise ValueError("sandbox path overlaps live state")
        if self.home == self.evidence or self.home.is_relative_to(self.evidence) or self.evidence.is_relative_to(self.home):
            raise ValueError("home and evidence must be disjoint")
        if self.home.exists() or self.evidence.exists():
            raise ValueError("home and evidence must be new directories")
        if not 1024 <= self.port <= 65535 or self.port in (3773, 3000):
            raise ValueError("unsafe rehearsal port")
        if not (self.old / "t3").is_file() or not self.args.seed.is_file():
            raise ValueError("old runtime or sanitized seed missing")
        if sys.platform == "darwin" and str(self.home).startswith("/Volumes/"):
            raise ValueError("launchd sandbox home requires internal storage")
        if sys.platform == "darwin":
            from .rehearsal_internal import validate

            validate(self)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", self.port))
        if sys.platform == "darwin":
            if subprocess.run(["launchctl", "print", f"{self.domain}/{self.label}"], capture_output=True, timeout=10, check=False).returncode == 0:
                raise ValueError("service label is already loaded")
        elif self.systemd_unit.exists() or self.systemd_dropin.exists():
            raise ValueError("systemd rehearsal unit or drop-in already exists")

    def query(self, sql, params=()):
        with closing(sqlite3.connect(f"file:{self.db}?mode=ro", uri=True, timeout=10)) as connection:
            return connection.execute(sql, params).fetchall()

    def history(self):
        return history_digest(self.query("SELECT migration_id, name FROM effect_sql_migrations"))

    def version(self):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/.well-known/t3/environment", timeout=3) as response:
                return json.load(response).get("serverVersion")
        except (OSError, ValueError):
            return None

    def published(self):
        if getattr(self.args, "hot_swap", False):
            try:
                return bool(self.version() and self.serving_digest())
            except (OSError, ValueError, subprocess.SubprocessError):
                return False
        try:
            state = json.loads((self.home / "userdata/server-runtime.json").read_text())
        except (OSError, ValueError):
            return False
        return state.get("port") == self.port and str(state.get("pid")) in port_listeners(self.port)

    def wait_ready(self, version, seconds):
        wait_for(lambda: self.version() == version and self.published(), seconds, f"sandbox runtime {version} to publish its runtime state")

    def t3(self, *args):
        for attempt in range(OWNED_RETRIES + 1):
            debug = ["--log-level", "debug"] if attempt == OWNED_RETRIES else []
            result = subprocess.run([str(self.cli), *args, *debug, "--base-dir", str(self.home)], capture_output=True, text=True, timeout=120, cwd=self.project, check=False)
            if result.returncode != SERVER_OWNED_EXIT:
                break
            with (self.evidence / "cli-owned-refusals.log").open("a") as log:
                log.write(f"{args[0]} {args[1]} attempt {attempt}: {result.stderr[-2000:]}\n")
            time.sleep(2)
        if result.returncode:
            raise RuntimeError(f"sandbox CLI {args[0]} {args[1]} failed (exit {result.returncode}): {result.stderr[-500:]} {result.stdout[-500:]}")
        return json.loads(result.stdout) if "--json" in args else result.stdout

    def service_environment(self):
        paths = [str(self.cli.parent)] + [entry for entry in os.environ.get("PATH", "").split(os.pathsep) if ".t3" not in entry and not str(Path(entry).resolve()).startswith("/Volumes/")]
        environment = {"HOME": str(self.home), "PATH": os.pathsep.join(paths), "T3CODE_HOME": str(self.home), "T3CODE_NO_BROWSER": "1", "TMPDIR": str(self.home / "runtime/tmp"), "CODEX_HOME": str(self.home / "codex-home"), "GIT_TERMINAL_PROMPT": "0",
                       "T3CODE_HOST": "127.0.0.1", "T3CODE_PORT": str(self.port)}
        if any(".t3" in value and not value.startswith(str(self.home)) for value in environment.values()):
            raise ValueError("sandbox service environment contains a live T3 path")
        return environment

    def prepare(self, health_seconds):
        self.validate()
        self.home.mkdir(parents=True, mode=0o700)
        self.evidence.mkdir(parents=True, mode=0o700)
        if getattr(self.args, "hot_swap", False):
            (self.home.parent / "rehearsal-target.json").write_text(json.dumps({"home": str(self.home), "label": self.label, "port": self.port}) + "\n")
        (self.home / "userdata/logs").mkdir(parents=True)
        (self.home / "runtime/versions").mkdir(parents=True)
        (self.home / "runtime/tmp").mkdir(mode=0o700)
        shutil.copy2(Path(__file__).with_name("rehearsal_waiter.py"), self.home / "runtime/rehearsal_waiter.py")
        isolated_codex_home(self.home / "codex-home", inherit=sys.platform != "darwin")
        self.os_home.mkdir()
        old_version = self.old.name
        if getattr(self.args, "hot_swap", False):
            from .rehearsal_storage import prepare

            prepare(self)
        else:
            for destination in (self.home / "runtime/versions" / old_version, self.cli.parent):
                if sys.platform == "darwin":
                    subprocess.run(["cp", "-c", "-R", str(self.old), str(destination)], check=True, timeout=120)
                else:
                    subprocess.run(["cp", "--reflink=auto", "-a", str(self.old), str(destination)], check=True, timeout=120)
            with closing(sqlite3.connect(f"file:{self.args.seed.resolve()}?mode=ro", uri=True)) as source, closing(sqlite3.connect(self.db)) as target:
                source.backup(target)
        if getattr(self.args, "hot_swap", False) and (self.args.launcher_artifact or self.args.old_launcher_artifact):
            from .rehearsal_service import pin_artifacts

            pin_artifacts(self)
        self.check_seed()
        wrapper = str(provider_wrapper(self.args.provider_binary, self.evidence, self.home / "runtime/claude-provider"))
        settings = {"providerInstances": {self.args.provider: {"driver": "claudeAgent", "displayName": "Rehearsal", "enabled": True, "environment": [], "config": {"binaryPath": wrapper}}}}
        (self.home / "userdata/settings.json").write_text(json.dumps(settings) + "\n")
        pin_settings(self.home / "userdata/settings.json", self.home / "runtime", self.evidence / "security-refusals.log", keep=[wrapper])
        self.project.mkdir()
        subprocess.run(["git", "init", "-q", str(self.project)], check=True, timeout=10)
        subprocess.run(["git", "-C", str(self.project), "-c", "user.name=Rehearsal", "-c", "user.email=rehearsal@local", "commit", "--allow-empty", "-qm", "Initialize sandbox"], check=True, timeout=10)
        self.boot()
        self.wait_ready(old_version, health_seconds)
        self.t3("project", "add", str(self.project))

    def check_seed(self):
        pending = self.query("SELECT count(*) FROM orchestration_v2_projection_runs WHERE status IN ('queued','preparing','starting','running')")[0][0]
        tasks = self.query("SELECT count(*) FROM scheduled_tasks")[0][0]
        outbox = self.query("SELECT count(*) FROM orchestration_v2_effect_outbox WHERE status NOT IN ('completed','succeeded')")[0][0]
        if pending or tasks or outbox:
            raise ValueError(f"seed is not sanitized: active={pending}, tasks={tasks}, outbox={outbox}")

    def boot(self):
        argv = [str(self.cli), "serve", "--base-dir", str(self.home), "--host", "127.0.0.1", "--port", str(self.port), "--no-browser"]
        if getattr(self.args, "hot_swap", False):
            state = {"protocol": 3, "activeVersion": self.old.name}
            (self.home / "runtime/service-state.json").write_text(json.dumps(state) + "\n")
            argv = [str(self.cli), "__service-launcher"]
        log = self.home / "userdata/logs/service.log"
        if getattr(self.args, "hot_swap", False):
            from .rehearsal_service import boot

            boot(self, argv, log)
            return
        if sys.platform == "darwin":
            unit = {"Label": self.label, "ProgramArguments": argv, "EnvironmentVariables": self.service_environment(), "WorkingDirectory": str(self.home), "StandardOutPath": str(log), "StandardErrorPath": str(log), "RunAtLoad": True, "KeepAlive": True, "ExitTimeOut": 30}
            self.unit.write_bytes(plistlib.dumps(unit))
            self.unit.chmod(0o600)
            subprocess.run(["launchctl", "bootstrap", self.domain, str(self.unit)], check=True, timeout=60)
            self.started = True
        else:
            self.systemd_unit.parent.mkdir(parents=True, exist_ok=True)
            command = " ".join('"' + arg.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"' for arg in argv)
            with self.systemd_unit.open("x") as handle:
                environment = self.service_environment()
                assignments = " ".join(f'{key}="{value}"' for key, value in environment.items())
                handle.write(f"[Unit]\nDescription=T3 isolated rehearsal\n[Service]\nExecStart={command}\nEnvironment={assignments}\nWorkingDirectory={self.home}\nRestart=on-failure\nStandardOutput=append:{log}\nStandardError=append:{log}\n")
            subprocess.run(["systemctl", "--user", "daemon-reload"], check=True, timeout=30)
            subprocess.run(["systemctl", "--user", "start", f"{self.label}.service"], check=True, timeout=60)
            self.started = True

    def serving_digest(self):
        if getattr(self.args, "hot_swap", False):
            from .rehearsal_service import serving_digest

            return serving_digest(self)
        if sys.platform == "darwin":
            result = subprocess.run(["launchctl", "print", f"{self.domain}/{self.label}"], capture_output=True, text=True, check=True, timeout=10)
            match = re.search(r"\bpid = (\d+)", result.stdout)
            if not match:
                raise ValueError("sandbox service has no PID")
            result = subprocess.run(["lsof", "-a", "-p", match[1], "-d", "txt", "-Fn"], capture_output=True, text=True, check=True, timeout=10)
            paths = [Path(line[1:]) for line in result.stdout.splitlines() if line.startswith("n") and Path(line[1:]).name == "t3"]
        else:
            result = subprocess.run(["systemctl", "--user", "show", "--property=MainPID", "--value", f"{self.label}.service"], capture_output=True, text=True, check=True, timeout=10)
            paths = [Path(f"/proc/{int(result.stdout.strip())}/exe").resolve()]
        if len(paths) != 1 or not paths[0].resolve().is_relative_to(self.home / "runtime"):
            raise ValueError("serving executable is not sandbox-owned")
        return sha256(paths[0])

    def close(self):
        from .rehearsal_waiter import cleanup

        try:
            if not self.started:
                return
            try:
                if (self.home / "runtime/connector-pin.json").is_file():
                    from .rehearsal_service import connector_run
                    from .connector_artifact import uninstall

                    uninstall(connector_run(self))
            finally:
                if sys.platform == "darwin":
                    subprocess.run(["launchctl", "bootout", "--wait", f"{self.domain}/{self.label}"], capture_output=True, check=True, timeout=120)
                else:
                    subprocess.run(["systemctl", "--user", "stop", f"{self.label}.service"], check=True, timeout=60)
                    self.systemd_unit.unlink(missing_ok=True)
                    if self.systemd_dropin.exists():
                        shutil.rmtree(self.systemd_dropin)
                    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True, timeout=30)
                self.started = False
        finally:
            cleanup(self.home, self.home.parent / "gate-waiters")
