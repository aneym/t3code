import hashlib
import json
import plistlib
from pathlib import Path

from .build_artifacts import load as load_artifact
from .install_offbox import METHOD as OFFBOX_METHOD
from . import offbox_digest
from .release_approval import approved
from .release_graph import SUCCESS_OUTCOMES
from .release_manifest import TARGETS, digest, eligible, load
from .release_targets import LINUX_TARGETS, stage_action, stage_target
from .release_publish_stage import validate as validate_staged
from .release_receipts import INSTALL_SCHEMA, parse, provenance
from .release_continuation import require_studio_proof
from .release_timeline import latest_rows
from .release_signatures import verify_archive, verify_desktop_zip
from .release_transport import ssh
from .release_windows import WINDOWS_STAGES, windows_output


def exists(config, name):
    if name == "assemble":
        return config.candidate.is_dir() and (config.run / "assembly.json").is_file()
    if name == "mac-cli":
        archive = config.run / config.archive("darwin-arm64")
        if not archive.is_file() or not config.tree("mac-cli").is_dir():
            return False
        verify_archive(archive)
        return True
    if name == "linux-cli":
        return (config.run / config.archive("linux-x64")).is_file()
    if name == "desktop":
        directory = config.run / "desktop"
        archive = f"T3-Code-{config.version}-arm64.zip"
        if not all((directory / file).is_file() for file in (archive, f"{archive}.blockmap", "nightly-mac.yml")):
            return False
        verify_desktop_zip(directory / archive)
        return True
    if name == "gate":
        verdict = config.run / "gate/verdict.json"
        suite = config.run / "suite/suite.jsonl"
        if not verdict.is_file() or not suite.is_file():
            return False
        rows = [json.loads(line) for line in suite.read_text().splitlines()]
        return json.loads(verdict.read_text()).get("ok") is True and bool(rows) and all(not row.get("exit", 0) for row in rows)
    if name == "stage-review":
        return any((config.run / "shots").glob("*.png"))
    if name == "awaiting-verdict":
        return approved(config) and (config.run / "SHA256SUMS").is_file()
    if name == "studio-continuation-proof":
        require_studio_proof(config)
        return True
    if name in ("install-ax42", "install-studio"):
        directory = "ax42-install" if name == "install-ax42" else "studio-install"
        path = config.run / directory / "last.json"
        if not path.is_file():
            return False
        report = json.loads(path.read_text())
        return report.get("target") == config.version and report.get("outcome") in ("installed", "current")
    if name == "seed-remote-runtimes":
        return False
    if name == "desktop-swap":
        import plistlib

        path = Path("/Applications/T3 Dev.app/Contents/Info.plist")
        if not path.is_file():
            return False
        with path.open("rb") as handle:
            return plistlib.load(handle).get("CFBundleShortVersionString") == config.version
    if name == "publish-feed":
        path = config.feed / "releases.json"
        return path.is_file() and any(row["version"] == config.version for row in json.loads(path.read_text())["releases"])
    return False


def completed(config, graph):
    rows = latest_rows(config.run / "timeline.jsonl")
    done = set()
    for stage in graph:
        row = rows.get(stage.name, {})
        if row.get("exit") == 0 and all(parent in done for parent in stage.needs) and valid_output(config, stage.name):
            done.add(stage.name)
    return done


def remote_archive_exists(config, log):
    return ssh(["test", "-f", f"{config.remote_run}/{config.archive('linux-x64')}"], log, config.linux_host) == 0


def valid_output(config, name):
    try:
        return exists(config, name)
    except (OSError, ValueError, KeyError, TypeError):
        return False


