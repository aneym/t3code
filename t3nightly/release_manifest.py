import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .release_assemble import PACKAGE_FILES


CANDIDATE_SCHEMA = "t3nightly.candidate/1"
TARGETS = {"studio": ("darwin", "arm64"), "ax42": ("linux", "x64")}
MIGRATIONS_FILE = "apps/server/src/persistence/Migrations.ts"
MIGRATION_PATHS = (MIGRATIONS_FILE, "apps/server/src/persistence/Migrations/")
PERSISTED_STATE_PATHS = ("apps/server/src/persistence/",)
NIGHTLY_TAGS = "v*-nightly.*"
VERSION = re.compile(r"(\d+\.\d+\.\d+-nightly\.\d+\.\d+)\.aneym\.\d+")
ENTRY = re.compile(r"\[(\d+),\s*\"([^\"]+)\",\s*(Migration\d+)\]")
IMPORT = re.compile(r"import (Migration\d+) from \"\./(Migrations/[^\"]+)\"")
UNHASHED = ("__pycache__", ".pyc")


def blobs(tree, ref, paths):
    out = subprocess.run(["git", "-C", str(tree), "cat-file", "--batch"], input="".join(f"{ref}:{path}\n" for path in paths).encode(),
                         capture_output=True, check=True).stdout
    bodies, at = [], 0
    for path in paths:
        end = out.index(b"\n", at)
        header = out[at:end].split()
        if len(header) != 3:
            raise ValueError(f"{ref}:{path} is missing")
        size = int(header[2])
        bodies.append(out[end + 1:end + 1 + size])
        at = end + 2 + size
    return bodies


def git(repo, *args, env=None):
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True,
        env={**os.environ, **env} if env else None,
    ).stdout


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def archive_identity(engine):
    root = engine.parent
    files = sorted(
        path.relative_to(root).as_posix() for path in engine.rglob("*")
        if path.is_file() and not any(part in path.as_posix() for part in UNHASHED)
    )
    entries = [[path, hashlib.sha256((root / path).read_bytes()).hexdigest()] for path in files]
    stamp = root / ".engine-commit"
    return {
        "commit": stamp.read_text().strip() if stamp.is_file() else "",
        "dirty": False,
        "path": engine.relative_to(root).as_posix(),
        "files": len(entries),
        "digest": digest(entries),
    }


def engine_identity(engine=Path(__file__).resolve().parent):
    engine = Path(engine).resolve()
    if not (engine.parent / ".git").exists():
        return archive_identity(engine)
    root = Path(git(engine, "rev-parse", "--show-toplevel").strip())
    prefix = engine.relative_to(root).as_posix()
    files = sorted(
        path for path in git(root, "ls-files", "--cached", "--others", "--exclude-standard", "--", prefix).splitlines()
        if not any(part in path for part in UNHASHED) and (root / path).is_file()
    )
    entries = [[path, hashlib.sha256((root / path).read_bytes()).hexdigest()] for path in files]
    return {
        "commit": git(root, "rev-parse", "HEAD").strip(),
        "dirty": bool(git(root, "status", "--porcelain", "--", prefix).strip()),
        "path": prefix,
        "files": len(entries),
        "digest": digest(entries),
    }


def history_digest(pairs):
    return digest(sorted([int(number), str(name)] for number, name in pairs))


def migration_identity(tree, ref=None):
    def read(path):
        if ref:
            return git(tree, "show", f"{ref}:{path}")
        return (Path(tree) / path).read_text()

    source = read(MIGRATIONS_FILE)
    files = {name: path for name, path in IMPORT.findall(source)}
    entries = ENTRY.findall(source)
    paths = [f"apps/server/src/persistence/{files[symbol]}" for _, _, symbol in entries]
    bodies = blobs(tree, ref, paths) if ref else [read(path).encode() for path in paths]
    pairs = [[int(number), name] for number, name, _ in entries]
    contents = [[int(number), hashlib.sha256(body).hexdigest()] for (number, _, _), body in zip(entries, bodies)]
    if not pairs:
        raise ValueError(f"no migrations found in {MIGRATIONS_FILE}")
    return {
        "ids": [number for number, _ in pairs],
        "max": max(number for number, _ in pairs),
        "history": history_digest(pairs),
        "content": digest(sorted(contents)),
    }


def newest_tag(tree, commit):
    tags = git(tree, "tag", "--merged", commit, "--sort=-creatordate", "-l", NIGHTLY_TAGS).split()
    return tags[0] if tags else None


