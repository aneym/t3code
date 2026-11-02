import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from .gate_proc import CheckFailed


def delegated_install(ctx, deadline):
    if hasattr(ctx, "sandbox"):
        return managed_install(ctx, deadline)
    from .gate_seed import CACHE_ROOT, cache_entries
    from .gate_env import free_port
    from .rehearsal_sandbox import Sandbox

    seed = next(path / "userdata/statev2.sqlite" for path in cache_entries(CACHE_ROOT) if (path / "userdata/statev2.sqlite").is_file())
    args = SimpleNamespace(home=ctx.work / "delegated-home", evidence=ctx.work / "delegated-evidence", old_runtime=Path(ctx.t3).parent,
        seed=seed, label="t3-rehearsal-delegated-" + uuid4().hex[:12], port=free_port(), hot_swap=False, managed_service=True,
        rpc_tree=ctx.tree, provider="unused", provider_binary="/usr/bin/false", launcher_artifact="", old_launcher_artifact="",
        connector_artifact="", live_home=[], offbox_stop_s=600, rehearsal_drain_s=120)
    sandbox = Sandbox(args)
    isolated = SimpleNamespace(home=sandbox.home, work=sandbox.evidence, out=ctx.out, tree=ctx.tree, t3=str(sandbox.cli),
        project=sandbox.project, client=ctx.client, node=ctx.node, sandbox=sandbox, log=ctx.log)
    try:
        sandbox.prepare(90)
        return managed_install(isolated, deadline)
    finally:
        sandbox.close()


def managed_install(ctx, deadline):
    from .gate_checks import client, pairing
    from .install_hard import service
    from .install_policy import admit, window
    from .install_rpc import restart_session
    from .install_seamless import prepare_with_drain
    from .rehearsal_drain import configure_replay

    sandbox = ctx.sandbox
    from .install_policy import refuse_probe
    refuse_probe(ctx.home, sandbox.port, sandbox.label)
    receipt = getattr(ctx, "out", ctx.work) / "delegated-child-drain.json"
    configure_replay(SimpleNamespace(home=ctx.home, evidence=ctx.work, args=SimpleNamespace(rpc_tree=ctx.tree)))
    script = ctx.home / "runtime/drain-replay/dev-replay-agent.ts"
    shutil.copy2(Path(__file__).with_name("drain_replay.mjs"), script.parent / "drain_replay.mjs")
    text = script.read_text().replace('import * as NodeCrypto', 'import { drainTurn } from "./drain_replay.mjs";\nimport * as NodeCrypto')
    text = text.replace('if (turn !== undefined) ended = await playTurn(sessionId, turn, controller.signal);', 'await drainTurn(params, sessionId, session.promptCount, send, controller.signal);')
    script.write_text(text)
    settings = ctx.home / "userdata/settings.json"
    value = json.loads(settings.read_text())
    value["continueThreadsAfterServerUpdate"] = True
    value["providerInstances"] = {"drainReplay": value["providerInstances"]["drainReplay"]}
    settings.write_text(json.dumps(value) + "\n")
    version = sandbox.old.name
    args = SimpleNamespace(drain_s=120, port=sandbox.port, rpc_tree=ctx.tree, node=ctx.node, version=version, live_home=[])

    def mark(name, **detail):
        proof = json.loads(receipt.read_text())
        proof["checks"].append({"name": name, "ok": True, "at": datetime.now(timezone.utc).isoformat(), **detail})
        receipt.write_text(json.dumps(proof, indent=2) + "\n")

    run = SimpleNamespace(args=args, home=ctx.home, state=ctx.work, service_label=sandbox.label + ".service", report={}, runtime=lambda v: ctx.home / "runtime/versions" / v / "t3", step=lambda name, **detail: mark(name, **detail))
    admit(run, window(version, sandbox=True))
    try:
        for phase in ("before", "after"):
            client(ctx, "delegated-child-drain-" + phase, deadline, "queue-drain", "--pairing-file", str(pairing(ctx, "delegated-child-drain-" + phase, deadline)), "--cli", ctx.t3, "--home", str(ctx.home), "--project", str(ctx.project), "--scenario", "delegated-drain", "--phase", phase, "--evidence", str(receipt))
            if phase == "before":
                with restart_session(run, version) as bearer:
                    drain = prepare_with_drain(run, bearer, str(uuid4()))
                    mark("drain-120", receipt=drain, drain_s=120)
                    service(run, "stop")
                    service(run, "start")
                    sandbox.wait_ready(version, 90)
                    mark("restart-ready", version=version, service=run.service_label)
        proof = json.loads(receipt.read_text())
        if not proof.get("ok"):
            raise CheckFailed("delegated task did not survive install drain and restart")
        return "delegated-child-drain: open task retained through 120s drain/stop/start; child completed; parent completion delivered in a new run"
    except Exception as error:
        proof = json.loads(receipt.read_text()) if receipt.exists() else {"check": "delegated-child-drain", "checks": []}
        proof.update(ok=False, error=str(error))
        receipt.write_text(json.dumps(proof, indent=2) + "\n")
        raise
