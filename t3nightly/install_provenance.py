import hashlib
import json
import os
import platform
import pwd
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

from .release_manifest import digest, engine_identity, history_digest, load
from .release_receipts import REHEARSAL_SCHEMA, parse, provenance


def file_digest(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def migration_history(run):
    with closing(sqlite3.connect(f"{run.db.resolve().as_uri()}?mode=ro", uri=True)) as connection:
        return history_digest(connection.execute("SELECT migration_id, name FROM effect_sql_migrations"))


def validate(run, previous, candidate):
    args = run.args
    manifest = load(args.manifest)
    if manifest["version"] != args.version:
        raise ValueError("candidate version mismatch")
    host = args.receipt_host or ("studio" if sys.platform == "darwin" else "ax42")
    expected = manifest["targets"][host]
    arch = {"aarch64": "arm64", "AMD64": "x64", "x86_64": "x64"}.get(platform.machine(), platform.machine())
    if (expected["platform"], expected["arch"]) != (sys.platform, arch):
        raise ValueError("candidate target does not match executing host")
    if engine_identity()["digest"] != manifest["engine"]["digest"]:
        raise ValueError("installer engine content changed since candidate freeze")
    observed = {"oldRuntime.digest": file_digest(run.runtime(previous)), "oldMigrationHistory": migration_history(run), "candidateRuntime.digest": file_digest(candidate), "artifactManifestDigest": ""}
    artifact = json.loads(Path(args.artifact_manifest).read_text())
    target = "darwin-arm64" if sys.platform == "darwin" else "linux-x64"
    archive = Path(args.assets) / f"t3-{args.version}-{target}.tar.gz"
    observed["artifactManifestDigest"] = digest({key: value for key, value in artifact.items() if key != "digest"})
    if artifact.get("digest") != observed["artifactManifestDigest"]:
        raise ValueError("artifact manifest content digest mismatch")
    if (artifact.get("schema"), artifact.get("kind"), artifact.get("release"), artifact.get("platform"), artifact.get("arch")) != ("t3nightly.artifact-manifest/1", "cli", args.version, sys.platform, arch):
        raise ValueError("artifact manifest target identity mismatch")
    if sys.platform == "darwin" and not all(artifact.get(key, {}).get("verified") is True for key in ("codesign", "notarization")):
        raise ValueError("artifact requires verified signing and notarization")
    if artifact["archive"]["sha256"] != file_digest(archive) or artifact["runtime"]["sha256"] != observed["candidateRuntime.digest"]:
        raise ValueError("artifact manifest archive/runtime digest mismatch")
    if not args.rehearsal and previous == args.version and observed["oldRuntime.digest"] == observed["candidateRuntime.digest"]:
        run.step("hard-already-current", version=previous, digest=observed["candidateRuntime.digest"])
        return manifest, None, host, observed
    if args.rehearsal:
        owner = Path(pwd.getpwuid(os.getuid()).pw_dir)
        live = (owner / ".t3").resolve()
        home = run.home.resolve()
        isolated = home != live and not home.is_relative_to(live) and not live.is_relative_to(home)
        if not isolated or not run.service_label.startswith(("com.agent-rails.", "com.t3-rehearsal.", "t3-rehearsal-")):
            raise ValueError("rehearsal bypass requires an isolated sandbox home and service")
        if not manifest["compatibility"]["fastPath"]["eligible"] and not args.compatibility_probe:
            raise ValueError("ineligible candidate requires isolated --compatibility-probe; not release evidence")
        if observed["oldMigrationHistory"] != manifest["compatibility"]["baseMigrations"]["history"]:
            raise ValueError("sandbox migration history differs from frozen base")
        return manifest, None, host, observed
    if not args.smoke_verdict:
        raise ValueError("hard install requires a passing e2e smoke verdict")
    smoke = json.loads(Path(args.smoke_verdict).read_text())
    if smoke.get("ok") is not True or (smoke.get("kind"), smoke.get("version"), smoke.get("archiveSha256")) != ("t3-smoke", args.version, artifact["archive"]["sha256"]):
        raise ValueError("e2e smoke verdict does not pass for this archive")
    run.step("hard-smoke-accepted", archive=smoke["archiveSha256"])
    receipt = parse(args.receipt)
    if receipt["schema"] != REHEARSAL_SCHEMA:
        raise ValueError("hard install requires a rehearsal receipt")
    reasons = provenance(receipt, manifest, host, observed=observed)
    if reasons:
        raise ValueError("rehearsal refused: " + "; ".join(reasons))
    if receipt["oldRuntime"]["version"] != previous:
        raise ValueError("old serving version differs from rehearsal")
    run.step("hard-receipt-accepted", digest=receipt["digest"], observed=observed)
    return manifest, receipt, host, observed
