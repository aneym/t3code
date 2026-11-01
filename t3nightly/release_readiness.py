import json
import os
import shutil
import sqlite3
import subprocess
import time
import urllib.request
from contextlib import closing
from pathlib import Path

from .release_config import CHAT_PROJECT, SEEDS
from .release_manifest import contained, engine_identity, history_digest, migration_identity
from .release_targets import LINUX_TARGETS


FLOORS = {"/Volumes/StudioExt": 20 * 1024**3, "/": 25 * 1024**3}
REMOTE_FLOOR = 25 * 1024**3
REMOTE_PROBE = r'''
import json, os, shutil, sqlite3, sys, urllib.request
from contextlib import closing
from pathlib import Path
tools, seeds, version, chat, remote_run = sys.argv[1:6]
home = Path.home()
row = {"disk": shutil.disk_usage("/").free, "load": os.getloadavg()[0], "cpus": os.cpu_count()}
try:
    with urllib.request.urlopen("http://127.0.0.1:3773/.well-known/t3/environment", timeout=3) as response:
        row["serving"] = json.load(response).get("serverVersion")
except (OSError, ValueError):
    row["serving"] = None
sys.path.insert(0, str(Path(tools).parent))
try:
    from t3nightly.release_manifest import engine_identity
    row["engine"] = engine_identity(Path(tools))["digest"]
except Exception as error:
    row["engine"] = f"unavailable: {type(error).__name__}"
row["head"] = None
if row["serving"]:
    current = Path(remote_run)
    root = current.parent.parent if current.name.startswith("fast") else current.parent
    roots = (root / row["serving"], home / ".t3nightly/runs" / row["serving"])
    for path in (path for runs in roots for path in (runs / "fast/assembly.json", runs / "assembly.json")):
        if path.is_file():
            try:
                row["head"] = json.loads(path.read_text()).get("head")
            except (OSError, ValueError, AttributeError):
                pass
            break
row["liveHistory"] = None
try:
    with closing(sqlite3.connect(f"file:{home / '.t3/userdata/statev2.sqlite'}?mode=ro", uri=True)) as connection:
        from t3nightly.release_manifest import history_digest
        row["liveHistory"] = history_digest(connection.execute("SELECT migration_id, name FROM effect_sql_migrations"))
except Exception:
    pass
row["seedHistories"] = {}
for path in sorted((home / seeds).glob("*.sqlite")):
    try:
        with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as connection:
            from t3nightly.release_manifest import history_digest
            row["seedHistories"][path.stem] = history_digest(connection.execute("SELECT migration_id, name FROM effect_sql_migrations"))
    except Exception:
        row["seedHistories"][path.stem] = None
versions = home / ".t3/runtime/versions"
row["runtimes"] = sorted(path.name for path in versions.iterdir() if (path / "t3").is_file()) if versions.is_dir() else []
row["held"] = (home / ".t3nightly" / f"hold-install{version.rsplit('.', 1)[1]}").exists()
row["files"] = {name: (home / name).exists() for name in (".local/bin/claude", ".vite-plus/bin/vp", ".cargo/bin/cargo", ".config/t3nightly/public-config.env", chat)}
try:
    with closing(sqlite3.connect(f"file:{home / '.t3/userdata/statev2.sqlite'}?mode=ro", uri=True)) as connection:
        row["chatProject"] = connection.execute("SELECT 1 FROM projection_projects WHERE workspace_root=? AND deleted_at IS NULL", (str(home / chat),)).fetchone() is not None
except sqlite3.Error:
    row["chatProject"] = False
print(json.dumps(row))
'''


def serving_version():
    try:
        with urllib.request.urlopen("http://127.0.0.1:3773/.well-known/t3/environment", timeout=3) as response:
            return json.load(response).get("serverVersion")
    except (OSError, ValueError):
        return None


def resolve_topic(repo, topic):
    for ref in (f"refs/remotes/origin/{topic}", f"refs/heads/{topic}"):
        result = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"], capture_output=True, text=True, check=False)
        if result.returncode == 0:
            return result.stdout.strip()
    return None


def serving_head(config, version):
    runs = config.home / ".t3nightly/runs" / str(version)
    assembly = next((path for path in (runs / "fast/assembly.json", runs / "assembly.json") if path.is_file()), None)
    try:
        return json.loads(assembly.read_text()).get("head") if version and assembly else None
    except (OSError, ValueError, AttributeError):
        return None


def contains(repo, ancestor, commit):
    return bool(ancestor and commit) and contained(repo, ancestor, commit)


