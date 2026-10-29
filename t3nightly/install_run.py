import fcntl
import json
import os
import platform
import plistlib
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from t3nightly.install_copy import refresh_snapshot, backup_database
from t3nightly.release_signatures import verify_cli
from t3nightly.install_runtime import mark_update_restart, pin_runtime, stage_runtime
from t3nightly.install_feed import persist_release_feed, verify_release_feed
from t3nightly.install_storage import payload_locations, snapshot_path

FORK_BASE_URL = "https://github.com/aneym/t3code/releases/download"
STREAMING = ("queued", "preparing", "starting", "running")
REACHABLE = "Other devices can reach this machine"
ET = ZoneInfo("America/New_York")
LAUNCHD_LABEL = "com.t3tools.t3code.service"
LAUNCHD_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"


def now():
    return datetime.now(timezone.utc)


def stamp():
    return now().strftime("%Y%m%dT%H%M%SZ")


class Run:
    def __init__(self, args):
        self.args = args
        self.home = Path(args.home).expanduser()
        from t3nightly.install_service import service_identity

        self.service_label, self.service_plist = service_identity(args, self)
        self.db = self.home / "userdata" / "statev2.sqlite"
        self.state = Path(args.state_dir).expanduser()
        self.state.mkdir(parents=True, exist_ok=True)
        self.snapshots, self.backups = payload_locations(
            self.state, self.home, args.version, args.backups
        )
        self.snapshot = snapshot_path(self.snapshots)
        self.snapshot_ready = False
        self.report = {
            "host": platform.node(),
            "target": args.version,
            "started_at": now().isoformat(),
            "steps": [],
        }

    def step(self, name, **fields):
        row = {"step": name, "at": now().isoformat(), **fields}
        self.report["steps"].append(row)
        print(json.dumps(row), flush=True)

    def finish(self, outcome, line):
        self.report.update(outcome=outcome, line=line, finished_at=now().isoformat())
        path = self.state / f"report-{stamp()}.json"
        path.write_text(json.dumps(self.report, indent=1))
        (self.state / "last.json").write_text(json.dumps(self.report, indent=1))
        print(line, flush=True)
        return 0 if outcome in ("installed", "current") else 1

    def environment(self):
        url = f"http://127.0.0.1:{self.args.port}/.well-known/t3/environment"
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                return json.load(response)
        except (OSError, ValueError):
            return None

    def server_version(self):
        env = self.environment()
        return env.get("serverVersion") if env else None

    def runtime(self, version):
        return self.home / "runtime" / "versions" / version / "t3"

    @contextmanager
    def readonly(self):
        if not self.snapshot_ready:
            refresh_snapshot(self)
        with closing(
            sqlite3.connect(f"file:{self.snapshot}?mode=ro", uri=True, timeout=30)
        ) as connection:
            yield connection

    def streaming_runs(self, *, live=False):
        marks = ",".join("?" for _ in STREAMING)
        query = (
            "select r.thread_id, r.status from orchestration_v2_projection_runs r "
            f"where r.status in ({marks})"
        )
        database = (
            closing(sqlite3.connect(f"file:{self.db}?mode=ro", uri=True, timeout=30))
            if live
            else self.readonly()
        )
        with database as conn:
            rows = conn.execute(query, STREAMING).fetchall()
        ignore = set(self.args.ignore_thread)
        return [row for row in rows if row[0] not in ignore]

    def thread_count(self):
        with self.readonly() as conn:
            return conn.execute(
                "select count(*) from orchestration_v2_projection_threads"
            ).fetchone()[0]

    def merge_active(self):
        if not self.args.merge_repo:
            return []
        tool = Path(self.args.merge_repo) / "scripts" / "studio_merge.py"
        if not tool.exists():
            return []
        out = subprocess.run(
            [sys.executable, str(tool), "status"],
            cwd=self.args.merge_repo,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        try:
            pending = json.loads(out.stdout)["queue"]["pending"]
        except (ValueError, KeyError):
            return ["studio_merge status unreadable"]
        fresh = []
        for row in pending:
            if row.get("state") not in ("landing", "admitted"):
                continue
            updated = datetime.fromisoformat(row["updated_at"])
            if (now() - updated).total_seconds() < self.args.merge_fresh_s:
                fresh.append(row["branch"])
        return fresh

    def held_locks(self):
        held = []
        for raw in self.args.lock:
            path = Path(raw).expanduser()
            if not path.exists():
                continue
            with path.open("a") as handle:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(handle, fcntl.LOCK_UN)
                except BlockingIOError:
                    held.append(str(path))
        return held

    def blockers(self):
        reasons = []
        merging = self.merge_active()
        if merging:
            reasons.append(f"studio_merge landing {','.join(merging)}")
        locks = self.held_locks()
        if locks:
            reasons.append(f"locks held {','.join(locks)}")
        load = os.getloadavg()[0] / (os.cpu_count() or 1)
        if load > self.args.load_max:
            reasons.append(f"load {load:.2f}/cpu over {self.args.load_max}")
        if reasons:
            return reasons
        runs = self.streaming_runs(live=True)
        if runs:
            reasons.append(f"{len(runs)} provider turns streaming")
        return reasons

    def until(self):
        if not self.args.until:
            return None
        hour, minute = (int(part) for part in self.args.until.split(":"))
        local = now().astimezone(ET)
        end = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        return end if end > local else local

    def wait_for_go(self):
        end = self.until()
        while True:
            reasons = self.blockers()
            self.step("go-check", blockers=reasons)
            if not reasons:
                return None
            if not self.args.wait:
                return reasons
            if (
                end is not None
                and now().astimezone(ET) + timedelta(seconds=self.args.recheck_s) >= end
            ):
                return reasons
            time.sleep(self.args.recheck_s)

    def connect_binary(self, version):
        binary = self.runtime(version)
        if not binary.exists():
            binary = Path(shutil.which("t3") or "t3")
        verify_cli(binary)
        return binary

    def managed_connect(self, version):
        result = subprocess.run([str(self.connect_binary(version)), "connect", "status", "--json", "--base-dir", str(self.home)], capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise ValueError("cannot establish whether this home has a managed T3 Connect link")
        status = json.loads(result.stdout)
        return status.get("desired") is True and status.get("linkMode") == "managed"

    def connect_reachable(self, version, timeout=120, binary=None):
        binary = binary or self.connect_binary(version)
        out = subprocess.run(
            [str(binary), "connect", "status", "--base-dir", str(self.home)],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return REACHABLE in out.stdout

    def update(self, from_version, to_version, downgrade):
        from t3nightly.install_policy import recheck

        recheck(self)
        binary = self.runtime(from_version)
        if not binary.exists():
            binary = Path(shutil.which("t3") or "t3")
        if to_version != self.args.version:
            binary = self.runtime(to_version)
        verify_cli(binary)
        if sys.platform == "darwin":
            with self.service_plist.open("rb") as handle:
                verify_cli(Path(plistlib.load(handle)["ProgramArguments"][0]))
        if (
            to_version == self.args.version
            and getattr(self, "prepared_runtime", None) != to_version
        ):
            stage_runtime(self.home, to_version, self.args.assets)
        else:
            verify_cli(self.runtime(to_version))
        persist_release_feed(self.args, to_version)
        env = dict(os.environ)
        env.pop("T3CODE_RESTART_HANDOFF_FILE", None)
        if ".aneym." in to_version:
            env["T3CODE_RELEASE_BASE_URL"] = self.args.base_url
        else:
            env.pop("T3CODE_RELEASE_BASE_URL", None)
        command = [str(binary), "update", to_version, "--base-dir", str(self.home)]
        if sys.platform != "darwin" or self.args.no_pin_launcher:
            command.append("--yes")
        if downgrade:
            command.append("--allow-downgrade")
        log = self.state / f"update-{stamp()}-{to_version}.log"
        with log.open("w") as handle:
            if "--yes" in command:
                mark_update_restart(self.home)
            code = subprocess.run(
                command,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=handle,
                stderr=subprocess.STDOUT,
                timeout=240,
                check=False,
            ).returncode
        if code == 0:
            verify_cli(self.runtime(to_version))
        if code == 0 and sys.platform != "darwin" and not self.args.dry_run:
            mark_update_restart(self.home)
            self.service("restart")
            verify_release_feed(self.args, to_version)
        self.step("update", to=to_version, code=code, log=str(log))
        if code == 0 and sys.platform == "darwin" and not self.args.no_pin_launcher:
            return self.pin_launcher(to_version)
        return code == 0

    def pin_launcher(self, version):
        from t3nightly.launcher_artifact import ensure_launcher

        launcher = ensure_launcher(self, version)
        with self.service_plist.open("rb") as handle:
            unit = plistlib.load(handle)
        before = plistlib.dumps(unit)
        unit["ProgramArguments"][0] = str(launcher)
        env = unit.setdefault("EnvironmentVariables", {})
        env["T3CODE_RELEASE_BASE_URL"] = "https://studio.tailf266ac.ts.net:8972"
        from t3nightly.install_service import safe_launch_environment

        self.step(
            "launcher-environment",
            removed=safe_launch_environment(unit, self.home, launcher),
        )
        changed = plistlib.dumps(unit) != before
        if changed:
            temp = self.service_plist.with_name(f".{self.service_plist.name}.next")
            temp.write_bytes(plistlib.dumps(unit))
            os.chmod(temp, 0o600)
            os.replace(temp, self.service_plist)
        pending = self.home / "runtime" / ".restart-pending"
        restart = changed or pending.exists() or self.service_label != LAUNCHD_LABEL
        code = 0
        if restart:
            mark_update_restart(self.home)
            from t3nightly.install_service import restart_launcher

            code = restart_launcher(self, launcher)
        self.step(
            "pin-launcher",
            launcher=str(launcher),
            version=version,
            restarted=restart,
            code=code,
        )
        return code == 0

    def healthy(self, version, connect_before):
        deadline = time.monotonic() + self.args.health_s
        seen = None
        while time.monotonic() < deadline:
            seen = self.server_version()
            if seen == version:
                break
            time.sleep(5)
        if seen != version:
            return f"server reports {seen}, expected {version}"
        time.sleep(self.args.settle_s)
        if self.server_version() != version:
            return "server did not stay up after the switch"
        if connect_before and not self.connect_reachable(version):
            return "T3 Connect not reachable after the switch"
        return None

    def link_cli(self, version):
        binary = self.runtime(version)
        if not binary.exists():
            return
        verify_cli(binary)
        link = Path.home() / ".local" / "bin" / "t3"
        link.parent.mkdir(parents=True, exist_ok=True)
        staged = link.with_name(".t3.next")
        staged.unlink(missing_ok=True)
        staged.symlink_to(binary)
        os.replace(staged, link)
        self.step("link-cli", target=str(binary))

    def service(self, action):
        if sys.platform == "darwin":
            if action != "stop":
                with self.service_plist.open("rb") as handle:
                    verify_cli(Path(plistlib.load(handle)["ProgramArguments"][0]))
            domain = f"gui/{os.getuid()}"
            command = (
                ["launchctl", "bootout", f"{domain}/{self.service_label}"]
                if action == "stop"
                else ["launchctl", "bootstrap", domain, str(self.service_plist)]
            )
        else:
            command = ["systemctl", "--user", action, self.service_label]
        code = subprocess.run(
            command, capture_output=True, timeout=120, check=False
        ).returncode
        self.step(f"service-{action}", code=code)

    def main(self):
        if self.args.version == "previous":
            last = json.loads((self.state / "last.json").read_text())
            self.args.version = last["previous"]
            self.args.allow_downgrade = True
            self.report["target"] = self.args.version
        previous = self.server_version()
        self.report["previous"] = previous
        if previous is None:
            return self.finish(
                "failed",
                f"{self.report['host']}: T3 server not answering on {self.args.port}; nothing changed",
            )
        if previous == self.args.version:
            verify_cli(self.runtime(previous))
            if sys.platform == "darwin":
                verify_cli(self.home / "runtime" / "launcher" / "t3")
            return self.finish(
                "current", f"{self.report['host']}: already on {previous}"
            )
        reasons = self.wait_for_go()
        if reasons:
            return self.finish(
                "skipped",
                f"{self.report['host']}: skipped {self.args.version}: {'; '.join(reasons)}",
            )
        if self.args.check_only:
            print(
                f"{self.report['host']}: go for {self.args.version} (check only)",
                flush=True,
            )
            return 0
        connect_before = self.managed_connect(previous)
        backup = backup_database(self, previous)
        threads_before = self.thread_count()
        self.step(
            "pre", previous=previous, connect=connect_before, threads=threads_before
        )
        downgrade = self.args.allow_downgrade
        problem = None
        errors = (Failure, OSError, ValueError, subprocess.SubprocessError)
        try:
            if not self.update(previous, self.args.version, downgrade):
                problem = "t3 update failed"
            else:
                problem = self.healthy(self.args.version, connect_before)
            if problem is None:
                refresh_snapshot(self)
            if problem is None and self.thread_count() < threads_before:
                problem = "thread count dropped after the switch"
            if problem is None:
                self.step(
                    "verified", threads=self.thread_count(), connect=connect_before
                )
                self.link_cli(self.args.version)
                return self.finish(
                    "installed",
                    f"{self.report['host']}: {previous} -> {self.args.version} installed, threads intact, Connect {'ok' if connect_before else 'not in use'}",
                )
        except errors as error:
            problem = str(error)
        from t3nightly.install_hot_swap import binary_compatible, supported, swap
        from t3nightly.install_rpc import restart_session
        from t3nightly.install_provenance import migration_history
        from t3nightly.release_manifest import load

        if not self.args.manifest or not binary_compatible(load(self.args.manifest), migration_history(self)) or not supported(self.environment(), self):
            self.report["forwardRepairRequired"] = True
            return self.finish("failed", f"{self.report['host']}: acceptance failed; current database preserved for forward repair")
        self.step("rollback", reason=problem)
        try:
            with restart_session(self, self.args.version) as bearer:
                swap(self, bearer, previous, True)
            again = self.healthy(previous, connect_before)
            if again is None:
                self.link_cli(previous)
                return self.finish(
                    "rolled-back-clean",
                    f"{self.report['host']}: {self.args.version} failed ({problem}); back on {previous}",
                )
        except errors as error:
            again = str(error)
            self.step("rollback-error", error=again)
        return self.finish(
            "broken",
            f"{self.report['host']}: {self.args.version} failed ({problem}); rollback to {previous} also failed ({again}); backup {backup}",
        )


class Failure(Exception):
    pass
