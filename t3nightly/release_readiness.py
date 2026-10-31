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
from .release_manifest import engine_identity, history_digest, migration_identity


FLOORS = {"/Volumes/StudioExt": 20 * 1024**3, "/": 25 * 1024**3}
REMOTE_FLOOR = 25 * 1024**3
REMOTE_PROBE = r'''
import json, os, shutil, sqlite3, sys, urllib.request
from contextlib import closing
from pathlib import Path
tools, seeds, version, chat = sys.argv[1:5]
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
    return json.loads(assembly.read_text())["head"] if version and assembly else None


def contains(repo, ancestor, commit):
    return bool(ancestor and commit) and subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", ancestor, commit], capture_output=True, check=False).returncode == 0


def remote_probe(config, log):
    words = ["ssh", "-oBatchMode=yes", "-oConnectTimeout=5", config.linux_host, "python3", "-", config.remote_tools, SEEDS, config.version, CHAT_PROJECT]
    result = subprocess.run(words, input=REMOTE_PROBE, capture_output=True, text=True, timeout=25, check=False)
    if result.returncode:
        log.write(result.stderr)
        return {}
    return json.loads(result.stdout)


def readiness(config, log):
    started = time.monotonic()
    checks, evidence = {}, {}
    engine = engine_identity(config.tools)
    checks["engine-clean"] = not engine["dirty"]
    checks["not-held"] = not config.held
    topics = [resolve_topic(config.repo, name) for name in config.topic.split(",")]
    checks["topic-resolves"] = all(topics)
    old = serving_version()
    evidence["studioServing"] = old
    base_head = serving_head(config, old)
    checks["base-assembly"] = bool(base_head)
    evidence["servingHead"] = base_head
    if config.base and base_head:
        chosen = subprocess.run(["git", "-C", str(config.repo), "rev-parse", f"{config.base}^{{commit}}"], capture_output=True, text=True, check=False).stdout.strip()
        checks["base-contains-serving"] = contains(config.repo, base_head, chosen)
        base_head = chosen or None
    history = None
    if base_head:
        history = migration_identity(config.repo, base_head)["history"]
        checks["base-contains-nightly"] = contains(config.repo, f"v{config.nightly}", base_head)
    studio_history = migration_identity(config.repo, evidence["servingHead"])["history"] if evidence["servingHead"] else None
    try:
        with closing(sqlite3.connect(f"file:{config.seed(studio_history)}?mode=ro", uri=True)) as connection:
            checks["studio-seed"] = studio_history is not None and history_digest(connection.execute("SELECT migration_id, name FROM effect_sql_migrations")) == studio_history
    except sqlite3.Error:
        checks["studio-seed"] = False
    checks["studio-old-runtime"] = bool(old) and (config.home / ".t3/runtime/versions" / old / "t3").is_file()
    for path, floor in FLOORS.items():
        free = shutil.disk_usage(path).free
        evidence[f"free:{path}"] = free
        checks[f"disk:{path}"] = free >= floor
    for name in (".local/bin/claude", ".vite-plus/bin/vp", ".config/t3nightly/public-config.env"):
        checks[f"studio:{name}"] = (config.home / name).exists()
    try:
        with closing(sqlite3.connect(f"file:{config.home / '.t3/userdata/statev2.sqlite'}?mode=ro", uri=True)) as connection:
            checks["studio-chat-project"] = connection.execute("SELECT 1 FROM projection_projects WHERE workspace_root=? AND deleted_at IS NULL", (str(config.chat_project()),)).fetchone() is not None
    except sqlite3.Error:
        checks["studio-chat-project"] = False
    remote = remote_probe(config, log)
    evidence["ax42"] = remote
    checks["ax42-reachable"] = bool(remote)
    ax42_old = remote.get("serving") if remote.get("serving") not in (None, config.version) else old
    ax42_head = evidence["servingHead"] if ax42_old == old else serving_head(config, ax42_old)
    evidence["ax42ServingHead"] = ax42_head
    checks["ax42-base-assembly"] = bool(ax42_head)
    checks["base-contains-ax42-serving"] = contains(config.repo, ax42_head, base_head)
    ax42_history = migration_identity(config.repo, ax42_head)["history"] if ax42_head else None
    checks["ax42-engine"] = remote.get("engine") == engine["digest"]
    checks["ax42-seed"] = ax42_history is not None and remote.get("seedHistories", {}).get(ax42_history) == ax42_history
    checks["ax42-old-runtime"] = bool(ax42_old) and ax42_old in remote.get("runtimes", [])
    checks["ax42-not-held"] = remote.get("held") is False
    checks["ax42-disk"] = remote.get("disk", 0) >= REMOTE_FLOOR
    checks["ax42-chat-project"] = remote.get("chatProject") is True
    for name, present in remote.get("files", {}).items():
        checks[f"ax42:{name}"] = present
    evidence["pressure"] = {"studioLoad": os.getloadavg()[0], "studioCpus": os.cpu_count(), "ax42Load": remote.get("load"), "ax42Cpus": remote.get("cpus")}
    failed = sorted(name for name, ok in checks.items() if not ok)
    value = {"ok": not failed, "failed": failed, "checks": checks, "evidence": evidence, "engine": engine,
             "topicShas": topics, "baseHead": base_head, "servingHead": evidence["servingHead"], "baseHistory": history, "oldReleases": {"studio": old, "ax42": ax42_old},
             "servingHeads": {"studio": evidence["servingHead"], "ax42": ax42_head}, "servingHistories": {"studio": studio_history, "ax42": ax42_history},
             "seconds": round(time.monotonic() - started, 3)}
    Path(config.run).mkdir(parents=True, exist_ok=True)
    (Path(config.run) / "readiness.json").write_text(json.dumps(value, indent=2) + "\n")
    log.write(json.dumps({"ok": value["ok"], "failed": failed}) + "\n")
    return 0 if not failed else 1
