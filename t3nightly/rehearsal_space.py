import json
import os
import tarfile
import zipfile
from pathlib import Path

from .snapshot_space import database_bytes


def rehearsal_bound(args):
    assets = Path(args.assets).resolve()
    manifest = json.loads(Path(args.candidate_manifest).read_text())
    version = manifest["version"]
    archive = assets / f"t3-{version}-darwin-arm64.tar.gz"
    desktop = assets.parent / "desktop" / f"T3-Code-{version}-arm64.zip"
    with tarfile.open(archive, "r:gz") as bundle:
        candidate = sum((entry.size + 4095) // 4096 * 4096 for entry in bundle if entry.isfile())
    with zipfile.ZipFile(desktop) as bundle:
        app = sum((entry.file_size + 4095) // 4096 * 4096 for entry in bundle.infolist())
    runtime_inputs = [Path(args.old_runtime)]
    for name in ("launcher_artifact", "old_launcher_artifact", "connector_artifact"):
        if raw := getattr(args, name, None):
            runtime_inputs.append(Path(json.loads(Path(raw).read_text())["runtimeDir"]))
    runtime = sum((path.stat().st_size + 4095) // 4096 * 4096 for tree in runtime_inputs for path in tree.rglob("*") if path.is_file())
    runtime_copies = {"version": 1, "launcherAndConnector": 1, "rollbackAndStaging": 1}
    baseline = sum(runtime_copies.values()) * (runtime + candidate)
    seed = database_bytes(args.seed)
    copies = {"seedSnapshots": 2, "writableDatabases": 2, "readSnapshots": 2, "prepareBackups": 2, "stoppedBackups": 2, "restoreCopies": 2}
    pinned = os.environ.get("T3NIGHTLY_GATE_SEED", "latest")
    if pinned == "latest":
        from .gate_seed import CACHE_ROOT, LATEST_MAX_AGE, cache_entries, seed_age

        gate = next((path for path in cache_entries(CACHE_ROOT) if (path / "userdata/statev2.sqlite").is_file() and (path / "seed.json").is_file() and 0 <= seed_age(path) < LATEST_MAX_AGE), None)
    else:
        gate = Path(pinned).expanduser().resolve()
    live = Path.home() / ".t3/userdata/statev2.sqlite"
    em_seed = database_bytes(gate / "userdata/statev2.sqlite" if gate else live)
    if not em_seed:
        raise ValueError("Studio rehearsal admission has no measurable EM seed")
    em_copies = {"liveSnapshot": int(gate is None), "cacheBuild": int(gate is None), "smokeCopy": 1}
    peak = seed * sum(copies.values()) + em_seed * sum(em_copies.values()) + 2 * baseline + candidate + app
    return {"houseFloorBytes": 40 * 1024**3, "seedBytes": seed, "seedCopies": copies, "seedWriteBytes": seed * sum(copies.values()), "emSeedBytes": em_seed, "emSeedCopies": em_copies, "emSeedWriteBytes": em_seed * sum(em_copies.values()), "emSeed": str(gate or live), "runtimeCopiesPerHome": runtime_copies, "homeBaselineBytes": baseline, "homes": 2, "runtimeInputBytes": runtime, "candidateBytes": candidate, "emRuntimeBytes": candidate, "desktopExtractedBytes": app, "desktopArtifact": str(desktop), "peakBytes": peak, "marginBytes": 2 * 1024**3, "requiredBytes": 42 * 1024**3 + peak}
