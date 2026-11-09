import hashlib
import json
import shlex
import shutil

from .release_ownership import ownership
from .release_targets import LINUX_TARGETS
from .release_transport import require
from .remote_shell import ssh_argv


def require_host_ready(config, *, install=False, build=False):
    ready = json.loads((config.run / "readiness.json").read_text())
    checks = dict(ready["hostChecks"][config.host])
    for name in checks:
        if name == "disk" or name.startswith("disk:"):
            path = name.removeprefix("disk:") if name.startswith("disk:") else "/"
            floor = 20 if path == "/Volumes/StudioExt" else 25
            checks[name] = shutil.disk_usage(path).free >= floor * 1024**3
    if install:
        checks["not-held"] = not config.held
    else:
        checks.pop("not-held", None)
    if build:
        checks = {name: ok for name, ok in checks.items() if name.startswith("disk") or name in ("reachable", ".vite-plus/bin/vp", ".cargo/bin/cargo", ".config/t3nightly/public-config.env")}
    failed = sorted(name for name, ok in checks.items() if not ok)
    if failed:
        raise ValueError(f"{config.host}: host admission refused: {', '.join(failed)}; other host lanes are independent")


def prepare_dependencies(config, head, log, tree_factory):
    if config.host == "studio" or config.host == config.build_host:
        return
    require(["git", "-C", str(config.repo), "fetch", str(config.run / "candidate.bundle"), "HEAD"], log)
    tree = tree_factory(config, "linux-cli", head, log)
    try:
        require([str(config.home / ".vite-plus/bin/vp"), "i", "--frozen-lockfile"], log, cwd=tree)
    finally:
        ownership("release", tree, log)


def stage_linux(config, host, log):
    if config.host != config.build_host:
        raise ValueError(f"stage-linux runs on the Linux builder {config.build_host}, not {config.host}")
    source = config.build_out()
    target = config.on(host)
    artifact = json.loads((source / target.artifact().name).read_text())
    with (source / artifact["archive"]["name"]).open("rb") as handle:
        if hashlib.file_digest(handle, "sha256").hexdigest() != artifact["archive"]["sha256"]:
            raise ValueError(f"{source}: builder archive does not match its artifact manifest")
    require(["rsync", "-e", shlex.join(ssh_argv()), "-a", "--partial", f"--rsync-path=mkdir -p {shlex.quote(str(target.build_out()))} && rsync", "--",
             str(source) + "/", f"{LINUX_TARGETS[host]}:{target.build_out()}/"], log)
    (config.run / f"payload-{host}.json").write_text(json.dumps({"archive": artifact["archive"]["sha256"]}) + "\n")
    return 0
