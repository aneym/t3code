import json
import logging
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def restart_session(run, previous):
    binary = run.runtime(previous)
    ttl = f"{30 + math.ceil(getattr(run.args, 'drain_s', 0) / 60)}m"
    scopes = getattr(run.args, "auth_scopes", ("orchestration:read", "orchestration:operate", "environment:maintain"))
    args = [str(binary), "auth", "session", "issue", "--base-dir", str(run.home), "--json", "--ttl", ttl, "--label", "t3nightly-seamless"]
    for scope in scopes:
        args.extend(["--scope", scope])
    watched = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGALRM)
    mask = signal.pthread_sigmask(signal.SIG_BLOCK, watched)
    audit = {"scopes": list(scopes), "ttl": ttl, "issued": False, "revokeAttempted": False, "revokeVerified": False, "authFileRemoved": False}
    run.session_auth = audit
    session = None
    directory = None
    try:
        with tempfile.TemporaryDirectory(prefix=".restart-rpc-", dir=run.state, ignore_cleanup_errors=not getattr(run.args, "strict_auth_cleanup", False)) as raw:
            directory = Path(raw)
            bearer = directory / "bearer"
            revoker = directory / "t3"
            from .rehearsal_storage import clone_file, enabled

            if sys.platform == "darwin" and enabled(run.home):
                clone_file(binary, revoker)
            else:
                try:
                    os.link(binary, revoker)
                except OSError:
                    shutil.copy2(binary, revoker)
            try:
                issued = subprocess.run(args, capture_output=True, text=True, timeout=60, check=False)
                if issued.returncode:
                    raise ValueError("could not issue the private installer session")
                value = json.loads(issued.stdout)
                session = value["sessionId"]
                audit.update(issued=True, sessionId=session)
                fd = os.open(bearer, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w") as handle:
                    handle.write(value["token"])
                if hasattr(run, "step"):
                    run.step("maintenance-session", session_id=session, scopes=scopes, ttl=ttl)
                signal.pthread_sigmask(signal.SIG_SETMASK, mask)
                yield bearer
            finally:
                signal.pthread_sigmask(signal.SIG_BLOCK, watched)
                if session is not None:
                    audit["revokeAttempted"] = True
                    try:
                        state = run.home / "runtime/service-state.json"
                        active = json.loads(state.read_text()).get("activeVersion", "") if state.is_file() else ""
                        current = run.home / "runtime/versions" / active / "t3" if active and Path(active).name == active and active not in (".", "..") else revoker
                        revoke_binary = current if current.is_file() else revoker
                        revoked = subprocess.run([str(revoke_binary), "auth", "session", "revoke", session, "--base-dir", str(run.home)], capture_output=True, text=True, timeout=60, check=False)
                        audit["revokeExit"] = revoked.returncode
                        audit["revokeAcknowledged"] = revoked.returncode == 0 and any(line.strip() in (f"Revoked session {session}.", f"No active session found for {session}.") for line in revoked.stdout.splitlines())
                        listed = subprocess.run([str(revoke_binary), "auth", "session", "list", "--json", "--base-dir", str(run.home)], capture_output=True, text=True, timeout=30, check=False)
                        audit["verificationExit"] = listed.returncode
                        sessions = json.loads(listed.stdout) if listed.returncode == 0 else None
                        audit["sessionAbsent"] = isinstance(sessions, list) and not any(row.get("sessionId", row.get("id")) == session for row in sessions)
                        audit["revokeVerified"] = audit["revokeAcknowledged"] and audit["sessionAbsent"]
                        if not audit["revokeVerified"]:
                            logging.warning("private installer session revoke could not be verified; bounded TTL remains")
                    except (OSError, ValueError, subprocess.SubprocessError) as error:
                        audit["revokeError"] = type(error).__name__
                        logging.warning("private installer session revoke failed (%s); bounded TTL remains", type(error).__name__)
    finally:
        audit["authFileRemoved"] = directory is not None and not directory.exists()
        signal.pthread_sigmask(signal.SIG_SETMASK, mask)


def restart_rpc(run, bearer, operation, payload, *, timeout=120):
    environment = dict(os.environ)
    environment.pop("T3NIGHTLY_INSTALL_WINDOW", None)
    if operation == "update":
        from .install_policy import command_environment

        environment = command_environment(run)
    tree = Path(run.args.rpc_tree).expanduser().resolve()
    if not tree.is_dir():
        raise ValueError(
            "seamless installation requires the frozen RPC dependency tree"
        )
    with tempfile.NamedTemporaryFile(
        mode="w", prefix=".restart-request-", dir=run.state, delete=False
    ) as handle:
        json.dump(payload, handle)
        path = Path(handle.name)
    try:
        result = subprocess.run(
            [
                run.args.node,
                str(Path(__file__).parent / "client.mjs"),
                "restart-rpc",
                "--tree",
                str(tree),
                "--origin",
                f"http://127.0.0.1:{run.args.port}",
                "--bearer-file",
                str(bearer),
                "--operation",
                operation,
                "--request-file",
                str(path),
            ],
            capture_output=True,
            env=environment,
            text=True,
            timeout=timeout,
            check=False,
        )
        rows = [line for line in result.stdout.splitlines() if line.startswith("{")]
        response = json.loads(rows[-1]) if rows else {}
        if result.returncode or response.get("ok") is not True:
            raise ValueError(
                f"server {operation} did not return a verified restart receipt"
            )
        return response["receipt"]
    finally:
        path.unlink(missing_ok=True)
