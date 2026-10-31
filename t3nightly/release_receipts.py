import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .release_graph import INSTALL_OUTCOMES, SUCCESS_OUTCOMES
from .release_manifest import TARGETS, digest


REHEARSAL_SCHEMA = "t3nightly.rehearsal-receipt/1"
INSTALL_SCHEMA = "t3nightly.install-receipt/1"
EXPIRY = timedelta(hours=2)
SHA256 = 64
RUNTIME = {"version": str, "digest": str}
REHEARSAL_FIELDS = {
    "schema": str, "release": str, "runId": str, "host": str, "platform": str, "arch": str,
    "candidateDigest": str, "sourceTree": str, "artifactManifestDigest": str, "engineDigest": str,
    "oldRuntime": RUNTIME, "candidateRuntime": RUNTIME,
    "oldMigrationHistory": str, "candidateMigrationHistory": str,
    "baselineChat": dict, "postCutoverChat": dict, "workload": dict,
    "result": str, "startedAt": str, "finishedAt": str, "expiresAt": str, "digest": str,
}
INSTALL_FIELDS = {
    "schema": str, "release": str, "runId": str, "host": str, "platform": str, "arch": str,
    "candidateDigest": str, "rehearsalDigest": str, "artifactManifestDigest": str,
    "service": str, "oldRuntime": RUNTIME, "servingRuntime": RUNTIME, "backup": dict,
    "chat": dict, "outcome": str, "reapedSshLaunch": list, "eligibility": dict, "startedAt": str, "finishedAt": str, "digest": str,
}
OBSERVED = (
    "oldRuntime.digest", "oldMigrationHistory", "artifactManifestDigest",
    "candidateRuntime.digest", "servingRuntime.digest", "rehearsalDigest",
)
CHAT_FIELDS = {"threadId": str, "messageId": str, "nonce": str, "evidenceDigest": str}
WORKLOAD_FIELDS = {"outcome": str, "evidenceDigest": str}


def timestamp(value):
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is None:
        raise ValueError(f"timestamp {value} has no timezone")
    return moment


def shape(value, fields, where):
    if not isinstance(value, dict):
        raise ValueError(f"{where} must be an object")
    missing = sorted(set(fields) - set(value))
    extra = sorted(set(value) - set(fields))
    if missing or extra:
        raise ValueError(f"{where} missing {missing} unexpected {extra}")
    for key, kind in fields.items():
        if isinstance(kind, dict):
            shape(value[key], kind, f"{where}.{key}")
        elif not isinstance(value[key], kind):
            raise ValueError(f"{where}.{key} must be {kind.__name__}")


def receipt_digest(receipt):
    return digest({key: value for key, value in receipt.items() if key != "digest"})


def validate(receipt):
    schema = receipt.get("schema") if isinstance(receipt, dict) else None
    if schema == REHEARSAL_SCHEMA:
        shape(receipt, {**REHEARSAL_FIELDS, **({"hotSwap": dict} if "hotSwap" in receipt else {})}, "receipt")
        for name in ("baselineChat", "postCutoverChat"):
            shape(receipt[name], CHAT_FIELDS, f"receipt.{name}")
        if not receipt["workload"]:
            raise ValueError("receipt.workload is empty")
        for name, row in receipt["workload"].items():
            shape(row, WORKLOAD_FIELDS, f"receipt.workload.{name}")
        if timestamp(receipt["expiresAt"]) != timestamp(receipt["finishedAt"]) + EXPIRY:
            raise ValueError("receipt.expiresAt must be two hours after finishedAt")
    elif schema == INSTALL_SCHEMA:
        optional = {key: dict for key in ("installWindow", "hotSwap") if key in receipt and receipt[key] is not None}
        shape({key: value for key, value in receipt.items() if value is not None or key not in ("installWindow", "hotSwap")}, {**INSTALL_FIELDS, **optional}, "receipt")
        shape(receipt["chat"], CHAT_FIELDS, "receipt.chat")
        if receipt["outcome"] not in INSTALL_OUTCOMES:
            raise ValueError(f"receipt.outcome must be one of {INSTALL_OUTCOMES}")
    else:
        raise ValueError(f"unknown receipt schema {schema}")
    if timestamp(receipt["finishedAt"]) < timestamp(receipt["startedAt"]):
        raise ValueError("receipt finished before it started")
    if receipt["host"] not in TARGETS or TARGETS[receipt["host"]] != (receipt["platform"], receipt["arch"]):
        raise ValueError(f"receipt host {receipt['host']} does not match its platform and arch")
    if receipt["digest"] != receipt_digest(receipt):
        raise ValueError("receipt digest does not match its contents")
    return receipt


def seal(receipt):
    sealed = dict(receipt)
    if sealed.get("schema") == REHEARSAL_SCHEMA:
        sealed["expiresAt"] = (timestamp(sealed["finishedAt"]) + EXPIRY).isoformat()
    sealed["digest"] = receipt_digest(sealed)
    return validate(sealed)


def write(path, receipt):
    sealed = seal(receipt)
    with Path(path).open("x") as handle:
        handle.write(json.dumps(sealed, indent=2, sort_keys=True) + "\n")
    return sealed


def parse(path):
    return validate(json.loads(Path(path).read_text()))


def provenance(receipt, manifest, host, now=None, observed=None):
    now = now or datetime.now(timezone.utc)
    observed = observed or {}
    platform, arch = TARGETS.get(host, (None, None))
    target = manifest["targets"].get(host)
    if target is None:
        return [f"host: {host} is not a candidate target"]
    compatibility = target["compatibility"]
    expected = {
        "host": host,
        "platform": platform,
        "arch": arch,
        "release": manifest["version"],
        "candidateDigest": manifest["digest"],
    }
    if receipt["schema"] == REHEARSAL_SCHEMA:
        expected["engineDigest"] = manifest["engine"]["digest"]
        expected["sourceTree"] = manifest["source"]["stampedTree"]
        expected["candidateMigrationHistory"] = compatibility["candidateMigrations"]["history"]
        expected["oldMigrationHistory"] = compatibility["baseMigrations"]["history"]
    else:
        expected["eligibility.class"] = compatibility.get("eligibility")
    if target.get("oldRelease"):
        expected["oldRuntime.version"] = target["oldRelease"]
    for key in OBSERVED:
        if observed.get(key):
            expected[key] = observed[key]
    reasons = []
    for key, value in expected.items():
        section, _, field = key.partition(".")
        actual = receipt.get(section, {}).get(field) if field else receipt.get(section)
        if actual != value:
            reasons.append(f"{key}: receipt {actual} != expected {value}")
    if not compatibility["fastPath"]["eligible"]:
        reasons.append("candidate is not fast-path eligible: " + ", ".join(compatibility["fastPath"]["reasons"]))
    if receipt["schema"] == REHEARSAL_SCHEMA:
        if receipt["result"] != "PASS":
            reasons.append(f"result is {receipt['result']}, not PASS")
        failed = sorted(name for name, row in receipt["workload"].items() if row["outcome"] != "passed")
        if failed:
            reasons.append(f"workload not passed: {', '.join(failed)}")
        if now >= timestamp(receipt["expiresAt"]):
            reasons.append(f"expired at {receipt['expiresAt']}")
    elif receipt["outcome"] not in SUCCESS_OUTCOMES:
        reasons.append(f"outcome {receipt['outcome']} is not release success")
    return reasons
