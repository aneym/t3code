import json
import os
import sys

from .install_offbox import REMOTE_ROOT
from .release_graph import SUCCESS_OUTCOMES
from .release_linux import require_host_ready
from .release_manifest import load
from .release_transport import command


def fast_install(config, log):
    require_host_ready(config, install=True)
    config.install_state().mkdir(parents=True, exist_ok=True)
    state, env, prefix = config.install_state(), None, []
    if config.host == "ax42":
        backups = (config.home / ".t3nightly" / "backups").resolve()
        state = backups.parent / "fast-install" / config.version
        state.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, "AGENT_LANE": "t3-nightly", "AGENT_THREAD_ID": "mcp:a2795f2f-43aa-40c5-890c-98de1291379a"}
        prefix = ["ionice", "-c3"]
    words = [*prefix, sys.executable, str(config.tools / "install"), "--seamless", "--rpc-tree", str(config.tree("mac-cli" if config.host == "studio" else "linux-cli")), "--version", config.version, "--assets", str(config.build_out()),
             "--manifest", str(config.manifest), "--artifact-manifest", str(config.artifact()), "--receipt", str(config.receipt("rehearsal")),
             "--receipt-host", config.host, "--install-receipt", str(config.receipt("install")), "--state-dir", str(state),
             "--chat-project", str(config.chat_project()), "--load-max", "64", "--health-s", "300", "--override-reason", config.override_reason,
             "--smoke-verdict", str(config.run / f"e2e-{config.host}" / "smoke-verdict.json"), "--rollback-proof", str(config.receipt("rollback-proof"))]
    if config.host != "studio":
        words.extend(["--service-label", "t3code.service"])
    if config.host == "ax42":
        words.extend(["--backups", str(backups), "--offbox", f"studio:{REMOTE_ROOT}/ax42", "--offbox-stage", "/srv/cow/t3nightly-offbox-stage"])
    if config.host == "ax42" and load(config.manifest)["targets"][config.host]["compatibility"].get("eligibility") == "restore-rollback":
        words.extend(["--offbox-stop-s", "900"])
    words.extend(config.target_artifacts())
    config.receipt("install").unlink(missing_ok=True)
    code = command(words, log, env=env)
    outcome = "failed"
    if config.receipt("install").is_file():
        outcome = json.loads(config.receipt("install").read_text())["outcome"]
    if code and outcome in SUCCESS_OUTCOMES:
        outcome = "failed"
    (config.outcome()).write_text(json.dumps({"outcome": outcome, "installerExit": code}) + "\n")
    return 0
