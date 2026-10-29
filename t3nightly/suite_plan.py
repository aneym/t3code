import hashlib
import json
import os
import re
import shlex
import subprocess
from pathlib import Path

from .release_manifest import digest, source_identity


SCHEMA = "t3nightly.advisory-plan/1"
CI_REQUIRED = (
    "lint", "build", "test", "test_web", "test_server", "rust",
    "mobile_native_static_analysis", "release_smoke",
)
RELEASE_REQUIRED = ("quality", "test", "test_web", "test_server")
RELEASE_EXCLUDED = {
    "resolve_commit", "preflight", "relay_public_config", "build_bundle",
    "desktop_mac_arm64", "desktop_mac_x64", "desktop_linux_x64", "desktop_linux_arm64",
    "desktop_win_x64", "desktop_win_arm64", "release", "publish_cli", "publish_aur",
    "build_web", "deploy_web", "build_marketing", "deploy_marketing", "finalize", "announce_discord",
}
KINDS = {
    "lint": "lint-generated",
    "build": "build-typecheck",
    "test": "package-tests",
    "test_web": "web-browser-tests",
    "test_server": "server-tests",
    "rust": "rust",
    "mobile_native_static_analysis": "mobile-native",
    "release_smoke": "release-smoke",
    "quality": "release-quality",
}
SETUP = re.compile(r"^(ensure|install|resolve|start|finish)\b", re.IGNORECASE)
HOST_PROVISIONING = re.compile(r"(?<![A-Za-z0-9_-])(sudo|apt|apt-get|install-deps)(?![A-Za-z0-9_-])")


def host_provisioning(command):
    try:
        normalized = " ".join(shlex.split(str(command)))
    except ValueError:
        return True
    return bool(HOST_PROVISIONING.search(normalized))


