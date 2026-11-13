import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from .release_graph import SUCCESS_OUTCOMES
from .release_linux import require_host_ready
from .release_transport import command


@dataclass(frozen=True)
class InstallCommand:
    argv: list[str]
    state: Path
    env: dict[str, str] | None


def build_install_command(*, host, version, tools, rpc_tree, assets, manifest, artifact_manifest,
                          receipt_host, install_receipt, state_dir, chat_project, override_reason="", launcher_artifact=None,
                          connector_artifact=None, home=None, drain_s=None, compact_db=None,
                          install_window="", protected_threads=None, protected_wait_s=None, land_locks=None, land_wait_s=None):
    home = Path.home() if home is None else Path(home)
    state, env, prefix = Path(state_dir), None, []
    if host == "ax42":
        backups = (home / ".t3nightly" / "backups").resolve()
        state = backups.parent / "fast-install" / version
        env = {**os.environ, "AGENT_LANE": "t3-nightly", "AGENT_THREAD_ID": "mcp:a2795f2f-43aa-40c5-890c-98de1291379a"}
        prefix = ["ionice", "-c3"]
    words = [*prefix, sys.executable, str(Path(tools) / "install"), "--hard", "--rpc-tree", str(rpc_tree), "--version", version, "--assets", str(assets),
             "--manifest", str(manifest), "--artifact-manifest", str(artifact_manifest),
             "--receipt-host", receipt_host, "--install-receipt", str(install_receipt), "--state-dir", str(state),
             "--chat-project", str(chat_project), "--load-max", "64", "--health-s", "300", "--override-reason", override_reason]
    if host != "studio":
        words.extend(["--service-label", "t3code.service"])
    if host == "ax42":
        words.extend(["--backups", str(backups)])
    for kind, path in (("launcher", launcher_artifact), ("connector", connector_artifact)):
        if path is not None:
            words.extend([f"--{kind}-artifact", str(path)])
    if drain_s is not None:
        if not 1 <= drain_s <= 300:
            raise ValueError("drain_s must be between 1 and 300")
        words.extend(["--drain-s", str(drain_s)])
    if compact_db is not None:
        if compact_db and host != "studio":
            raise ValueError("compact_db is supported on studio only")
        words.append("--compact-db" if compact_db else "--no-compact-db")
    if install_window:
        words.extend(["--install-window", install_window])
    for thread in protected_threads or ():
        words.extend(["--protected-thread", thread])
    if protected_wait_s is not None:
        words.extend(["--protected-wait-s", str(protected_wait_s)])
    for pattern in land_locks or ():
        words.extend(["--land-lock", pattern])
    if land_wait_s is not None:
        words.extend(["--land-wait-s", str(land_wait_s)])
    return InstallCommand(words, state, env)


def fast_install(config, log):
    require_host_ready(config, install=True)
    config.install_state().mkdir(parents=True, exist_ok=True)
    artifacts = config.target_artifacts()
    plan = build_install_command(
        host=config.host, version=config.version, tools=config.tools,
        rpc_tree=config.tree("mac-cli" if config.host == "studio" else "linux-cli"),
        assets=config.build_out(), manifest=config.manifest, artifact_manifest=config.artifact(),
        receipt_host=config.host,
        install_receipt=config.receipt("install"), state_dir=config.install_state(),
        chat_project=config.chat_project(), override_reason=config.override_reason,
        home=config.home, compact_db=config.compact_db or None,
        **{artifacts[index].removeprefix("--").replace("-", "_"): artifacts[index + 1] for index in range(0, len(artifacts), 2)},
    )
    plan.state.mkdir(parents=True, exist_ok=True)
    config.receipt("install").unlink(missing_ok=True)
    code = command(plan.argv, log, env=plan.env)
    outcome = "failed"
    receipt = {}
    if config.receipt("install").is_file():
        receipt = json.loads(config.receipt("install").read_text())
        outcome = receipt["outcome"]
    if code and outcome in SUCCESS_OUTCOMES:
        outcome = "failed"
    (config.outcome()).write_text(json.dumps({"outcome": outcome, "installerExit": code, "retryable": receipt.get("retryable") is True}) + "\n")
    return 0 if outcome in SUCCESS_OUTCOMES else 1
