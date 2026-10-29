import json
from pathlib import Path

from .gate_checks import pairing, t3
from .gate_proc import CheckFailed, run
from .smoke_checks import AGENT_HANDLE, AGENT_NAME, agent_file, bind_to, marker, start_thread

STORY = Path(__file__).resolve().with_name("smoke_ui.mjs")
OTHER_PROJECT = "t3smoke"
AGENT_PROJECT = "t3smoke-agent"


def ui(ctx, deadline):
    lane_word, other_word = marker("LANE"), marker("OTHER")
    lane = start_thread(ctx, "ui", deadline, ctx.agent_project, lane_word)
    other = start_thread(ctx, "ui", deadline, ctx.project, other_word)
    lane_dir = ctx.agent_homes.parent / "lanes" / "smoke-lane"
    lane_dir.mkdir(parents=True, exist_ok=True)
    (lane_dir / "lane.json").write_text(json.dumps({"parent": AGENT_HANDLE, "t3": {"thread_id": lane}}) + "\n")
    before = agent_file(ctx).read_bytes()
    code, _ = t3(ctx, "ui", deadline, "agent bind", AGENT_HANDLE, lane, cap=60)
    if code == 0 or agent_file(ctx).read_bytes() != before:
        raise CheckFailed("binding a lane thread was accepted or rewrote agent.json")
    _, moved = bind_to(ctx, "ui", deadline, other)
    if (moved.get("previous") or {}).get("thread_id") != ctx.smoke_thread:
        raise CheckFailed("rebinding did not keep the previous main thread")
    bind_to(ctx, "ui", deadline, ctx.smoke_thread)
    names = {"agent": AGENT_NAME, "main": ctx.smoke_word, "lane": lane_word, "other": other_word, "otherProject": OTHER_PROJECT, "agentProject": AGENT_PROJECT, "build": int(ctx.version.rsplit(".aneym.", 1)[1]) if ".aneym." in ctx.version else 0}
    names_file = ctx.work / "ui-names.json"
    names_file.write_text(json.dumps(names))
    shots = ctx.out / "ui"
    code, out = run(
        [ctx.node, str(STORY), str(ctx.tree), str(pairing(ctx, "ui", deadline)), str(names_file), str(shots)],
        ctx.log("ui"),
        deadline,
        cwd=str(ctx.work),
    )
    lines = [line for line in out.splitlines() if line.startswith("{")]
    if code != 0 or not lines:
        raise CheckFailed("browser stories exited %d with no result" % code)
    result = json.loads(lines[-1])
    failed = ["%s: %s" % (s["name"], s["detail"]) for s in result["stories"] if not s["ok"]]
    if failed:
        raise CheckFailed("; ".join(failed))
    return "lane bind refused, rebind kept previous; %d browser stories passed: %s; shots in %s" % (len(result["stories"]), ", ".join(s["name"] for s in result["stories"]), shots)
