LINUX_TARGETS = {"ax42": "ax42", "forge": "forge", "owl": "pc-wsl", "ax102": "ax102"}
TARGET_SUFFIXES = {"studio": "M", "ax42": "L", "forge": "F", "owl": "O", "ax102": "B"}
HOST_ACTIONS = {"I": "install", "T": "stage-linux"}


def linux_target(alias):
    for host, address in LINUX_TARGETS.items():
        if alias in (host, address):
            return host
    raise ValueError(f"unknown Linux target: {alias}")


def stage_target(stage):
    if len(stage) == 2 and stage[0] in HOST_ACTIONS:
        return next((host for host, suffix in TARGET_SUFFIXES.items() if suffix == stage[1]), None)
    return None


def stage_action(stage):
    return HOST_ACTIONS[stage[0]] if stage_target(stage) else stage