def load_workflow(path):
    script = "puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), [], [], true))"
    result = subprocess.run(
        ["/usr/bin/ruby", "-ryaml", "-rjson", "-e", script, str(path)],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise ValueError(f"cannot parse {path}: {result.stderr.strip()}")
    value = json.loads(result.stdout)
    if not isinstance(value.get("jobs"), dict):
        raise ValueError(f"{path} has no jobs")
    return value


def slug(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def needs(value):
    if value is None:
        return []
    return [value] if isinstance(value, str) else list(value)


def shards(job, upstream_id):
    if upstream_id != "test_server":
        return [None]
    values = job.get("strategy", {}).get("matrix", {}).get("shard")
    if not isinstance(values, list) or not values or any(type(value) is not int for value in values):
        raise ValueError("required test_server job has no integer shard matrix")
    return values


def expressions(value, shard, shard_count):
    if isinstance(value, str):
        value = re.sub(r"\$\{\{\s*needs\.changes\.outputs\.test_packages\s*\}\}", "", value)
        value = re.sub(r"\$\{\{\s*matrix\.shard\s*\}\}", str(shard), value)
        return re.sub(r"\$\{\{\s*strategy\.job-total\s*\}\}", str(shard_count), value)
    if isinstance(value, dict):
        return {key: expressions(item, shard, shard_count) for key, item in value.items()}
    return value


def tools(command):
    found = []
    for tool in ("vp", "vpr", "node", "python3", "cargo", "brew", "git", "sudo"):
        if re.search(rf"(?<![A-Za-z0-9_-]){re.escape(tool)}(?![A-Za-z0-9_-])", command):
            found.append(tool)
    if "cargo fmt" in command:
        found.append("rustfmt")
    return found


def planned_actions(job):
    return [
        {"name": step.get("name") or step["uses"], "uses": step["uses"], "condition": step.get("if")}
        for step in job.get("steps", []) if isinstance(step, dict) and step.get("uses")
    ]


def planned_steps(job, shard, shard_count):
    rows = []
    for index, step in enumerate(job.get("steps", []), 1):
        if not isinstance(step, dict) or not step.get("run"):
            continue
        name = step.get("name") or f"step-{index}"
        command = expressions(step["run"], shard, shard_count)
        rows.append({
            "id": f"{index:02d}-{slug(name)}",
            "name": name,
            "command": command,
            "condition": expressions(step.get("if"), shard, shard_count),
            "environment": expressions(step.get("env", {}), shard, shard_count),
            "setup": bool(SETUP.search(name)),
            "hostProvisioning": host_provisioning(command),
            "tools": tools(command),
        })
    if not rows:
        raise ValueError(f"required job {job.get('name')} has no executable steps")
    return rows


def planned_job(workflow, upstream_id, job, shard):
    runner = str(job.get("runs-on", ""))
    host_class = "mac" if "macos" in runner else "linux"
    prefix = workflow.removesuffix(".yml")
    job_id = f"{prefix}/{upstream_id}" + (f"/{shard}" if shard is not None else "")
    shard_count = len(shards(job, upstream_id)) if shard is not None else None
    return {
        "id": job_id,
        "upstreamJob": upstream_id,
        "workflow": workflow,
        "name": expressions(job.get("name", upstream_id), shard, shard_count),
        "kind": KINDS[upstream_id],
        "hostClass": host_class,
        "hosts": ["studio"] if host_class == "mac" else ["ax42", "forge", "pc-wsl"],
        "upstreamNeeds": needs(job.get("needs")),
        "condition": job.get("if"),
        "timeoutSeconds": int(job.get("timeout-minutes", 10)) * 60,
        "shard": shard,
        "shardCount": shard_count,
        "workflowActions": planned_actions(job),
        "steps": planned_steps(job, shard, shard_count),
    }


def required_jobs(workflow, data, required, controls):
    jobs = data["jobs"]
    missing = [name for name in required if name not in jobs]
    if missing:
        raise ValueError(f"{workflow} missing required jobs: {', '.join(missing)}")
    unknown = []
    if workflow == "ci.yml":
        aggregate = jobs.get("check", {})
        unknown = [name for name in needs(aggregate.get("needs")) if name not in required and name not in controls]
    else:
        unknown = sorted(set(jobs) - set(required) - RELEASE_EXCLUDED)
    if unknown:
        raise ValueError(f"{workflow} unknown required jobs: {', '.join(sorted(unknown))}")


def source(tree):
    result = subprocess.run(
        ["git", "-C", str(tree), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise ValueError(f"cannot resolve candidate HEAD in {tree}")
    identity = source_identity(tree, result.stdout.strip())
    identity["stampedContents"] = {
        path: (tree / path).read_text() for path in identity["stampedFiles"]
    }
    return identity


def plan(tree):
    tree = Path(tree).expanduser().resolve()
    workflows = []
    jobs = []
    for filename, required, controls in (
        ("ci.yml", CI_REQUIRED, {"changes", "check"}),
        ("release.yml", RELEASE_REQUIRED, set()),
    ):
        path = tree / ".github" / "workflows" / filename
        data = load_workflow(path)
        required_jobs(filename, data, required, controls)
        workflows.append({
            "path": str(path.relative_to(tree)),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        })
        for upstream_id in required:
            job = data["jobs"][upstream_id]
            for shard in shards(job, upstream_id):
                jobs.append(planned_job(filename, upstream_id, job, shard))
    value = {
        "schema": SCHEMA,
        "source": source(tree),
        "workflows": workflows,
        "advisory": True,
        "jobs": jobs,
    }
    value["digest"] = digest(value)
    return value


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as handle:
        handle.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return value


def load(path):
    value = json.loads(Path(path).read_text())
    if value.get("schema") != SCHEMA:
        raise ValueError("wrong advisory plan schema")
    sealed = value.pop("digest", None)
    if sealed != digest(value):
        raise ValueError("advisory plan digest does not match its contents")
    value["digest"] = sealed
    return value
