import json
import re
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone

from .gate_checks import CLAUDE_MODEL, t3
from .gate_proc import CheckFailed
from .gate_tools import Mcp, last_reply, wait_for

AGENT_HANDLE = "smoke-agent"
AGENT_NAME = "Smoke agent"
SNOOZE_SECONDS = 20


def marker(word):
    return "%s-%d" % (word, 1000 + secrets.randbelow(9000))


def iso_in(seconds):
    moment = datetime.now(timezone.utc) + timedelta(seconds=seconds)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def cli(ctx, name, deadline, words, *args):
    code, out = t3(ctx, name, deadline, words, *args, cap=60)
    if code != 0:
        raise CheckFailed("t3 %s exited %d" % (words, code))
    return out


def cli_json(ctx, name, deadline, words, *args):
    out = cli(ctx, name, deadline, words, *args, "--json")
    return json.loads(out[out.index("{"):]) if "{" in out else {}


def replied(word):
    return lambda view: word in last_reply(view)


def ask(word):
    return "Reply with exactly the word %s and nothing else." % word


def thread_item(ctx, name, deadline, thread_id):
    shown = cli_json(ctx, name, deadline, "thread show", thread_id)
    project_id = (shown.get("thread") or {}).get("projectId")
    mcp = Mcp(ctx, name, deadline)
    listed = mcp.call("t3_thread_list", {"projectId": project_id, "limit": 100, "includeSubagents": True})
    for item in listed.get("threads") or []:
        if item.get("threadId") == thread_id:
            return item
    raise CheckFailed("t3_thread_list does not list %s" % thread_id)


def start_thread(ctx, name, deadline, project, word):
    started = cli_json(
        ctx, name, deadline, "thread start", "--provider", "claudeAgent", "--model", CLAUDE_MODEL, str(project), ask(word)
    )
    thread_id = started.get("threadId")
    if not thread_id:
        raise CheckFailed("t3 thread start printed no threadId")
    wait_for(ctx, name, deadline, thread_id, replied(word))
    return thread_id


def create_thread(ctx, deadline):
    word = marker("PONG")
    ctx.smoke_word = word
    ctx.smoke_thread = start_thread(ctx, "thread", deadline, ctx.project, word)
    return "thread %s started and replied %s" % (ctx.smoke_thread, word)


def send(ctx, deadline):
    word = marker("SENT")
    cli(ctx, "send", deadline, "thread send", ctx.smoke_thread, ask(word))
    wait_for(ctx, "send", deadline, ctx.smoke_thread, replied(word))
    return "follow-up send answered %s" % word


def restart(ctx, deadline):
    cli(ctx, "restart", deadline, "thread restart", ctx.smoke_thread)
    word = marker("RESTARTED")
    cli(ctx, "restart", deadline, "thread send", ctx.smoke_thread, ask(word))
    shown = wait_for(ctx, "restart", deadline, ctx.smoke_thread, replied(word))
    texts = [m["text"] for m in shown.get("messages") or [] if m["role"] == "assistant"]
    return "session restarted, next turn answered %s; %d assistant messages kept" % (word, len(texts))


def snooze(ctx, deadline):
    ctx.wake_at = time.monotonic() + SNOOZE_SECONDS
    cli(ctx, "snooze", deadline, "thread snooze", ctx.smoke_thread, "--snoozed-until", iso_in(SNOOZE_SECONDS))
    item = thread_item(ctx, "snooze", deadline, ctx.smoke_thread)
    if item.get("snoozed") is not True or not item.get("snoozedUntil"):
        raise CheckFailed("thread not shown snoozed: %s" % json.dumps({k: item.get(k) for k in ("snoozed", "snoozedUntil")}))
    return "snoozed until %s" % item["snoozedUntil"]


def wake(ctx, deadline):
    pause = ctx.wake_at - time.monotonic() + 2
    if pause > 0:
        deadline.left(pause + 30)
        time.sleep(pause)
    item = thread_item(ctx, "wake", deadline, ctx.smoke_thread)
    if item.get("snoozed") is not False:
        raise CheckFailed("thread still snoozed after its wake time")
    cli(ctx, "wake", deadline, "thread snooze", ctx.smoke_thread, "--snoozed-until", iso_in(3600))
    if thread_item(ctx, "wake", deadline, ctx.smoke_thread).get("snoozed") is not True:
        raise CheckFailed("second snooze did not take")
    cli(ctx, "wake", deadline, "thread unsnooze", ctx.smoke_thread)
    if thread_item(ctx, "wake", deadline, ctx.smoke_thread).get("snoozed") is not False:
        raise CheckFailed("unsnooze left the thread snoozed")
    return "woke on its own at the snooze time; a 1h snooze cleared with unsnooze"


