import json
import os
import secrets
import shlex
import signal
import subprocess
import re
import time
from pathlib import Path

from .gate_env import QUIET_SETTINGS, make_project, seed_home, start_server, unpack
from .gate_proc import CheckFailed, run

CLAUDE_MODEL = os.environ.get("T3NIGHTLY_CLAUDE_MODEL", "claude-haiku-5-5")
CODEX_MODEL = os.environ.get("T3NIGHTLY_CODEX_MODEL", "gpt-6-luna")


def t3(ctx, name, deadline, words, *args, cap=None, secret_out=None):
    return run(
        [ctx.t3, *words.split(), "--base-dir", str(ctx.home), *args],
        ctx.log(name),
        deadline,
        cap=cap,
        cwd=str(ctx.project),
        secret_out=secret_out,
    )


def client(ctx, name, deadline, mode, *args):
    code, out = run(
        [ctx.node, str(ctx.client), mode, "--tree", str(ctx.tree), *args],
        ctx.log(name),
        deadline,
        cwd=str(ctx.work),
    )
    lines = [line for line in out.splitlines() if line.startswith("{")]
    if not lines:
        raise CheckFailed("client %s printed no result (exit %d)" % (mode, code))
    result = json.loads(lines[-1])
    if code != 0 or not result.get("ok"):
        raise CheckFailed(
            "client %s: %s" % (mode, result.get("error", "exit %d" % code))
        )
    return result


def pairing(ctx, name, deadline):
    path = ctx.work / ("%s.pair" % name)
    code, _ = t3(
        ctx,
        name,
        deadline,
        "pair",
        "--label",
        "t3nightly-%s" % name,
        "--ttl",
        "10m",
        cap=60,
        secret_out=str(path),
    )
    if code != 0:
        raise CheckFailed("t3 pair exited %d: %s" % (code, pair_diagnostic(ctx, name)))
    return path


def pair_diagnostic(ctx, name):
    try:
        text = Path(ctx.log(name)).read_text(errors="replace")
    except OSError:
        return "no stderr captured"
    text = re.sub(r"(Pairing URL:\s+)\S+", r"\1REDACTED", text, flags=re.IGNORECASE)
    text = re.sub(r"((?:token|ticket|access_token|wsTicket)=)[^&\s\"]+", r"\1REDACTED", text, flags=re.IGNORECASE)
    return text[-600:].replace("\n", " ").strip() or "no stderr captured"


def wait_for_pair_discovery(ctx, deadline, name):
    path = ctx.work / ("%s-ready.pair" % name)
    while True:
        code, _ = t3(
            ctx,
            "%s-ready" % name,
            deadline,
            "pair",
            "--label",
            "t3nightly-%s-ready" % name,
            "--ttl",
            "10m",
            cap=15,
            secret_out=str(path),
        )
        path.unlink(missing_ok=True)
        if code == 0:
            return
        try:
            deadline.left(2)
        except CheckFailed as error:
            raise CheckFailed(
                "t3 pair discovery did not become ready: %s" % pair_diagnostic(ctx, "%s-ready" % name)
            ) from error
        time.sleep(0.5)


