import hashlib
import json
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from . import install_offbox_stage as stage
from . import install_restore_copy as restore_copy
from .db_publish import LOCAL_MARGIN, wal_bytes
from . import live_read_guard as guard
from .install_storage import record_payload
from .io_priority import background_command

REMOTE_ROOT = PurePosixPath("/Volumes/StudioExt/t3nightly-install-data/remote")
REMOTE_EXE = "/Users/aneyman/.local/bin/sqlite3_rsync"
SSH = Path(__file__).with_name("offbox-ssh")
REMOTE_ZSTD = "/opt/homebrew/bin/zstd"
CHUNK = 1024 * 1024
ZSTD_THREADS = 4
METHOD = "offbox-sqlite3-rsync"
CATCH_UP_ROUNDS = 3
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def target(spec):
    if sys.platform == "darwin":
        raise ValueError("--offbox is Linux only; macOS payloads already live on StudioExt")
    host, separator, raw = str(spec).partition(":")
    path = PurePosixPath(raw)
    if not separator or not NAME.fullmatch(host):
        raise ValueError("--offbox must be HOST:/absolute/path")
    if not path.is_absolute() or path == REMOTE_ROOT or not path.is_relative_to(REMOTE_ROOT):
        raise ValueError(f"--offbox path must sit below {REMOTE_ROOT}")
    if not all(NAME.fullmatch(part) and part not in (".", "..") for part in path.relative_to(REMOTE_ROOT).parts):
        raise ValueError("--offbox path components must be letters, digits, dot, dash or underscore")
    return host, path


def remote(host, script, deadline):
    result = subprocess.run([str(SSH), host, script], capture_output=True, text=True, timeout=max(1, deadline - time.monotonic()), check=False)
    if result.returncode:
        raise ValueError(f"off-box command on {host} failed: {result.stderr.strip()[-300:]}")
    return result.stdout


def remote_directory(host, path, deadline):
    parts = path.relative_to(REMOTE_ROOT).parts
    chain = " ".join(shlex.quote(str(REMOTE_ROOT.joinpath(*parts[:index]))) for index in range(len(parts) + 1))
    script = (f"set -e; umask 077; test -d {shlex.quote(str(REMOTE_ROOT.parent))}; for p in {chain}; do "
              f"if [ -L \"$p\" ]; then echo \"payload directory is a symlink: $p\" >&2; exit 3; fi; [ -d \"$p\" ] || mkdir -m 700 \"$p\"; chmod 700 \"$p\"; done; "
              f"df -Pk {shlex.quote(str(path))} | tail -1")
    return int(remote(host, script, deadline).split()[3]) * 1024


def seed(host, root, replica, deadline):
    path = shlex.quote(str(replica))
    script = (f"set -e; if test -e {path}; then echo existing; exit 0; fi; newest=$(ls -1t {shlex.quote(str(root))}/*/rollback/statev2.sqlite 2>/dev/null | head -1); "
              f"[ -n \"$newest\" ] || exit 0; [ -L \"$newest\" ] && exit 0; cp -c \"$newest\" {path}.seed && chmod 600 {path}.seed "
              f"&& mv {path}.seed {path} && echo \"$newest\"")
    return remote(host, script, deadline).strip() or None


def remote_zstd(host):
    script = f"z=$(command -v zstd || true); [ -n \"$z\" ] || z={REMOTE_ZSTD}; test -x \"$z\" && echo \"$z\""
    found = remote(host, script, time.monotonic() + 60).strip()
    if not found or not shutil.which("zstd"):
        raise ValueError("zstd must exist locally and on the off-box host for a first ship; nothing stopped")
    return found


