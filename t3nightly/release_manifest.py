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
FORK_MIGRATIONS = "apps/server/src/persistence/ForkMigrations/"
FORK_REGISTRY = "apps/server/src/persistence/ForkMigrations.ts"
FORK_RECONCILE = "apps/server/src/persistence/reconcileForkMigrationIds.ts"
UNSAFE_SQL = re.compile(r"\b(?:ALTER|DROP|UPDATE|DELETE|INSERT|REPLACE|PRAGMA|VACUUM|ATTACH|TRIGGER|VIEW)\b", re.I)
ADDITIVE_SQL = re.compile(r"CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+ ON (?!(?i:effect_sql_migrations|aneym_fork_migrations)\b)\w+\(.*\)|CREATE TABLE IF NOT EXISTS aneym_\w+ \(.*\)", re.S)
RECONCILE_WHERE = re.compile(r"WHERE migration_id = (\d+) AND name = '\w+'")
REGISTRY_SQL = re.compile(r"(?<![/\w])sql(?![/\w])|unsafe|SqlClient|\.raw\b")
MIGRATION_LINE = re.compile(r'import \* as (?:Effect|SqlClient) from "effect/(?:Effect|sql/SqlClient)";|export default Effect\.gen\(function\* \(\) \{|const sql = yield\* SqlClient\.SqlClient;|yield\* sql``;?|\}\);')
FORK_IMPORT = re.compile(r'import (\w+) from "\./ForkMigrations/(\w+\.ts)";')
FORK_LOADER = re.compile(r"const loader = Migrator\.fromRecord\(\{(.*?)\}\);", re.S)
FORK_ENTRY = re.compile(r'\s*"(\d+_\w+)": (\w+),?')
FORK_REGISTRY_SHAPE = [
    'import * as Migrator from "effect/sql/Migrator";',
    'import * as Effect from "effect/Effect";',
    "const run = Migrator.make({});",
    "const loader = Migrator.fromRecord({});",
    'export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {',
    '  const executed = yield* run({ loader, table: "aneym_fork_migrations" });',
    "  if (executed.length > 0) {",
    '    yield* Effect.log("Fork migrations ran successfully").pipe(',
    "      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),",
    "    );",
    "  }",
    "});",
]


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


def typescript(tree):
    common = Path(tree, git(tree, "rev-parse", "--git-common-dir").strip()).resolve().parent
    for root in (Path(tree), common):
        found = sorted(root.glob("node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/lib/typescript.js"))
        if found:
            return found[-1].resolve()
    return None


def ast_same(tree, base, head, path, mode):
    present = [subprocess.run(["git", "-C", str(tree), "cat-file", "-e", f"{ref}:{path}"], capture_output=True, check=False).returncode == 0 for ref in (base, head)]
    compiler = typescript(tree)
    if not all(present) or compiler is None:
        return False
    before = git(tree, "show", f"{base}:{path}")
    after = git(tree, "show", f"{head}:{path}")
    if before == after:
        return False
    with tempfile.TemporaryDirectory() as scratch:
        old, new = Path(scratch, "before.ts"), Path(scratch, "after.ts")
        old.write_text(before)
        new.write_text(after)
        result = subprocess.run(["node", str(Path(__file__).with_name("ast_compare.cjs")), str(compiler), mode, str(old), str(new)], capture_output=True, text=True, timeout=60, check=False)
    return result.returncode == 0 and result.stdout == "same"


def edits(tree, base, head, path):
    changed, hunk = [], False
    for line in git(tree, "diff", "-U0", base, head, "--", path).splitlines():
        if line.startswith("@@"):
            hunk = True
        elif hunk and line[:1] in "+-" and line[1:].strip():
            changed.append((line[0], line[1:].strip()))
        elif hunk and line[:1] not in "+- \\":
            hunk = False
    return changed


def additive_migration(source):
    statements = [" ".join(part.split()) for body in re.findall(r"sql`(.*?)`", source, re.S) for part in body.split(";") if part.strip()]
    rest = [line.strip() for line in re.sub(r"sql`.*?`", "sql``", source, flags=re.S).splitlines() if line.strip()]
    return bool(statements) and "${" not in source and "\\" not in source and not UNSAFE_SQL.search(source) and all(ADDITIVE_SQL.fullmatch(statement) for statement in statements) and all(MIGRATION_LINE.fullmatch(line) for line in rest)