def remote_probe(config, log, host="ax42"):
    words = ["ssh", "-oBatchMode=yes", "-oConnectTimeout=5", LINUX_TARGETS[host], "python3", "-", config.remote_tools, SEEDS, config.version, CHAT_PROJECT, config.remote_run]
    try:
        result = subprocess.run(words, input=REMOTE_PROBE, capture_output=True, text=True, timeout=25, check=False)
        if result.returncode:
            log.write(result.stderr)
            return {}
        return json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError) as error:
        log.write(f"{host} probe failed: {error}\n")
        return {}


def source_history(repo, head):
    if not head:
        return None
    try:
        return migration_identity(repo, head)["history"]
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return None


def live_history(path):
    try:
        with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as connection:
            return history_digest(connection.execute("SELECT migration_id, name FROM effect_sql_migrations"))
    except sqlite3.Error:
        return None


def readiness(config, log):
    started = time.monotonic()
    checks, evidence, host_checks = {}, {}, {"studio": {}}
    engine = engine_identity(config.tools)
    checks["engine-clean"] = not engine["dirty"]
    topics = [resolve_topic(config.repo, name) for name in config.topic.split(",")]
    checks["topic-resolves"] = all(topics)
    old = serving_version()
    studio_head = serving_head(config, old)
    studio_history = source_history(config.repo, studio_head)
    base_head = studio_head
    evidence["studioServing"] = old
    evidence["servingHead"] = studio_head
    checks["base-assembly"] = bool(old and studio_head and studio_history)
    if config.base and base_head:
        chosen = subprocess.run(["git", "-C", str(config.repo), "rev-parse", f"{config.base}^{{commit}}"], capture_output=True, text=True, check=False).stdout.strip()
        checks["base-contains-serving"] = contains(config.repo, base_head, chosen)
        base_head = chosen or None
    history = source_history(config.repo, base_head)
    checks["base-history"] = bool(history)
    checks["base-contains-nightly"] = contains(config.repo, f"v{config.nightly}", base_head)
    studio_live = live_history(config.home / ".t3/userdata/statev2.sqlite")
    checks["studio-live-history"] = bool(studio_history and studio_live == studio_history)
    studio = host_checks["studio"]
    studio["not-held"] = not config.held
    studio["seed"] = bool(studio_history and live_history(config.seed(studio_history)) == studio_history)
    studio["old-runtime"] = bool(old) and (config.home / ".t3/runtime/versions" / old / "t3").is_file()
    for path, floor in FLOORS.items():
        free = shutil.disk_usage(path).free
        evidence[f"free:{path}"] = free
        studio[f"disk:{path}"] = free >= floor
    for name in (".local/bin/claude", ".vite-plus/bin/vp", ".config/t3nightly/public-config.env"):
        studio[name] = (config.home / name).exists()
    try:
        with closing(sqlite3.connect(f"file:{config.home / '.t3/userdata/statev2.sqlite'}?mode=ro", uri=True)) as connection:
            studio["chat-project"] = connection.execute("SELECT 1 FROM projection_projects WHERE workspace_root=? AND deleted_at IS NULL", (str(config.chat_project()),)).fetchone() is not None
    except sqlite3.Error:
        studio["chat-project"] = False
    old_releases = {"studio": old}
    heads = {"studio": studio_head}
    histories = {"studio": studio_history}
    evidence["studioLiveHistory"] = studio_live
    pressure = {"studioLoad": os.getloadavg()[0], "studioCpus": os.cpu_count()}
    from .release_host_readiness import probe_host

    evidence["pressure"] = pressure
    value = {"checks": checks, "hostChecks": host_checks, "evidence": evidence, "engine": engine,
             "oldReleases": old_releases, "servingHeads": heads, "servingHistories": histories, "servingHead": studio_head}
    for host in LINUX_TARGETS:
        probe_host(config, log, host, value)
    failed = sorted(name for name, ok in checks.items() if not ok)
    value = {"ok": not failed, "failed": failed, "checks": checks, "hostChecks": host_checks, "evidence": evidence, "engine": engine,
             "topicShas": topics, "baseHead": base_head, "servingHead": studio_head, "baseHistory": history,
             "oldReleases": old_releases, "servingHeads": heads, "servingHistories": histories,
             "seconds": round(time.monotonic() - started, 3)}
    Path(config.run).mkdir(parents=True, exist_ok=True)
    (Path(config.run) / "readiness.json").write_text(json.dumps(value, indent=2) + "\n")
    log.write(json.dumps({"ok": value["ok"], "failed": failed}) + "\n")
    return 0 if not failed else 1