def stream(host, staged, replica, deadline):
    part = shlex.quote(f"{replica}.part")
    zstd = shlex.quote(remote_zstd(host))
    script = f"set -e; umask 077; {zstd} -q -d -f -o {part}; chmod 600 {part}; mv {part} {shlex.quote(str(replica))}"
    compress = subprocess.Popen(background_command(["zstd", "-q", f"-T{ZSTD_THREADS}", "-3", "-c", str(staged)]), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    send = subprocess.Popen([str(SSH), host, script], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    sent, shipped = 0, False
    try:
        while chunk := compress.stdout.read(CHUNK):
            if time.monotonic() >= deadline:
                raise ValueError("compressed first ship passed its --offbox-seed-s deadline")
            send.stdin.write(chunk)
            sent += len(chunk)
        send.stdin.close()
        compressed = compress.wait(timeout=max(1, deadline - time.monotonic()))
        received = send.wait(timeout=max(1, deadline - time.monotonic()))
        if compressed or received:
            raise ValueError(f"compressed first ship failed: {send.stderr.read().decode(errors='replace').strip()[-300:]}")
        shipped = True
    except (BrokenPipeError, subprocess.TimeoutExpired) as error:
        raise ValueError(f"compressed first ship failed: {type(error).__name__}") from error
    finally:
        for process in (compress, send):
            if process.poll() is None:
                process.kill()
                process.wait()
        if not shipped:
            try:
                remote(host, f"rm -f {part}", time.monotonic() + 30)
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
    return sent


def ship(run, host, replica, source, size, deadline, *, first):
    directory = stage.staging(run)
    staged, metrics, started = None, {}, time.monotonic()
    try:
        staged, metrics = stage.copy(run, directory, source, size)
        started = time.monotonic()
        if first:
            sent = stream(host, staged, replica, deadline)
            metrics.update(shipMethod="zstd-stream", compressedBytes=sent, compressionRatio=round(metrics["stageBytes"] / max(sent, 1), 3))
        else:
            sync(staged, f"{host}:{replica}", deadline, background=True)
            metrics["shipMethod"] = "sqlite3-rsync-stage"
    finally:
        if staged is not None:
            metrics["shipSeconds"] = round(time.monotonic() - started, 3)
            metrics["stageBytesFreed"] = stage.discard(run, directory, staged)
            metrics["stageFreeAfter"] = shutil.disk_usage(directory).free
            run.step("offbox-stage", remote=f"{host}:{replica}", **metrics)
    return metrics


def executable():
    found = shutil.which("sqlite3_rsync") or str(Path.home() / ".local/bin/sqlite3_rsync")
    if not Path(found).is_file():
        raise ValueError("sqlite3_rsync is not installed locally")
    return found


def sync(origin, replica, deadline, *, background=False):
    command = [executable(), str(origin), str(replica), "--exe", REMOTE_EXE, "--ssh", str(SSH)]
    started = time.monotonic()
    result = subprocess.run(background_command(command) if background else command, capture_output=True, text=True, timeout=max(1, deadline - time.monotonic()), check=False)
    if result.returncode:
        raise ValueError(f"sqlite3_rsync {origin} -> {replica} failed: {result.stderr.strip()[-300:]}")
    return time.monotonic() - started


def remote_check(host, replica, deadline):
    path = shlex.quote(str(replica))
    return remote(host, f"set -e; chmod 600 {path}; sqlite3 {path} 'PRAGMA quick_check'", deadline).strip()


def schema_state(db):
    with closing(sqlite3.connect(f"{Path(db).resolve().as_uri()}?mode=ro", uri=True, timeout=30)) as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        rows = [connection.execute("SELECT type, name, coalesce(sql, '') FROM sqlite_master ORDER BY type, name").fetchall()]
        rows += [connection.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall() for table in ("effect_sql_migrations", "aneym_fork_migrations") if table in tables]
    return hashlib.sha256(json.dumps(rows, default=str).encode()).hexdigest()


def restore_space(size, wal):
    return max(LOCAL_MARGIN, size // 4, wal * 2)


def rate(run):
    return run.args.offbox_mib_s * 1024 * 1024


def placement(run, local):
    host, root = target(run.args.offbox)
    version = run.args.version
    if not NAME.fullmatch(version):
        raise ValueError("invalid rollback version path")
    replica = root / version / "rollback" / "statev2.sqlite"
    source = run.db.resolve()
    size = source.stat().st_size + wal_bytes(source)
    if shutil.disk_usage(local).free < LOCAL_MARGIN:
        raise ValueError("insufficient local margin for an off-box rollback backup")
    if remote_directory(host, replica.parent, time.monotonic() + 120) < max(size * 2, LOCAL_MARGIN):
        raise ValueError("insufficient off-box rollback backup disk space")
    return host, root, replica, source, size


def preseed(run, host, root, replica, source, size, started):
    address = f"{host}:{replica}"
    deadline = time.monotonic() + run.args.offbox_seed_s
    found = seed(host, root, replica, deadline)
    seeded = {"clonedFrom": None if found == "existing" else found, "existing": found == "existing"}
    seeded["stage"] = ship(run, host, replica, source, size, deadline, first=found is None)
    seeded["seconds"] = round(time.monotonic() - started, 3)
    run.step("hard-backup-seed", remote=address, **seeded)
    return seeded, deadline


def verified(run, host, root, replica, deadline, metadata):
    check = remote_check(host, replica, deadline)
    if check != "ok":
        raise ValueError(f"off-box backup quick_check {check}")
    metadata = {"remote": f"{host}:{replica}", "method": METHOD, "quickCheck": check, **metadata, "complete": True}
    marker = json.dumps({"verifiedAt": datetime.now(timezone.utc).isoformat(), "quickCheck": check, "bytes": metadata["bytes"], "schemaState": metadata.get("schemaState")})
    path = shlex.quote(str(replica.parent / "verified.json"))
    remote(host, f"set -e; umask 077; printf '%s\\n' {shlex.quote(marker)} > {path}.tmp && mv {path}.tmp {path}", deadline)
    record_payload(run.state, "rollback-backup", metadata["remote"], bytes=metadata["bytes"], method=METHOD, quick_check=check)
    return metadata


def live_backup(run, previous):
    started = time.monotonic()
    host, root, replica, source, size = placement(run, run.db.resolve().parent)
    seeded, deadline = preseed(run, host, root, replica, source, size, started)
    metadata = verified(run, host, root, replica, deadline, {"bytes": size, "seed": seeded, "live": True, "previous": previous})
    metadata["seconds"] = round(time.monotonic() - started, 3)
    run.step("backup", **metadata)
    prune(run, host, root, run.args.version)
    return metadata


def catch_up(run, host, replica, source, size, deadline, keep_local):
    started = time.monotonic()
    check = remote_check(host, replica, deadline)
    if check != "ok":
        raise ValueError(f"seeded off-box replica quick_check {check}; nothing stopped")
    checking = time.monotonic() - started
    budget = run.args.offbox_stop_s
    for _ in range(CATCH_UP_ROUNDS):
        last = ship(run, host, replica, source, size, deadline, first=False)
        stale = last["copySeconds"] + last["shipSeconds"]
        local = restore_copy.estimate(size, last) if keep_local else {}
        estimate = max(stale, guard.wal_in_use(source) / rate(run)) + checking + local.get("copySeconds", 0) + local.get("checkSeconds", 0)
        if estimate <= budget / 2:
            break
    run.step("hard-backup-estimate", catchUpShipSeconds=last["shipSeconds"], stageCopySeconds=last["copySeconds"], stageStaleSeconds=round(stale, 3), checkSeconds=round(checking, 3),
             localRestoreCopy=local or None, estimateSeconds=round(estimate, 3), budgetSeconds=budget)
    if estimate > budget:
        raise ValueError(f"post-stop off-box sync estimated at {estimate:.0f} s exceeds --offbox-stop-s {budget}; nothing stopped")
    needed = restore_space(size, wal_bytes(source))
    if shutil.disk_usage(source.parent).free < needed:
        raise ValueError(f"local space under the {needed >> 20} MiB an in-place restore could need; nothing stopped")


def capture(run, previous, stop, rollback_gate, keep_local=False):
    started = time.monotonic()
    binary = rollback_gate()
    if binary:
        stop()
        metadata = {"method": "binary-rollback", **binary, "seconds": round(time.monotonic() - started, 3), "previous": previous, "complete": True}
        run.step("hard-backup", **metadata)
        return metadata
    local = run.home / "runtime" / "rollback"
    local.mkdir(parents=True, exist_ok=True, mode=0o700)
    host, root, replica, source, size = placement(run, local)
    seeded, deadline = preseed(run, host, root, replica, source, size, started)
    catch_up(run, host, replica, source, size, deadline, keep_local)
    if keep_local:
        restore_copy.precheck(run, source)
    destination = local / uuid.uuid4().hex
    destination.mkdir(mode=0o700)
    stop()
    stopped = time.monotonic()
    window = stopped + run.args.offbox_stop_s
    state = schema_state(source)
    copy = restore_copy.take(run, source, previous, window) if keep_local else None
    try:
        try:
            sync(source, f"{host}:{replica}", window)
            metadata = verified(run, host, root, replica, window, {"bytes": size, "schemaState": state, "seed": seeded, "stoppedSeconds": round(time.monotonic() - stopped, 3),
                                                                   "seconds": round(time.monotonic() - started, 3), "previous": previous, **({"local": copy} if copy else {})})
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            if not copy:
                raise
            metadata = {"remote": f"{host}:{replica}", "method": METHOD, "replica": "degraded", "replicaError": f"{type(error).__name__}: {error}", "bytes": size, "schemaState": state,
                        "seed": seeded, "stoppedSeconds": round(time.monotonic() - stopped, 3), "seconds": round(time.monotonic() - started, 3), "previous": previous, "local": copy, "complete": True}
            run.step("offbox-replica-degraded", remote=metadata["remote"], error=metadata["replicaError"], primary="local-restore-copy", next="background reship from the restore copy")
    except BaseException:
        if copy:
            restore_copy.discard(run, copy)
        raise
    (destination / "payload.json").write_text(json.dumps(metadata))
    run.step("hard-backup", **metadata)
    return metadata


def prune_backup(run, backup):
    host, _, path = backup["remote"].partition(":")
    prune(run, host, PurePosixPath(path).parent.parent.parent, run.args.version)


def prune(run, host, root, current):
    try:
        listed = remote(host, f"cd {shlex.quote(str(root))} && ls -1t */rollback/verified.json 2>/dev/null || true", time.monotonic() + 60)
        names = [line.split("/")[0] for line in listed.splitlines() if NAME.fullmatch(line.split("/")[0])]
        for name in [name for name in names if name != current][max(run.args.backup_keep - 1, 0):]:
            path = shlex.quote(str(root / name))
            remote(host, f"set -e; [ ! -L {path} ]; rm -rf -- {path}", time.monotonic() + 120)
            record_payload(run.state, "discard-offbox-rollback-backup", f"{host}:{root / name}", bytes=0)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        run.step("offbox-prune-failed", error=str(error))