def reconcile_cleanup(changed, ceiling):
    if any(sign != "+" for sign, _ in changed):
        return False
    lines = [line for _, line in changed]
    if len(lines) % 4:
        return False
    for index in range(0, len(lines), 4):
        opening, delete, where, closing = lines[index:index + 4]
        match = RECONCILE_WHERE.fullmatch(where)
        if opening != "yield* sql`" or delete != "DELETE FROM effect_sql_migrations" or closing != "`;" or not match or int(match[1]) <= ceiling:
            return False
    return True


def unchanged(tree, base, head, path):
    refs = [subprocess.run(["git", "-C", str(tree), "rev-parse", "--verify", "--quiet", f"{ref}:{path}"], capture_output=True, text=True, check=False).stdout.strip() for ref in (base, head)]
    return bool(refs[0]) and refs[0] == refs[1]


def fork_registry(tree, base, head, paths, registry):
    loader = FORK_LOADER.search(registry)
    if not loader:
        return False
    entries = [(match[1], match[2]) for match in FORK_ENTRY.finditer(loader[1])]
    keys, names = [key for key, _ in entries], [name for _, name in entries]
    if FORK_ENTRY.sub("", loader[1]).strip():
        return False
    imported, shape = [], []
    for line in FORK_LOADER.sub("const loader = Migrator.fromRecord({});", registry).splitlines():
        match = FORK_IMPORT.fullmatch(line)
        if match:
            imported.append((match[1], FORK_MIGRATIONS + match[2]))
        elif line.strip():
            shape.append(line)
    imports = dict(imported)
    if shape != FORK_REGISTRY_SHAPE or sorted(names) != sorted(imports) or len(imports) != len(imported) or len(set(names)) != len(names) or len({int(key.split("_", 1)[0]) for key in keys}) != len(keys) or len(set(imports.values())) != len(imports):
        return False
    return all(target in paths or unchanged(tree, base, head, target) for target in imports.values())


def fork_additive(tree, base, head, paths, old, new):
    if old["history"] != new["history"] or old["content"] != new["content"] or not paths:
        return False
    status = dict(reversed(line.split("\t", 1)) for line in git(tree, "diff", "--name-status", "--no-renames", base, head, "--", *paths).splitlines())
    for path in paths:
        changed = edits(tree, base, head, path)
        if path.startswith(FORK_MIGRATIONS):
            if status.get(path) != "A" or not additive_migration(git(tree, "show", f"{head}:{path}")):
                return False
        elif path == FORK_REGISTRY:
            if any(REGISTRY_SQL.search(line) or UNSAFE_SQL.search(line) for _, line in changed) or not fork_registry(tree, base, head, paths, git(tree, "show", f"{head}:{path}")):
                return False
        elif path == MIGRATIONS_FILE:
            if not ast_same(tree, base, head, path, "hook"):
                return False
        elif path == FORK_RECONCILE:
            if not reconcile_cleanup(changed, old["max"]):
                return False
        else:
            return False
    return True


def compatibility(tree, base, head):
    changed = git(tree, "diff", "--name-only", base, head).splitlines()
    migrations = [path for path in changed if path.startswith(MIGRATION_PATHS)]
    persisted = [path for path in changed if path.startswith(PERSISTED_STATE_PATHS) and path not in migrations]
    connection = [path for path in persisted if ast_same(tree, base, head, path, "pragma")]
    persisted = [path for path in persisted if path not in connection]
    old, new = migration_identity(tree, base), migration_identity(tree, head)
    additive = fork_additive(tree, base, head, migrations + persisted, old, new)
    base_tag, head_tag = newest_tag(tree, base), newest_tag(tree, head)
    rebased = git(tree, "tag", "--merged", head, "--no-merged", base, "-l", NIGHTLY_TAGS).split()
    reasons = []
    if not additive and (migrations or old["history"] != new["history"] or old["content"] != new["content"]):
        reasons.append("migrations-changed")
    if persisted and not additive:
        reasons.append("persisted-state-changed")
    if rebased:
        reasons.append("upstream-rebase")
    return {
        "baseMigrations": old,
        "candidateMigrations": new,
        "changedFiles": len(changed),
        "migrationFiles": migrations,
        "persistedStateFiles": persisted,
        "connectionOnlyFiles": connection,
        "upstreamTag": {"base": base_tag, "candidate": head_tag, "newlyMerged": rebased},
        "persistedState": "fork-additive" if additive else "compatible" if not (migrations or persisted) else "unproved",
        "rollbackProof": "required" if additive else "not-required",
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
