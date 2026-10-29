import fcntl
import json
import shutil
import subprocess
import sys
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

from .release_actions import run_action
from .release_admission import heavy_owner
from .release_config import parse
from .release_graph import GRAPH, studio_first_graph
from .release_ownership import ownership, release_local, verify_tree
from .release_outputs import completed, valid_output, remote_archive_exists
from .release_timeline import Timeline
from .release_transport import remote_disk_free


INSTALLS = {"install-ax42", "install-studio", "desktop-swap"}
HEAVY = {
    "assemble",
    "mac-cli",
    "linux-cli",
    "desktop",
    "gate",
    "stage-review",
    "install-ax42",
    "install-studio",
    "desktop-swap",
}
STUDIO_EXT_MIN_FREE = 60 * 1024**3
INTERNAL_MIN_FREE = 25 * 1024**3
REMOTE_MIN_FREE = 25 * 1024**3


def selected_graph(until, *, studio_first=False):
    graph = studio_first_graph() if studio_first else GRAPH
    if not until:
        return graph
    names = {until}
    for stage in reversed(graph):
        if stage.name in names:
            names.update(stage.needs)
    return tuple(stage for stage in graph if stage.name in names)


def execute(stage, config, log):
    if stage.name in HEAVY:
        for path, floor in (
            ("/Volumes/StudioExt", STUDIO_EXT_MIN_FREE),
            ("/", INTERNAL_MIN_FREE),
        ):
            if shutil.disk_usage(path).free < floor:
                raise RuntimeError(
                    f"disk guard: {path} has under {floor >> 30} GiB free"
                )
        if remote_disk_free(log) < REMOTE_MIN_FREE:
            raise RuntimeError("disk guard: ax42 / has under 25 GiB free")
    if stage.name in HEAVY and stage.host == "studio" and stage.name not in INSTALLS:
        with heavy_owner(config.run, stage.name, log) as admitted:
            code = run_action(stage.name, config, log) if admitted else 10
    else:
        code = run_action(stage.name, config, log)
    if code == 0 and not valid_output(config, stage.name):
        raise RuntimeError(
            f"{stage.name} exited zero but required outputs are missing or invalid"
        )
    return code


def drive(config, graph):
    config.bind()
    done = completed(config, graph)
    try:
        assembly = config.run / "assembly.json"
        if assembly.is_file():
            head = json.loads(assembly.read_text())["head"]
            with (config.run / "ownership.log").open("a") as log:
                for tree in (
                    config.candidate,
                    config.tree("mac-cli"),
                    config.tree("desktop"),
                ):
                    if tree.exists():
                        verify_tree(tree, head)
                        ownership("lease", tree, log)
                        config.owned_trees[tree] = head
        if "linux-cli" in done:
            with (config.run / "resume.log").open("a") as log:
                if not remote_archive_exists(config, log):
                    done.difference_update(
                        {
                            "linux-cli",
                            "gate",
                            "awaiting-verdict",
                            "install-ax42",
                            "install-studio",
                            "desktop-swap",
                            "publish-feed",
                        }
                    )
        timeline = Timeline(config.run / "timeline.jsonl")
        pending = {stage.name: stage for stage in graph if stage.name not in done}
        failure = 0
        with ThreadPoolExecutor(max_workers=len(graph)) as pool:
            running = {}
            while pending or running:
                ready = (
                    [stage for stage in pending.values() if set(stage.needs) <= done]
                    if not failure
                    else []
                )
                busy_hosts = {
                    stage.host for stage in running.values() if stage.name in HEAVY
                }
                for stage in ready:
                    if stage.name in HEAVY and stage.host in busy_hosts:
                        continue
                    if stage.name in HEAVY:
                        busy_hosts.add(stage.host)
                    del pending[stage.name]
                    future = pool.submit(
                        timeline.run,
                        stage,
                        config.run / f"{stage.name}.log",
                        lambda log, stage=stage: execute(stage, config, log),
                    )
                    running[future] = stage
                if not running:
                    break
                finished, _ = wait(running, return_when=FIRST_COMPLETED)
                for future in finished:
                    stage = running.pop(future)
                    code = future.result()
                    if code:
                        failure = code
                    else:
                        done.add(stage.name)
    finally:
        release_local(config)
    if failure:
        print(f"release stopped; completed: {', '.join(sorted(done))}", file=sys.stderr)
    return failure


def main():
    config, args = parse()
    graph = selected_graph(args.until, studio_first=args.studio_first)
    if args.plan:
        done = completed(config, graph)
        for stage in graph:
            state = "skip (exit 0 + outputs)" if stage.name in done else "would run"
            print(
                f"{stage.name} [{stage.host}] <- {', '.join(stage.needs) or 'none'}: {state}"
            )
        print(f"verdict: {config.verdict}; missing approval pauses with exit 10")
        print("desktop-swap never quits/reopens the app; do that step yourself")
        return 0
    cuts_over = any(stage.name.startswith("install-") for stage in graph)
    lock_name = "cutover.lock" if cuts_over else f"release-{config.version}.lock"
    lock_path = Path.home() / ".t3nightly" / lock_name
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("release: another run holds the lock", file=sys.stderr)
            return 2
        try:
            return drive(config, graph)
        except (
            OSError,
            ValueError,
            RuntimeError,
            subprocess.SubprocessError,
            json.JSONDecodeError,
        ) as error:
            print(f"release: {error}", file=sys.stderr)
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