def source_identity(tree, head):
    dirty = sorted(line[3:] for line in git(tree, "status", "--porcelain", "--untracked-files=no").splitlines())
    stray = [path for path in dirty if path not in PACKAGE_FILES]
    if stray:
        raise ValueError(f"candidate tree has changes beyond version stamping: {', '.join(stray)}")
    for path in dirty:
        before = json.loads(git(tree, "show", f"HEAD:{path}"))
        after = json.loads((Path(tree) / path).read_text())
        before.pop("version", None)
        after.pop("version", None)
        if before != after:
            raise ValueError(f"{path} changes more than its version")
    with tempfile.TemporaryDirectory() as scratch:
        index = Path(scratch) / "index"
        shutil.copyfile(Path(tree) / git(tree, "rev-parse", "--git-path", "index").strip(), index)
        env = {"GIT_INDEX_FILE": str(index)}
        git(tree, "add", "-u", env=env)
        stamped = git(tree, "write-tree", env=env).strip()
    return {
        "commit": head,
        "tree": git(tree, "rev-parse", f"{head}^{{tree}}").strip(),
        "stampedTree": stamped,
        "stampedFiles": dirty,
    }


def topics(tree, base, head):
    rows = []
    for line in git(tree, "log", "--first-parent", "--reverse", "--format=%H%x09%P%x09%s", f"{base}..{head}").splitlines():
        commit, parents, subject = line.split("\t", 2)
        parents = parents.split()
        if len(parents) > 1:
            branch = next((word.strip("'\"").removeprefix("origin/") for word in subject.split() if "aneym/" in word), None)
            rows.append({"kind": "merge", "branch": branch, "sha": parents[1], "commit": commit})
        else:
            rows.append({"kind": "commit", "sha": commit, "subject": subject})
    return rows


def compatibility(tree, base, head):
    changed = git(tree, "diff", "--name-only", base, head).splitlines()
    migrations = [path for path in changed if path.startswith(MIGRATION_PATHS)]
    persisted = [path for path in changed if path.startswith(PERSISTED_STATE_PATHS) and path not in migrations]
    base_tag, head_tag = newest_tag(tree, base), newest_tag(tree, head)
    rebased = git(tree, "tag", "--merged", head, "--no-merged", base, "-l", NIGHTLY_TAGS).split()
    old, new = migration_identity(tree, base), migration_identity(tree, head)
    reasons = []
    if migrations or old["history"] != new["history"] or old["content"] != new["content"]:
        reasons.append("migrations-changed")
    if persisted:
        reasons.append("persisted-state-changed")
    if rebased:
        reasons.append("upstream-rebase")
    return {
        "baseMigrations": old,
        "candidateMigrations": new,
        "changedFiles": len(changed),
        "migrationFiles": migrations,
        "persistedStateFiles": persisted,
        "upstreamTag": {"base": base_tag, "candidate": head_tag, "newlyMerged": rebased},
        "persistedState": "compatible" if not (migrations or persisted) else "unproved",
        "binaryRollback": not reasons,
        "fastPath": {"eligible": not reasons, "reasons": reasons},
    }


def identity_digest(manifest):
    return digest({key: value for key, value in manifest.items() if key != "frozenAt"})


def freeze(tree, base, version, out, old_releases=None, engine=None):
    tree = Path(tree).resolve()
    match = VERSION.fullmatch(version)
    if not match:
        raise ValueError("version must be an upstream nightly plus .aneym.N")
    head = git(tree, "rev-parse", "HEAD^{commit}").strip()
    base_commit = git(tree, "rev-parse", f"{base}^{{commit}}").strip()
    if git(tree, "merge-base", base_commit, head).strip() != base_commit:
        raise ValueError(f"base {base} is not an ancestor of the candidate head")
    compat = compatibility(tree, base_commit, head)
    tag = compat["upstreamTag"]["candidate"]
    if tag != f"v{match.group(1)}":
        compat["fastPath"]["reasons"].append("version-tag-mismatch")
        compat["fastPath"]["eligible"] = False
    old_releases = old_releases or {}
    unknown = sorted(set(old_releases) - set(TARGETS))
    if unknown:
        raise ValueError(f"unknown target hosts: {', '.join(unknown)}")
    manifest = {
        "schema": CANDIDATE_SCHEMA,
        "version": version,
        "base": {"ref": base, "commit": base_commit, "upstreamTag": compat["upstreamTag"]["base"]},
        "source": source_identity(tree, head),
        "topics": topics(tree, base_commit, head),
        "engine": engine_identity(engine) if engine else engine_identity(),
        "targets": {
            host: {"platform": platform, "arch": arch, "oldRelease": old_releases.get(host)}
            for host, (platform, arch) in TARGETS.items()
        },
        "compatibility": compat,
        "frozenAt": datetime.now(timezone.utc).isoformat(),
    }
    manifest["digest"] = identity_digest(manifest)
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    path = out / "candidate.json"
    if path.exists():
        existing = load(path)
        if existing["digest"] != manifest["digest"]:
            raise ValueError(f"{path} is frozen with digest {existing['digest']}; use a new output directory")
        return existing
    with path.open("x") as handle:
        handle.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


def load(path):
    manifest = json.loads(Path(path).read_text())
    if manifest.get("schema") != CANDIDATE_SCHEMA:
        raise ValueError(f"{path}: not a {CANDIDATE_SCHEMA} manifest")
    expected = identity_digest({key: value for key, value in manifest.items() if key != "digest"})
    if manifest.get("digest") != expected:
        raise ValueError(f"{path}: digest does not match its contents")
    return manifest
