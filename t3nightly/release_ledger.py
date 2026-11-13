import json
import os
import subprocess
from datetime import datetime, timezone

LEDGER_BRANCH = "aneym/release-ledger"
LEDGER_FILE = "ledger.json"
LEDGER_SCHEMA = "t3nightly.release-ledger/1"
SEEN_REF = "refs/t3nightly/release-ledger"
FETCHED_REF = "refs/t3nightly/release-ledger-fetched"
CANDIDATE_PREFIX = "aneym/candidate"
IDENTITY = {f"GIT_{role}_{field}": value for role in ("AUTHOR", "COMMITTER")
            for field, value in (("NAME", "t3nightly release engine"), ("EMAIL", "t3nightly@users.noreply.github.com"))}


class LedgerRefusal(ValueError):
    pass


def without_commit_graph():
    os.environ.update(GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="core.commitGraph", GIT_CONFIG_VALUE_0="false")


def git(repo, *args, stdin=None, env=None, check=True):
    result = subprocess.run(["git", "-C", str(repo), *args], input=stdin, capture_output=True, text=True,
                            env={**os.environ, **env} if env else None, timeout=300, check=False)
    if check and result.returncode:
        raise LedgerRefusal(f"git {' '.join(args[:2])} failed in {repo}: {result.stderr.strip()[-300:]}")
    return result


def fetch(repo, remote="origin"):
    result = git(repo, "fetch", "--no-tags", remote, f"+refs/heads/{LEDGER_BRANCH}:{FETCHED_REF}", check=False)
    if result.returncode:
        raise LedgerRefusal(f"cannot fetch the release ledger {LEDGER_BRANCH} from {remote}: {result.stderr.strip()[-300:]}")
    fetched = git(repo, "rev-parse", FETCHED_REF).stdout.strip()
    seen = git(repo, "rev-parse", "--verify", "--quiet", SEEN_REF, check=False).stdout.strip()
    if seen and git(repo, "merge-base", "--is-ancestor", seen, fetched, check=False).returncode:
        raise LedgerRefusal(f"release ledger history was rewritten on {remote}: {fetched[:12]} does not descend from {seen[:12]}, "
                            "which this repo read before; ledger rows change only by new commits")
    git(repo, "update-ref", SEEN_REF, fetched)
    return fetched


def rows_at(repo, commit):
    body = git(repo, "cat-file", "blob", f"{commit}:{LEDGER_FILE}", check=False)
    if body.returncode:
        raise LedgerRefusal(f"release ledger {commit[:12]} has no {LEDGER_FILE}")
    try:
        value = json.loads(body.stdout)
    except ValueError as error:
        raise LedgerRefusal(f"release ledger {commit[:12]} is not JSON: {error}") from error
    rows = value.get("rows") if isinstance(value, dict) else None
    if not isinstance(value, dict) or value.get("schema") != LEDGER_SCHEMA or not isinstance(rows, list):
        raise LedgerRefusal(f"release ledger {commit[:12]} is not a {LEDGER_SCHEMA} file")
    if not rows:
        raise LedgerRefusal(f"release ledger {commit[:12]} is empty")
    return rows


def read(repo, remote="origin"):
    commit = fetch(repo, remote)
    return {"commit": commit, "rows": rows_at(repo, commit)}


def releases(ledger):
    return {row["version"]: row for row in (ledger or {}).get("rows", []) if row.get("kind") == "release"}


def release_head(ledger, version):
    row = releases(ledger).get(version) if version else None
    return row["head"] if row else None


def require_releases(ledger, versions):
    missing = sorted({version or "unknown" for version in versions} - releases(ledger).keys())
    if missing:
        raise LedgerRefusal(f"serving versions with no release row in ledger {ledger['commit'][:12]}: {', '.join(missing)}")


def lineage(ledger):
    entries = []
    for row in ledger["rows"]:
        if row.get("kind") == "release":
            entries.extend({"label": f"{row['version']} {name}", "any": [sha, row["head"]]} for name, sha in row["topics"])
        else:
            entries.append({"label": row["label"], "any": row["any"]})
    return entries


def commit_rows(repo, parent, rows, message):
    content = json.dumps({"schema": LEDGER_SCHEMA, "rows": rows}, indent=2, sort_keys=True) + "\n"
    blob = git(repo, "hash-object", "-w", "--stdin", stdin=content).stdout.strip()
    tree = git(repo, "mktree", stdin=f"100644 blob {blob}\t{LEDGER_FILE}\n").stdout.strip()
    return git(repo, "commit-tree", tree, "-m", message, *(["-p", parent] if parent else []), env=IDENTITY).stdout.strip()


def push(repo, commit, ref, remote):
    return git(repo, "push", "--porcelain", remote, f"{commit}:{ref}", check=False)


