import json
import signal
import sys
from concurrent.futures import ThreadPoolExecutor

from .release_targets import LINUX_TARGETS
from .release_transport import command
from .suite_store import maintain


def live_hosts(jobs, deferred):
    skip = {*deferred, *(LINUX_TARGETS[host] for host in deferred)}
    return {job["id"]: [host for host in job["hosts"] if host not in skip] for job in jobs}


def fast_advisory(config, log):
    cancelled = False

    def terminate(signum, frame):
        nonlocal cancelled
        cancelled = True

    signal.signal(signal.SIGTERM, terminate)
    out = config.run / "advisory"
    tree = config.tree("mac-cli")
    words = [sys.executable, str(config.tools / "suite-plan"), "--tree", str(tree), "--out", str(out / "plan.json")]
    if not (out / "plan.json").is_file() and command(words, log):
        return 1
    jobs = json.loads((out / "plan.json").read_text())["jobs"]

    hosts = live_hosts(jobs, config.defer_hosts)
    maintenance = maintain(config.run.parent, [live[0] for live in hosts.values() if live], log)

    def one(job):
        if cancelled:
            return 143
        if not hosts[job["id"]]:
            log.write(f"advisory skip: {job['id']} has no host outside deferred {', '.join(config.defer_hosts)}\n")
            return 0
        target = out / (job["id"].replace("/", "-") + ".json")
        with (out / (target.stem + ".log")).open("a") as handle:
            return command([sys.executable, str(config.tools / "suite-worker"), "--plan", str(out / "plan.json"), "--job", job["id"],
                            "--host", hosts[job["id"]][0], "--out", str(target)], handle)

    with ThreadPoolExecutor(max_workers=max(1, config.advisory_workers)) as pool:
        codes = list(pool.map(one, jobs))
    (out / "summary.json").write_text(json.dumps({"jobs": len(jobs), "passed": codes.count(0), "notPassed": len(codes) - codes.count(0), "maintenance": maintenance}) + "\n")
    return 0 if not any(codes) else 1
