import subprocess


def verify_tree(tree, head):
    current = subprocess.run(
        ["git", "-C", str(tree), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    if current != head:
        raise RuntimeError(f"existing build tree has a different HEAD: {tree}")


def ownership(action, tree, log):
    words = ["wt", action, str(tree), "--kind", "lane", "--id", "t3-nightly", "--json"]
    if action == "lease":
        words.extend(["--scope", "logical"])
    log.write(f"worktree ownership: {action} {tree}\n")
    log.flush()
    result = subprocess.run(words, stdout=log, stderr=subprocess.STDOUT, check=False)
    if result.returncode:
        raise RuntimeError(f"worktree {action} failed ({result.returncode}): {tree}")


def release_local(config):
    failures = []
    with (config.run / "ownership.log").open("a") as log:
        for tree, head in config.owned_trees.items():
            if not tree.exists():
                continue
            try:
                verify_tree(tree, head)
                ownership("release", tree, log)
            except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                log.write(f"{error}\n")
                failures.append(str(error))
    if failures:
        raise RuntimeError("; ".join(failures))