def seed(repo, rows, message, remote="origin"):
    if not rows:
        raise LedgerRefusal("a ledger seed needs at least one row")
    if git(repo, "ls-remote", "--exit-code", remote, f"refs/heads/{LEDGER_BRANCH}", check=False).returncode != 2:
        raise LedgerRefusal(f"{LEDGER_BRANCH} already exists on {remote} or {remote} is unreachable; a seed only starts a new ledger")
    commit = commit_rows(repo, None, rows, message)
    result = push(repo, commit, f"refs/heads/{LEDGER_BRANCH}", remote)
    if result.returncode:
        raise LedgerRefusal(f"ledger seed push refused: {result.stderr.strip()[-300:]}")
    return read(repo, remote)


def append(repo, change, message, remote="origin", attempts=4):
    error = ""
    for _ in range(attempts):
        ledger = read(repo, remote)
        rows = change(ledger["rows"])
        if rows is None:
            return ledger["commit"]
        commit = commit_rows(repo, ledger["commit"], rows, message)
        result = push(repo, commit, f"refs/heads/{LEDGER_BRANCH}", remote)
        if not result.returncode:
            git(repo, "update-ref", SEEN_REF, commit, ledger["commit"])
            return commit
        error = result.stderr.strip()[-300:]
    raise LedgerRefusal(f"ledger push refused {attempts} times: {error}")


def tree_of(repo, version, commit, remote):
    found = git(repo, "rev-parse", "--verify", "--quiet", f"{commit}^{{tree}}", check=False)
    if found.returncode:
        ref = candidate_ref(version, commit)
        git(repo, "fetch", "--no-tags", remote, f"+{ref}:{ref.replace('refs/heads/', 'refs/t3nightly/', 1)}", check=False)
        found = git(repo, "rev-parse", "--verify", "--quiet", f"{commit}^{{tree}}", check=False)
    return found.stdout.strip() if not found.returncode else None


def record_release(repo, version, head, base, topics, host, remote="origin"):
    row = {"kind": "release", "version": version, "head": head, "base": base, "topics": [list(pair) for pair in topics],
           "recordedBy": host, "recordedAt": datetime.now(timezone.utc).isoformat()}

    def change(rows):
        present = next((old for old in rows if old.get("kind") == "release" and old.get("version") == version), None)
        if not present:
            return [*rows, row]
        if present["head"] == head or any(entry["head"] == head for entry in present.get("sameTree", [])):
            return None
        recorded, candidate = tree_of(repo, version, present["head"], remote), tree_of(repo, version, head, remote)
        if not recorded or recorded != candidate:
            raise LedgerRefusal(f"ledger records {version} at {present['head'][:12]} (tree {(recorded or 'unreadable')[:12]}), not {head[:12]} (tree {(candidate or 'unreadable')[:12]})")
        entry = {"head": head, "base": base, "tree": candidate, "recordedBy": host, "recordedAt": row["recordedAt"]}
        return [{**old, "sameTree": [*old.get("sameTree", []), entry]} if old is present else old for old in rows]

    return append(repo, change, f"release {version} at {head[:12]}", remote)


def record_installed(config, log):
    assembly = json.loads((config.run / "assembly.json").read_text())
    try:
        commit = record_release(config.repo, config.version, assembly["head"], assembly["base"],
                                zip(assembly["topics"], assembly["topicShas"]), config.host)
    except LedgerRefusal as error:
        log.write(f"release ledger write failed after install: {error}\n")
        return 1
    log.write(f"release ledger {commit[:12]} records {config.version} at {assembly['head'][:12]}\n")
    return 0


def candidate_ref(version, head):
    return f"refs/heads/{CANDIDATE_PREFIX}/{version.rsplit('.', 1)[1]}-{head[:12]}"


def remote_sha(repo, ref, remote="origin"):
    words = git(repo, "ls-remote", remote, ref, check=False).stdout.split()
    return words[0] if words else None


def publish_candidate(repo, version, head, remote="origin"):
    ref = candidate_ref(version, head)
    result = push(repo, head, ref, remote)
    if result.returncode and remote_sha(repo, ref, remote) != head:
        raise LedgerRefusal(f"candidate push to {ref} refused: {result.stderr.strip()[-300:]}")
    return ref


def fetch_candidate(repo, assembly, remote="origin"):
    ref, head = assembly["candidateRef"], assembly["head"]
    local = ref.replace("refs/heads/", "refs/t3nightly/", 1)
    git(repo, "fetch", "--no-tags", remote, f"+{ref}:{local}")
    fetched = git(repo, "rev-parse", local).stdout.strip()
    if fetched != head:
        raise LedgerRefusal(f"{remote} {ref} is {fetched[:12]}, not the assembled head {head[:12]}")
    return head