def sha256(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def fast_artifact(path, version, key, kind="cli"):
    value = load_artifact(Path(path))
    platform, arch = key.split("-")
    if (value["kind"], value["release"], value["platform"], value["arch"]) != (kind, version, platform, arch):
        raise ValueError(f"{path}: artifact identity mismatch")
    if platform == "darwin" and not (value["codesign"]["verified"] and value["notarization"]["verified"]):
        raise ValueError(f"{path}: Mac artifact is not signed and notarized")
    return value


def fast_install(path, manifest, artifact, host):
    receipt = parse(path)
    if receipt["schema"] != INSTALL_SCHEMA:
        raise ValueError(f"{path}: not an install receipt")
    current = receipt.get("outcome") == "current"
    observed = {"artifactManifestDigest": artifact["digest"], "servingRuntime.digest": artifact["runtime"]["sha256"]}
    reasons = provenance(receipt, manifest, host, observed=observed)
    if receipt["servingRuntime"]["version"] != manifest["version"]:
        reasons.append(f"serving {receipt['servingRuntime']['version']}, not {manifest['version']}")
    if current:
        reasons = [reason for reason in reasons if not reason.startswith("oldRuntime.version:")]
        if receipt["oldRuntime"] != {"version": manifest["version"], "digest": artifact["runtime"]["sha256"]}:
            reasons.append("current install was not already serving the exact candidate runtime")
    if reasons:
        raise ValueError(f"{path}: " + "; ".join(reasons))
    return receipt


def condition_met(condition, compatibility, install):
    copy, local = install["eligibility"].get("restoreCopy") or {}, install["backup"].get("local") or {}
    if condition == "offbox":
        backup = install["backup"]
        seeded = backup.get("seed") or {}
        deferred = backup.get("replica") != "deferred" or (bool(seeded.get("clonedFrom") or seeded.get("existing")) and (seeded.get("verified") or {}).get("quickCheck") == "ok")
        return backup.get("method") == OFFBOX_METHOD and bool(backup.get("remote")) and deferred
    if condition == "offbox-stopped-ship":
        backup = install["backup"]
        return backup.get("method") == OFFBOX_METHOD and backup.get("stoppedShip") is True and backup.get("quickCheck") == "ok" and offbox_digest.valid(backup.get("sha256")) and bool(backup.get("remote")) and not backup.get("local")
    if condition == "local-restore-copy":
        return copy.get("quickCheck") == "ok" and bool(copy.get("identity")) and bool(copy.get("path")) and bool(copy.get("sha256")) and all(copy.get(key) == local.get(key) for key in ("path", "identity", "sha256", "quickCheck"))
    if condition == "drain-then-hard":
        return (install.get("hotSwap") or {}).get("method") == "maintenance" and (install.get("restartDrain") or {}).get("drained") is True and install.get("migrationHistory") == {"before": compatibility["baseMigrations"]["history"], "candidate": compatibility["candidateMigrations"]["history"]}
    return False


def eligibility_evidence(manifest, host, install):
    compatibility = manifest["targets"][host]["compatibility"]
    recorded = install["eligibility"]
    expected = compatibility.get("eligibility")
    if expected is None or recorded.get("class") != expected:
        raise ValueError(f"{host}: install eligibility {recorded.get('class')} is not the manifest class {expected}")
    if install["outcome"] == "current":
        return {"class": expected, "restoreCopy": None, "conditions": {}}
    conditions = {}
    for condition in compatibility["fastPath"]["conditions"]:
        conditions[condition] = condition_met(condition, compatibility, install)
        if not conditions[condition]:
            raise ValueError(f"{host}: {expected} install does not meet its {condition} condition")
    return {"class": expected, "restoreCopy": recorded.get("restoreCopy"), "conditions": conditions}


def host_evidence(run, version, host, build):
    key = "darwin-arm64" if host == "studio" else "linux-x64"
    own = build / "candidate.json"
    manifest = load(own if host in LINUX_TARGETS and own.is_file() else run / "candidate.json")
    artifact = fast_artifact(build / f"artifact-{key}.json", version, key)
    archive = build / f"t3-{version}-{key}.tar.gz"
    if sha256(archive) != artifact["archive"]["sha256"]:
        raise ValueError(f"{archive}: bytes differ from the artifact manifest")
    receipts = build if host in LINUX_TARGETS else run / "receipts"
    return manifest, artifact, receipts


def fast_swap_ready(run, version, archive):
    manifest, artifact, receipts = host_evidence(run, version, "studio", run / "mac")
    install = fast_install(receipts / "install-studio.json", manifest, artifact, "studio")
    desktop = fast_artifact(run / "desktop/artifact-desktop-darwin-arm64.json", version, "darwin-arm64", "desktop")
    if sha256(archive) != desktop["archive"]["sha256"]:
        raise ValueError(f"{archive}: desktop bytes differ from the desktop manifest")
    return {"install": install["digest"], "desktop": desktop["digest"]}


def release_identity(manifest):
    source = {key: value for key, value in manifest["source"].items() if key != "commit"}
    topics = [{key: value for key, value in topic.items() if key != "commit"} for topic in manifest["topics"]]
    rest = {key: value for key, value in manifest.items() if key not in ("digest", "frozenAt", "engine", "source", "topics")}
    return {**rest, "source": source, "topics": topics}


def deferred_hosts(run):
    records = []
    for name in ("fast-inputs.json", "readiness.json"):
        path = Path(run) / name
        if path.is_file():
            value = json.loads(path.read_text())
            if not isinstance(value, dict):
                raise ValueError(f"{name} is not a JSON object")
            hosts = value.get("deferredHosts", {})
            if not isinstance(hosts, dict) or any(host not in TARGETS or not isinstance(reason, str) or not reason.strip() for host, reason in hosts.items()):
                raise ValueError(f"invalid host deferral in {name}")
            records.append(hosts)
    if any(records) and (len(records) != 2 or records[0] != records[1]):
        raise ValueError("a host deferral needs fast-inputs.json and readiness.json present and agreeing")
    hosts = records[0] if any(records) else {}
    for host, reason in hosts.items():
        path = Path(run) / f"install-{host}/outcome.json"
        if not path.is_file():
            continue
        outcome = json.loads(path.read_text())
        if outcome.get("outcome") != "deferred" or outcome.get("reason") != reason:
            raise ValueError(f"{host}: deferral does not match its install outcome")
    return hosts


def fast_evidence(run, version):
    run = Path(run)
    rows = {}
    release = load(run / "candidate.json")
    deferred = deferred_hosts(run)
    missing = sorted({"studio", *LINUX_TARGETS} - deferred.keys() - release["targets"].keys())
    if missing:
        raise ValueError(f"candidate omits non-deferred targets: {missing}")
    for host in release["targets"]:
        if host in deferred:
            continue
        build = run / ("mac" if host == "studio" else host)
        manifest, artifact, receipts = host_evidence(run, version, host, build)
        if release_identity(manifest) != release_identity(release):
            raise ValueError(f"{host}: candidate {manifest['digest']} is not the same release source as {release['digest']}")
        install = fast_install(receipts / f"install-{host}.json", manifest, artifact, host)
        rows[host] = {"candidate": manifest["digest"], "engine": manifest["engine"]["commit"], "frozenAt": manifest["frozenAt"], "artifact": artifact["digest"], "archive": artifact["archive"]["sha256"], "runtime": artifact["runtime"]["sha256"],
                      "install": install["digest"], "outcome": install["outcome"],
                      "eligibility": eligibility_evidence(manifest, host, install),
                      "restartDrain": install.get("restartDrain")}
    rows.update({host: {"outcome": "deferred", "reason": reason} for host, reason in deferred.items()})
    desktop = fast_artifact(run / "desktop/artifact-desktop-darwin-arm64.json", version, "darwin-arm64", "desktop")
    swap = json.loads((run / "desktop-swap.json").read_text())
    if swap["digest"] != digest({key: value for key, value in swap.items() if key != "digest"}):
        raise ValueError("desktop swap proof digest mismatch")
    if (swap["version"], swap["treeDigest"], swap["zip"]) != (version, desktop["runtime"]["sha256"], desktop["archive"]["sha256"]):
        raise ValueError("desktop swap proof does not match the verified desktop artifact")
    with (Path(swap["app"]) / "Contents/Info.plist").open("rb") as handle:
        if plistlib.load(handle).get("CFBundleShortVersionString") != version:
            raise ValueError("installed desktop app is not the released version")
    return {"version": version, "candidate": release["digest"], "sourceTree": release["source"]["tree"], "hosts": rows, "desktop": desktop["digest"], "desktopZip": desktop["archive"]["sha256"], "swap": swap["digest"]}


def fast_output(stage, config):
    target = stage_target(stage)
    stage = stage_action(stage)
    run = config.run
    if stage == "stage-linux":
        return json.loads((run / f"payload-{target}.json").read_text())["archive"]
    if stage in ("SM", "SL", "SD"):
        return validate_staged(config, stage)
    if stage == "Q":
        return json.loads((run / "readiness.json").read_text())["ok"] is True
    if stage == "A":
        manifest = load(config.manifest)
        return manifest["version"] == config.version and eligible(manifest)
    if stage in ("M", "L"):
        artifact = fast_artifact(config.artifact(), config.version, config.key)
        return sha256(config.build_out() / config.archive()) == artifact["archive"]["sha256"]
    if stage == "D":
        fast_artifact(run / "desktop/artifact-desktop-darwin-arm64.json", config.version, "darwin-arm64", "desktop")
        return True
    if stage == "install":
        if json.loads(config.outcome().read_text())["outcome"] not in SUCCESS_OUTCOMES:
            return False
        fast_install(config.receipt("install"), load(config.manifest), fast_artifact(config.artifact(), config.version, config.key), config.host)
        return True
    if stage == "S":
        return (run / "desktop-swap.json").is_file()
    if stage == "F":
        return json.loads((run / "final-receipt.json").read_text())["published"] == config.version
    if stage in WINDOWS_STAGES:
        return windows_output(stage, config)
    return stage in ("LM", "LR", "H", "AS")
