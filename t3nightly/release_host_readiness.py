import json
import subprocess

from .release_config import CHAT_PROJECT
from .release_manifest import migration_identity
from .release_targets import LINUX_TARGETS
from .serving_assembly import serving_assembly_head
from .remote_shell import ssh_argv


REMOTE_FLOOR = 25 * 1024**3
REMOTE_PROBE = r'''
import json, os, shutil, sqlite3, sys, urllib.request
from contextlib import closing
from pathlib import Path
tools, version, chat, remote_run, host = sys.argv[1:6]
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
    try:
        from t3nightly.serving_assembly import serving_assembly_head
        row["head"] = next((head for runs in (root / row["serving"], home / ".t3nightly/runs" / row["serving"]) if (head := serving_assembly_head(runs, host, row["serving"]))), None)
    except Exception:
        row["head"] = None
row["liveHistory"] = None
try:
    with closing(sqlite3.connect(f"file:{home / '.t3/userdata/statev2.sqlite'}?mode=ro", uri=True)) as connection:
        from t3nightly.release_manifest import history_digest
        row["liveHistory"] = history_digest(connection.execute("SELECT migration_id, name FROM effect_sql_migrations"))
except Exception:
    pass
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


def serving_head(config, version, host):
    return serving_assembly_head(config.home / ".t3nightly/runs" / str(version), host, version) if version else None


def remote_probe(config, log, host="ax42"):
    words = [*ssh_argv(LINUX_TARGETS[host], '-oConnectTimeout=5'), "python3", "-", config.remote_tools, config.version, CHAT_PROJECT, config.remote_run, host]
    try:
        result = subprocess.run(words, input=REMOTE_PROBE, capture_output=True, text=True, timeout=25, check=False)
        if result.returncode:
            log.write(result.stderr)
            return {}
        value = json.loads(result.stdout)
        return value if isinstance(value, dict) else {}
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


def probe_host(config, log, host, value, *, require_result=False):
    remote = remote_probe(config, log, host)
    if require_result and not remote:
        raise ValueError(f"{host}: readiness probe failed; previous evidence preserved")
    old = remote.get("serving")
    head = remote.get("head") or serving_head(config, old, host)
    if not head and old and old == value["oldReleases"]["studio"]:
        head = value["servingHead"]
    history = source_history(config.repo, head)
    value["oldReleases"][host] = old
    value["servingHeads"][host] = head
    value["servingHistories"][host] = history
    value["evidence"][host] = remote
    value["evidence"][f"{host}ServingHead"] = head
    value["checks"][f"{host}-base-assembly"] = bool(old and head and history)
    value["checks"][f"{host}-live-history"] = bool(history and remote.get("liveHistory") == history)
    value["checks"][f"{host}-engine"] = remote.get("engine") == value["engine"]["digest"]
    checks = value["hostChecks"][host] = {
        "reachable": bool(remote),
        "old-runtime": bool(old) and old in remote.get("runtimes", []),
        "not-held": remote.get("held") is False,
        "disk": remote.get("disk", 0) >= REMOTE_FLOOR,
        "chat-project": remote.get("chatProject") is True,
    }
    for name in (".local/bin/claude", ".vite-plus/bin/vp", ".cargo/bin/cargo", ".config/t3nightly/public-config.env", CHAT_PROJECT):
        checks[name] = remote.get("files", {}).get(name) is True
    value["evidence"]["pressure"][f"{host}Load"] = remote.get("load")
    value["evidence"]["pressure"][f"{host}Cpus"] = remote.get("cpus")
