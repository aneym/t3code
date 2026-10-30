import json
import logging
import math
import os
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def restart_session(run, previous):
    binary = run.runtime(previous)
    ttl = f"{30 + math.ceil(getattr(run.args, 'drain_s', 0) / 60)}m"
    args = [
        str(binary),
        "auth",
        "session",
        "issue",
        "--base-dir",
        str(run.home),
        "--json",
        "--ttl",
        ttl,
        "--label",
        "t3nightly-seamless",
    ]
    scopes = ("orchestration:read", "orchestration:operate", "environment:maintain")
    for scope in scopes:
        args.extend(["--scope", scope])
    issued = subprocess.run(
        args, capture_output=True, text=True, timeout=60, check=False
    )
    if issued.returncode:
        raise ValueError("could not issue the private installer maintenance session")
    value = json.loads(issued.stdout)
    token = value["token"]
    session = value["sessionId"]
    if hasattr(run, "step"):
        run.step("maintenance-session", session_id=session, scopes=scopes, ttl=ttl)
    with tempfile.TemporaryDirectory(
        prefix=".restart-rpc-", dir=run.state, ignore_cleanup_errors=True
    ) as raw:
        bearer = Path(raw) / "bearer"
        revoker = Path(raw) / "t3"
        try:
            os.link(binary, revoker)
        except OSError:
            shutil.copy2(binary, revoker)
        try:
            bearer.write_text(token)
            os.chmod(bearer, 0o600)
            yield bearer
        finally:
            try:
                revoke_binary = revoker
                state = run.home / "runtime/service-state.json"
                if state.is_file():
                    active = json.loads(state.read_text()).get("activeVersion", "")
                    if active and Path(active).name == active and active not in (".", ".."):
                        current = run.home / "runtime/versions" / active / "t3"
                        if current.is_file():
                            revoke_binary = current
                revoked = subprocess.run(
                    [
                        str(revoke_binary),
                        "auth",
                        "session",
                        "revoke",
                        session,
                        "--base-dir",
                        str(run.home),
                    ],
                    capture_output=True,
                    timeout=60,
                    check=False,
                )
                if revoked.returncode:
                    logging.warning(
                        "installer maintenance session revoke failed (exit %s); session expires after its %s TTL",
                        revoked.returncode,
                        ttl,
                    )
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                logging.warning(
                    "installer maintenance session revoke failed (%s); session expires after its %s TTL",
                    type(error).__name__,
                    ttl,
                )


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
