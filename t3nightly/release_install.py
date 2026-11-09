import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from .offbox_hosts import root
from .release_graph import SUCCESS_OUTCOMES
from .release_linux import require_host_ready
from .release_transport import command


@dataclass(frozen=True)
class InstallCommand:
    argv: list[str]
    state: Path
    env: dict[str, str] | None


def build_install_command(*, host, version, tools, rpc_tree, assets, manifest, artifact_manifest,
                          receipt, receipt_host, install_receipt, state_dir, chat_project,
                          smoke_verdict, rollback_proof, override_reason="", launcher_artifact=None,
                          connector_artifact=None, home=None, drain_s=None, handoff_stop=None, compact_db=None):
    home = Path.home() if home is None else Path(home)
    state, env, prefix = Path(state_dir), None, []
    if host == "ax42":
        backups = (home / ".t3nightly" / "backups").resolve()
        state = backups.parent / "fast-install" / version
        env = {**os.environ, "AGENT_LANE": "t3-nightly", "AGENT_THREAD_ID": "mcp:a2795f2f-43aa-40c5-890c-98de1291379a"}
        prefix = ["ionice", "-c3"]
    words = [*prefix, sys.executable, str(Path(tools) / "install"), "--seamless", "--rpc-tree", str(rpc_tree), "--version", version, "--assets", str(assets),
             "--manifest", str(manifest), "--artifact-manifest", str(artifact_manifest), "--receipt", str(receipt),
             "--receipt-host", receipt_host, "--install-receipt", str(install_receipt), "--state-dir", str(state),
             "--chat-project", str(chat_project), "--load-max", "64", "--health-s", "300", "--override-reason", override_reason,
             "--smoke-verdict", str(smoke_verdict), "--rollback-proof", str(rollback_proof)]
    if host != "studio":
        words.extend(["--service-label", "t3code.service"])
    if host == "ax42":
        words.extend(["--backups", str(backups), "--offbox", f"ax102:{root('ax102')}/ax42", "--offbox-stopped-ship", "--offbox-mib-s", "90", "--offbox-stop-s", "2400", "--offbox-window-s", "4380"])
    for kind, path in (("launcher", launcher_artifact), ("connector", connector_artifact)):
        if path is not None:
            words.extend([f"--{kind}-artifact", str(path)])
    if drain_s is not None:
        if not 1 <= drain_s <= 300:
            raise ValueError("drain_s must be between 1 and 300")
        words.extend(["--drain-s", str(drain_s)])
    if handoff_stop is not None:
        words.append("--handoff-stop" if handoff_stop else "--no-handoff-stop")
    if compact_db is not None:
        if compact_db and host != "studio":
            raise ValueError("compact_db is supported on studio only")
        words.append("--compact-db" if compact_db else "--no-compact-db")
    return InstallCommand(words, state, env)


def fast_install(config, log):
    require_host_ready(config, install=True)
    config.install_state().mkdir(parents=True, exist_ok=True)
    artifacts = config.target_artifacts()
    plan = build_install_command(
        host=config.host, version=config.version, tools=config.tools,
        rpc_tree=config.tree("mac-cli" if config.host == "studio" else "linux-cli"),
        assets=config.build_out(), manifest=config.manifest, artifact_manifest=config.artifact(),
        receipt=config.receipt("rehearsal"), receipt_host=config.host,
        install_receipt=config.receipt("install"), state_dir=config.install_state(),
        chat_project=config.chat_project(), override_reason=config.override_reason,
        smoke_verdict=config.run / f"e2e-{config.host}" / "smoke-verdict.json",
        rollback_proof=config.receipt("rollback-proof"), home=config.home, compact_db=config.compact_db or None,
        handoff_stop=True if config.compact_db else None,
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
    return 0