def move(ctx, deadline):
    target = ctx.agent_homes / AGENT_HANDLE
    added = cli(ctx, "move", deadline, "project add", "--title", "t3smoke-agent", str(target))
    found = re.search(r"Added project (\S+)", added)
    if not found:
        raise CheckFailed("t3 project add printed no project id")
    project_id = ctx.agent_project = found.group(1)
    cli(ctx, "move", deadline, "thread move", ctx.smoke_thread, project_id)
    item = thread_item(ctx, "move", deadline, ctx.smoke_thread)
    if item.get("projectId") != project_id:
        raise CheckFailed("thread still in project %s after move" % item.get("projectId"))
    return "thread moved to project %s" % project_id


def agent_file(ctx):
    return ctx.agent_homes / AGENT_HANDLE / "agent.json"


def bind_to(ctx, name, deadline, thread_id):
    result = cli_json(ctx, name, deadline, "agent bind", AGENT_HANDLE, thread_id)
    written = json.loads(agent_file(ctx).read_text()).get("t3") or {}
    listed = cli_json(ctx, name, deadline, "agent list")
    homes = {home["handle"]: home for home in listed.get("homes") or []}
    shown = ((homes.get(AGENT_HANDLE) or {}).get("binding") or {}).get("threadId")
    if written.get("thread_id") != thread_id or shown != thread_id:
        raise CheckFailed("bind to %s left agent.json at %r and agent list at %r" % (thread_id, written.get("thread_id"), shown))
    if not written.get("environment_id"):
        raise CheckFailed("agent.json binding has no environment_id")
    return result.get("changed"), written


def bind(ctx, deadline):
    changed, _ = bind_to(ctx, "bind", deadline, ctx.smoke_thread)
    again, _ = bind_to(ctx, "bind", deadline, ctx.smoke_thread)
    if changed is not True or again is not False:
        raise CheckFailed("bind reported changed=%s, then changed=%s for the same thread" % (changed, again))
    return "%s bound to %s (changed), same bind unchanged" % (AGENT_HANDLE, ctx.smoke_thread)


def agent_turn(ctx, name, deadline, prompt, pattern):
    cli(ctx, name, deadline, "thread send", ctx.smoke_thread, prompt)
    found = re.compile(pattern)
    shown = wait_for(ctx, name, deadline, ctx.smoke_thread, lambda view: found.search(last_reply(view)))
    match = found.search(last_reply(shown))
    if match is None:
        raise CheckFailed("%s reply lost its %s match" % (name, pattern))
    return match.group(1)


def schedule(ctx, deadline):
    ctx.schedule_word = marker("SCHEDULED")
    ctx.schedule_task = agent_turn(
        ctx,
        "schedule",
        deadline,
        "Call T3's schedule_task tool with title 't3 smoke schedule', schedule {type: 'interval', everyMs: 86400000}, "
        "bindToCurrentThread false, and prompt '%s'. Then reply with only TASK=<the scheduled task id>." % ask(ctx.schedule_word),
        r"TASK=(\S+)",
    )
    listed = Mcp(ctx, "schedule", deadline).call("list_scheduled_tasks", {})
    tasks = listed.get("tasks") if isinstance(listed, dict) else listed
    saved = [t for t in tasks or [] if ctx.schedule_task in (t.get("id"), t.get("scheduledTaskId"))]
    if not saved:
        raise CheckFailed("list_scheduled_tasks lacks %s" % ctx.schedule_task)
    return "agent scheduled task %s, next run %s" % (ctx.schedule_task, saved[0].get("nextRunAt"))


def run_now(ctx, deadline):
    thread_id = agent_turn(
        ctx,
        "run-now",
        deadline,
        "Call T3's run_scheduled_task_now tool with taskId '%s'. Reply with only RUN=<the thread id it returns>." % ctx.schedule_task,
        r"RUN=(\S+)",
    )
    try:
        wait_for(ctx, "run-now", deadline, thread_id, replied(ctx.schedule_word))
    except CheckFailed:
        detail = Mcp(ctx, "run-now", deadline).post("tools/call", {"name": "t3_thread_read", "arguments": {"threadId": thread_id}})
        with open(ctx.log("run-now"), "a") as handle:
            handle.write("[thread-read] %s\n" % json.dumps(detail)[:20000])
            db = sqlite3.connect("file:%s?mode=ro" % (ctx.home / "userdata/statev2.sqlite"), uri=True)
            for table in ("orchestration_v2_projection_runs", "orchestration_v2_projection_run_attempts"):
                for found in db.execute("select * from %s where thread_id = ?" % table, (thread_id,)):
                    handle.write("[%s] %s\n" % (table, json.dumps(found, default=str)[:6000]))
            db.close()
        raise
    return "run-now thread %s answered %s" % (thread_id, ctx.schedule_word)


CHECKS = [
    ("thread", 240, create_thread),
    ("send", 180, send),
    ("restart", 240, restart),
    ("snooze", 60, snooze),
    ("wake", 90, wake),
    ("schedule", 180, schedule),
    ("run-now", 300, run_now),
    ("move", 90, move),
    ("bind", 60, bind),
]