def boot(ctx, deadline):
    runtime = unpack(ctx.archive, ctx.work)
    ctx.t3 = str(runtime / "t3")
    code, out = run([ctx.t3, "--version"], ctx.log("boot"), deadline, cap=60)
    if code != 0 or ctx.version not in out:
        raise CheckFailed(
            "t3 --version printed %r, expected %s" % (out.strip()[:80], ctx.version)
        )
    make_project(ctx.project)
    live_bytes = seed_home(ctx, deadline)
    descriptor = start_server(ctx, deadline)
    if descriptor.get("serverVersion") != ctx.version:
        raise CheckFailed(
            "server reports %s, expected %s"
            % (descriptor.get("serverVersion"), ctx.version)
        )
    bearer = ctx.work / "boot.session"
    code, _ = t3(
        ctx,
        "boot",
        deadline,
        "auth session issue",
        "--json",
        "--label",
        "t3nightly-boot",
        "--ttl",
        "10m",
        cap=60,
        secret_out=str(bearer),
    )
    if code != 0:
        raise CheckFailed("t3 auth session issue exited %d" % code)
    token = ctx.work / "boot.bearer"
    token.write_text(json.loads(bearer.read_text())["token"])
    token.chmod(0o600)
    session = client(
        ctx,
        "boot",
        deadline,
        "session",
        "--origin",
        ctx.origin,
        "--bearer-file",
        str(token),
    )
    if session["settings"] != QUIET_SETTINGS:
        raise CheckFailed(
            "server did not load the gate settings: %s"
            % json.dumps(session["settings"])
        )
    code, _ = t3(
        ctx,
        "boot",
        deadline,
        "project add",
        "--title",
        "t3nightly-gate",
        str(ctx.project),
        cap=60,
    )
    if code != 0:
        raise CheckFailed("t3 project add exited %d" % code)
    ctx.ready = True
    return (
        "served %s on %s from a home seeded off a %d MB live snapshot; WS session up, providers: %s"
        % (ctx.version, ctx.origin, live_bytes // 2**20, ",".join(session["providers"]))
    )


def pair(ctx, deadline):
    result = client(
        ctx,
        "pairing",
        deadline,
        "pair",
        "--pairing-file",
        str(pairing(ctx, "pairing", deadline)),
    )
    if not result.get("reuseRejected"):
        raise CheckFailed("a spent pairing token was accepted again")
    return "pairing URL exchanged for a bearer session, WS RPC session opened, token rejected on reuse"


def mobile(ctx, deadline):
    result = client(
        ctx,
        "mobile",
        deadline,
        "mobile",
        "--pairing-file",
        str(pairing(ctx, "mobile", deadline)),
    )
    return (
        "paired as mobile; shell listed %d threads in %d projects; opened %s stream (%d messages)"
        % (
            result["threads"],
            result["projects"],
            result["openedThread"],
            result["messages"],
        )
    )


def turn(ctx, deadline, name, provider, model):
    prompt = "Reply with exactly the word PONG and nothing else."
    code, out = t3(
        ctx,
        name,
        deadline,
        "thread start",
        "--provider",
        provider,
        "--model",
        model,
        "--wait",
        "--json",
        str(ctx.project),
        prompt,
    )
    started = json.loads(out) if out.strip().startswith("{") else {}
    if code != 0 or started.get("status") != "completed":
        raise CheckFailed(
            "%s/%s turn ended %s: %s"
            % (
                provider,
                model,
                started.get("status", "exit %d" % code),
                str(started.get("error"))[:300],
            )
        )
    code, out = t3(
        ctx, name, deadline, "thread show", "--json", started["threadId"], cap=60
    )
    shown = json.loads(out)
    replies = [
        message["text"]
        for message in shown["messages"]
        if message["role"] == "assistant" and message["text"].strip()
    ]
    if shown["thread"]["status"] != "completed" or not replies:
        raise CheckFailed(
            "persisted thread is %s with %d assistant replies"
            % (shown["thread"]["status"], len(replies))
        )
    return "%s/%s replied %r; persisted thread %s completed" % (
        provider,
        model,
        replies[-1][:40],
        started["threadId"],
    )


def claude_turn(ctx, deadline):
    return turn(ctx, deadline, "claude-turn", "claudeAgent", CLAUDE_MODEL)


def codex_turn(ctx, deadline):
    return turn(ctx, deadline, "codex-turn", "codex", CODEX_MODEL)


def background_wait(ctx, deadline):
    marker = "BG%s-done" % secrets.token_hex(4)
    release = ctx.work / (marker + ".release")
    command = (
        "i=0; while [ ! -e %s ] && [ \"$i\" -lt 240 ]; do sleep 1; i=$((i + 1)); done; "
        "[ -e %s ] && echo %s"
    ) % (shlex.quote(str(release)), shlex.quote(str(release)), marker)
    prompt = (
        "Run this exact shell command as a background task (Bash tool with run_in_background set to true): %s\n"
        "The command waits for a file another process creates; do not create, touch or delete that file. "
        "Then call the t3_background_wait tool with that background task id. Do not poll, sleep or read its output yourself. "
        "When the task finishes and you are notified, reply with only the line the command printed."
        % command
    )
    pair_file = pairing(ctx, "background-wait", deadline)
    code, out = t3(
        ctx,
        "background-wait",
        deadline,
        "thread start",
        "--provider",
        "claudeAgent",
        "--model",
        CLAUDE_MODEL,
        "--json",
        str(ctx.project),
        prompt,
        cap=60,
    )
    if code != 0:
        raise CheckFailed("t3 thread start exited %d" % code)
    thread_id = json.loads(out)["threadId"]
    result = client(
        ctx,
        "background-wait",
        deadline,
        "bgwait",
        "--pairing-file",
        str(pair_file),
        "--thread",
        thread_id,
        "--marker",
        marker,
        "--release-file",
        str(release),
        "--timeout",
        str(int(deadline.left()) - 15),
    )
    return (
        "held Working from %ss to %ss; release file written at %ss after %.3fs held, wake at %ss, follow-up run settled completed with the task output; idle gaps at %s"
        % (
            result["heldAtSeconds"],
            result["releasedAtSeconds"],
            result["releaseWrittenAtSeconds"],
            result["heldBeforeReleaseSeconds"],
            result["wakeAtSeconds"],
            result["idleWhileHeldRunAtSeconds"],
        )
    )


def queue_drain(ctx, deadline, scenario):
    name = "queue-drain" if scenario == "complete" else "queue-interrupt"
    result = client(
        ctx,
        name,
        deadline,
        "queue-drain",
        "--pairing-file",
        str(pairing(ctx, name, deadline)),
        "--cli",
        ctx.t3,
        "--home",
        str(ctx.home),
        "--project",
        str(ctx.project),
        "--model",
        CLAUDE_MODEL,
        "--scenario",
        scenario,
        "--timeout",
        str(min(180, int(deadline.left()) - 15)),
    )
    return (
        "%s: two distinct queued runs completed automatically, %d exactly-once persisted replies, no pending work; thread %s"
        % (
            scenario,
            result["exactlyOnceReplies"],
            result["threadId"],
        )
    )


def delegated_child_drain(ctx, deadline):
    from types import SimpleNamespace
    from .rehearsal_drain import configure_replay

    configure_replay(SimpleNamespace(home=ctx.home, evidence=ctx.work, args=SimpleNamespace(rpc_tree=ctx.tree)))
    script = ctx.home / "runtime/drain-replay/dev-replay-agent.ts"
    import shutil
    shutil.copy2(Path(__file__).with_name("drain_replay.mjs"), script.parent / "drain_replay.mjs")
    text = script.read_text().replace('import * as NodeCrypto', 'import { drainTurn } from "./drain_replay.mjs";\nimport * as NodeCrypto')
    text = text.replace('if (turn !== undefined) ended = await playTurn(sessionId, turn, controller.signal);', 'await drainTurn(params, sessionId, session.promptCount, send, controller.signal);')
    script.write_text(text)
    receipt = getattr(ctx, "out", ctx.work) / "delegated-child-drain.json"
    try:
        result = client(ctx, "delegated-child-drain", deadline, "queue-drain", "--pairing-file", str(pairing(ctx, "delegated-child-drain", deadline)), "--cli", ctx.t3, "--home", str(ctx.home), "--project", str(ctx.project), "--scenario", "delegated-drain", "--timeout", "170")
    except CheckFailed as error:
        failure = {"check": "delegated-child-drain", "ok": False, "error": str(error)}
        for line in Path(ctx.log("delegated-child-drain")).read_text().splitlines():
            if line.startswith('{"check":"delegated-child-drain"'):
                failure.update(json.loads(line))
        observations = script.parent / "observations.ndjson"
        if observations.exists():
            failure["agentObservations"] = [json.loads(line) for line in observations.read_text().splitlines()]
        receipt.write_text(json.dumps(failure, indent=2) + "\n")
        raise
    receipt.write_text(json.dumps(result, indent=2) + "\n")
    return "delegated-child-drain: parent waiting, task retained, child finished and completion delivered after 120s drain"


def queue_complete(ctx, deadline):
    return queue_drain(ctx, deadline, "complete")


def queue_interrupt(ctx, deadline):
    return queue_drain(ctx, deadline, "interrupt")


def starting_send(ctx, deadline):
    name = "starting-send"
    result = client(ctx, name, deadline, "queue-drain", "--pairing-file", str(pairing(ctx, name, deadline)), "--cli", ctx.t3,
                    "--home", str(ctx.home), "--project", str(ctx.project), "--model", CLAUDE_MODEL, "--scenario", "starting-send",
                    "--timeout", str(min(180, int(deadline.left()) - 15)))
    if result.get("inconclusive"):
        return "inconclusive: %s; delivered %s; thread %s" % (result["inconclusive"], result["sentDelivery"], result["threadId"])
    return "auto send into a starting run was delivered %s; both runs completed with %d exactly-once replies; thread %s" % (
        result["sentDelivery"], result["exactlyOnceReplies"], result["threadId"])


def queue_restart(ctx, deadline):
    name = "queue-restart"
    args = [
        "--cli",
        ctx.t3,
        "--home",
        str(ctx.home),
        "--project",
        str(ctx.project),
        "--model",
        CLAUDE_MODEL,
        "--timeout",
        "120",
    ]
    prepared = client(
        ctx,
        name,
        deadline,
        "queue-drain",
        "--pairing-file",
        str(pairing(ctx, name, deadline)),
        *args,
        "--scenario",
        "prepare-restart",
    )
    if ctx.server is None or ctx.server.poll() is not None:
        raise CheckFailed("owned scratch server exited before restart")
    ctx.server.send_signal(signal.SIGTERM)
    try:
        ctx.server.wait(timeout=deadline.left(60))
    except subprocess.TimeoutExpired as error:
        raise CheckFailed("owned server did not stop gracefully") from error
    start_server(ctx, deadline)
    wait_for_pair_discovery(ctx, deadline, name)
    result = client(
        ctx,
        name,
        deadline,
        "queue-drain",
        "--pairing-file",
        str(pairing(ctx, name, deadline)),
        *args,
        "--scenario",
        "recover",
        "--thread",
        prepared["threadId"],
        "--queued-run",
        prepared["queuedRun"],
        "--markers",
        json.dumps(prepared["markers"]),
    )
    return (
        "restart recovery and later idle CLI send completed with %d exactly-once replies and no holds; thread %s"
        % (result["exactlyOnceReplies"], result["threadId"])
    )


CHECKS = [
    ("boot", 600, boot),
    ("pairing", 120, pair),
    ("mobile", 180, mobile),
    ("claude-turn", 240, claude_turn),
    ("codex-turn", 240, codex_turn),
    ("background-wait", 300, background_wait),
    ("queue-drain", 300, queue_complete),
    ("delegated-child-drain", 240, delegated_child_drain),
    ("queue-interrupt", 300, queue_interrupt),
    ("starting-send", 240, starting_send),
    ("queue-restart", 420, queue_restart),
]
