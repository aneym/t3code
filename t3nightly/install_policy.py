import json
import os
import platform
from datetime import datetime, timezone
from pathlib import Path


LIVE_SERVICES = {"t3code.service", "com.t3tools.t3code.service"}
MAX_ADMISSION_AGE_S = 7200
STATE = Path.home() / ".agent-rails/lanes/t3-fast-release/STATE.md"


def live_homes(extra=()):
    if os.name == "posix":
        import pwd

        owner = Path(pwd.getpwuid(os.getuid()).pw_dir)
    else:
        owner = Path.home()
    roots = [owner / ".t3", Path.home() / ".t3", *map(Path, extra)]
    if os.environ.get("T3CODE_HOME"):
        roots.append(Path(os.environ["T3CODE_HOME"]))
    return {path.expanduser().resolve() for path in roots}


def overlaps(home, extra=()):
    home = Path(home).expanduser().resolve()
    return any(home == root or home.is_relative_to(root) or root.is_relative_to(home) for root in live_homes(extra))


def isolated(home, port, service, extra=()):
    return not overlaps(home, extra) and port not in (3773, 3000) and service not in LIVE_SERVICES and service.startswith(("t3-rehearsal-", "com.t3-rehearsal."))


def refuse_probe(home, port, service, extra=()):
    if not isolated(home, port, service, extra):
        raise ValueError("restart/rollback/drain proof refused: live home, port or service; use a private home, non-live port and t3-rehearsal-* service")


def window(version, *, reason="", host=None, sandbox=False):
    moment = datetime.now(timezone.utc)
    reason = reason.strip()
    if any(char in reason for char in "\r\n\x00"):
        raise ValueError("--override-reason must be a single line")
    allowed = moment.hour in (8, 18) and moment.minute == 0
    receipt = {"at": moment.isoformat(), "host": host or platform.node(), "version": version, "windowsUtc": ["08:00Z", "18:00Z"], "isolated": sandbox, "overrideReason": reason or None, "allowed": sandbox or allowed or bool(reason)}
    if not receipt["allowed"]:
        raise ValueError("live install outside 08:00Z/18:00Z admission windows; requires --override-reason '<text>'")
    if reason and not sandbox:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        line = "\n- Install-window override: " + json.dumps(receipt, separators=(",", ":")) + "\n"
        fd = os.open(STATE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, line.encode())
            os.fsync(fd)
        finally:
            os.close(fd)
    return receipt


def enforce(args):
    home, port, service = args.home, args.port, args.service_label
    extra = getattr(args, "live_home", [])
    if any(getattr(args, name, False) for name in ("rehearsal", "force_rollback", "compatibility_probe", "restart_probe", "drain_proof")):
        refuse_probe(home, port, service, extra)
    sandbox = isolated(home, port, service, extra)
    if args.dry_run or args.check_only or args.prepare_only:
        return {"isolated": sandbox, "mutation": False}
    state = Path(args.state_dir).expanduser()
    state.mkdir(parents=True, exist_ok=True)
    try:
        policy = window(args.version, reason=args.override_reason, sandbox=sandbox)
    except ValueError as error:
        (state / "install-window.json").write_text(json.dumps({"allowed": False, "error": str(error), "version": args.version}) + "\n")
        raise
    (state / "install-window.json").write_text(json.dumps(policy) + "\n")
    return policy


def admit(run, policy):
    run.report["installWindow"] = policy
    run.cutover_admitted = policy.get("allowed") is True
    run.admitted_at = policy.get("at")


def recheck(run):
    policy = run.report.get("installWindow", {})
    if not getattr(run, "cutover_admitted", False) or policy.get("allowed") is not True:
        raise ValueError("service mutation requires a recorded install admission")
    admitted = datetime.fromisoformat(policy["at"])
    age = (datetime.now(timezone.utc) - admitted).total_seconds()
    if not 0 <= age <= MAX_ADMISSION_AGE_S:
        raise ValueError("install admission expired; re-run the installer inside a window or with --override-reason")
    if policy.get("version") not in (None, run.args.version):
        raise ValueError("install admission version mismatch")


def admitted_environment(policy, environment=None):
    child = dict(os.environ if environment is None else environment)
    child.pop("T3NIGHTLY_INSTALL_WINDOW", None)
    if policy.get("allowed") is not True:
        raise ValueError("service mutation requires a passed install-window gate")
    if not policy.get("isolated"):
        child["T3NIGHTLY_INSTALL_WINDOW"] = "1"
    return child


def command_environment(run, environment=None):
    recheck(run)
    return admitted_environment(run.report["installWindow"], environment)
