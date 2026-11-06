import json
import os
import shutil
import sqlite3
import subprocess
import time
import urllib.request
from contextlib import closing

from .release_host_readiness import probe_host, serving_head, source_history
from .release_manifest import contained, engine_identity, history_digest
from .release_readiness_store import atomic_write, readiness_lock
from .release_targets import LINUX_TARGETS


FLOORS = {"/Volumes/StudioExt": 20 * 1024**3, "/": 25 * 1024**3}


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


def contains(repo, ancestor, commit):
    return bool(ancestor and commit) and contained(repo, ancestor, commit)


def live_history(path):
    try:
        with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as connection:
            return history_digest(connection.execute("SELECT migration_id, name FROM effect_sql_migrations"))
    except sqlite3.Error:
        return None


def readiness(config, log):
    with readiness_lock(config.run) as path:
        return collect_readiness(config, log, path)


def collect_readiness(config, log, readiness_path):
    started = time.monotonic()
    checks, evidence, host_checks = {}, {}, {"studio": {}}
    engine = engine_identity(config.tools)
    checks["engine-clean"] = not engine["dirty"]
    topics = [resolve_topic(config.repo, name) for name in config.topic.split(",")]
    checks["topic-resolves"] = all(topics)
    old = serving_version()
    studio_head = serving_head(config, old, "studio")
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
    evidence["pressure"] = pressure
    value = {"checks": checks, "hostChecks": host_checks, "evidence": evidence, "engine": engine,
             "oldReleases": old_releases, "servingHeads": heads, "servingHistories": histories, "servingHead": studio_head}
    deferred = {host: config.defer_reason for host in config.defer_hosts}
    for host in LINUX_TARGETS:
        if host in deferred:
            log.write(f"readiness skip: {host} deferred ({config.defer_reason})\n")
            continue
        probe_host(config, log, host, value)
    failed = sorted(name for name, ok in checks.items() if not ok)
    value = {"ok": not failed, "failed": failed, "checks": checks, "hostChecks": host_checks, "evidence": evidence, "engine": engine,
             "topicShas": topics, "baseHead": base_head, "servingHead": studio_head, "baseHistory": history,
             "oldReleases": old_releases, "servingHeads": heads, "servingHistories": histories,
             **({"deferredHosts": deferred} if deferred else {}),
             "seconds": round(time.monotonic() - started, 3)}
    atomic_write(readiness_path, (json.dumps(value, indent=2) + "\n").encode())
    log.write(json.dumps({"ok": value["ok"], "failed": failed}) + "\n")
    return 0 if not failed else 1
