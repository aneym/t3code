import json
import os
import shutil
import sqlite3
import subprocess
import time
import urllib.request
from contextlib import closing

from .release_host_readiness import probe_host, source_history
from .release_ledger import LedgerRefusal, read as read_ledger, release_head
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


def fetch_origin(repo, log):
    result = subprocess.run(["git", "-C", str(repo), "fetch", "--tags", "origin"], capture_output=True, text=True, timeout=600, check=False)
    if result.returncode:
        log.write(f"origin fetch failed: {result.stderr.strip()[-500:]}\n")
    return result.returncode == 0


def newest_head(repo, heads):
    distinct = list(dict.fromkeys(heads))
    if not distinct or not all(distinct):
        return None
    return next((head for head in distinct if all(contains(repo, other, head) for other in distinct)), None)


def readiness(config, log):
    with readiness_lock(config.run) as path:
        return collect_readiness(config, log, path)


def studio_readiness(config, value):
    checks, evidence = value["checks"], value["evidence"]
    old = serving_version()
    head = release_head(value["ledger"], old)
    history = source_history(config.repo, head)
    live = live_history(config.home / ".t3/userdata/statev2.sqlite")
    evidence.update(studioServing=old, studioServingHead=head, studioLiveHistory=live)
    checks["studio-release-row"] = bool(head)
    checks["studio-base-assembly"] = bool(old and head and history)
    checks["studio-live-history"] = bool(history and live == history)
    studio = value["hostChecks"]["studio"] = {}
    studio["not-held"] = not config.held
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
    value["oldReleases"]["studio"], value["servingHeads"]["studio"], value["servingHistories"]["studio"] = old, head, history
    evidence["pressure"].update(studioLoad=os.getloadavg()[0], studioCpus=os.cpu_count())


def collect_readiness(config, log, readiness_path):
    started = time.monotonic()
    checks, evidence = {}, {"pressure": {}}
    engine = engine_identity(config.tools)
    checks["engine-clean"] = not engine["dirty"]
    checks["origin-fetch"] = fetch_origin(config.repo, log)
    topics = [resolve_topic(config.repo, name) for name in config.topic.split(",")]
    checks["topic-resolves"] = all(topics)
    try:
        ledger = read_ledger(config.repo)
        evidence["ledger"] = ledger["commit"]
    except LedgerRefusal as error:
        ledger = None
        evidence["ledgerError"] = str(error)
        log.write(f"{error}\n")
    checks["release-ledger"] = ledger is not None
    value = {"checks": checks, "hostChecks": {}, "evidence": evidence, "engine": engine, "ledger": ledger,
             "oldReleases": {}, "servingHeads": {}, "servingHistories": {}}
    deferred = {host: config.defer_reason for host in config.defer_hosts}
    for host in ("studio", *LINUX_TARGETS):
        if host in deferred:
            log.write(f"readiness skip: {host} deferred ({config.defer_reason})\n")
        elif host == "studio":
            studio_readiness(config, value)
        else:
            probe_host(config, log, host, value)
    heads = value["servingHeads"]
    serving = newest_head(config.repo, heads.values())
    checks["serving-heads-ordered"] = bool(serving)
    base_head = serving
    if config.base and serving:
        chosen = subprocess.run(["git", "-C", str(config.repo), "rev-parse", f"{config.base}^{{commit}}"], capture_output=True, text=True, check=False).stdout.strip()
        checks["base-contains-serving"] = bool(chosen) and contains(config.repo, serving, chosen)
        base_head = chosen or None
    history = source_history(config.repo, base_head)
    checks["base-history"] = bool(history)
    checks["base-contains-nightly"] = contains(config.repo, f"v{config.nightly}", base_head)
    evidence["servingHead"] = serving
    failed = sorted(name for name, ok in checks.items() if not ok)
    value = {"ok": not failed, "failed": failed, "checks": checks, "hostChecks": value["hostChecks"], "evidence": evidence, "engine": engine,
             "topicShas": topics, "baseHead": base_head, "servingHead": serving, "baseHistory": history,
             "oldReleases": value["oldReleases"], "servingHeads": heads, "servingHistories": value["servingHistories"],
             **({"deferredHosts": deferred} if deferred else {}),
             "seconds": round(time.monotonic() - started, 3)}
    atomic_write(readiness_path, (json.dumps(value, indent=2) + "\n").encode())
    log.write(json.dumps({"ok": value["ok"], "failed": failed}) + "\n")
    return 0 if not failed else 1
