from .release_eligibility import FORCED_ROLLBACK


def legacy_launcher(installer):
    steps = {step.get("step") for step in installer.get("steps", [])}
    hot_swap = installer.get("hotSwap", {})
    return (installer.get("environmentObserved") is True and installer.get("capabilities", {}).get("serverHotSwap") is not True and hot_swap.get("qualification", {}).get("qualified") is True
            and hot_swap.get("method") == "hot-swap-unsupported" and "hot-swap-unsupported" in steps)


def maintenance_rolled_back(installer):
    steps = installer.get("steps", [])
    hot_swap = installer.get("hotSwap", {})
    previous = installer.get("previous")
    if hot_swap.get("method") != "maintenance" or not previous or hot_swap.get("rollbackUpdate", {}).get("targetVersion") != previous:
        return False
    forced = next((index for index, step in enumerate(steps) if step.get("step") == "hard-failure" and step.get("error") == FORCED_ROLLBACK), None)
    if forced is None:
        return False
    update = next((index for index in range(forced + 1, len(steps)) if steps[index].get("step") == "launcher-request-update" and steps[index].get("target") == previous), None)
    if update is None:
        return False
    return any(step.get("step") == "hard-serving" and step.get("version") == previous for step in steps[update + 1:])


def hard_rolled_back(installer):
    if installer.get("outcome") != "rolled-back":
        return False
    legacy = legacy_launcher(installer) and any(step.get("step") == "hard-binary-rollback" for step in installer.get("steps", []))
    return legacy or maintenance_rolled_back(installer)
