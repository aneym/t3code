import json
import sys
from concurrent.futures import ThreadPoolExecutor

from .release_transport import command


def fast_advisory(config, log):
    out = config.run / "advisory"
    tree = config.tree("mac-cli")
    words = [sys.executable, str(config.tools / "suite-plan"), "--tree", str(tree), "--out", str(out / "plan.json")]
    if not (out / "plan.json").is_file() and command(words, log):
        return 1
    jobs = json.loads((out / "plan.json").read_text())["jobs"]

    def one(job):
        target = out / (job["id"].replace("/", "-") + ".json")
        with (out / (target.stem + ".log")).open("a") as handle:
            return command([sys.executable, str(config.tools / "suite-worker"), "--plan", str(out / "plan.json"), "--job", job["id"],
                            "--host", job["hosts"][0], "--out", str(target)], handle)

    with ThreadPoolExecutor(max_workers=max(1, min(2, config.advisory_workers))) as pool:
        codes = list(pool.map(one, jobs))
    (out / "summary.json").write_text(json.dumps({"jobs": len(jobs), "passed": codes.count(0), "notPassed": len(codes) - codes.count(0)}) + "\n")
    return 0 if not any(codes) else 1
