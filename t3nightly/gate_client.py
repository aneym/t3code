import json
import re
from pathlib import Path

from .gate_proc import CheckFailed, run


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


