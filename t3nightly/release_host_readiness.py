from .release_config import CHAT_PROJECT


def probe_host(config, log, host, value):
    from .release_readiness import REMOTE_FLOOR, remote_probe, serving_head, source_history

    remote = remote_probe(config, log, host)
    old = remote.get("serving")
    head = remote.get("head") or serving_head(config, old)
    if not head and old and old == value["oldReleases"]["studio"]:
        head = value["servingHead"]
    history = source_history(config.repo, head)
    value["oldReleases"][host] = old
    value["servingHeads"][host] = head
    value["servingHistories"][host] = history
    value["evidence"][host] = remote
    value["evidence"][f"{host}ServingHead"] = head
    value["checks"][f"{host}-base-assembly"] = bool(old and head and history)
    value["checks"][f"{host}-live-history"] = bool(history and remote.get("liveHistory") == history)
    value["checks"][f"{host}-engine"] = remote.get("engine") == value["engine"]["digest"]
    checks = value["hostChecks"][host] = {
        "reachable": bool(remote),
        "seed": bool(history and remote.get("seedHistories", {}).get(history) == history),
        "old-runtime": bool(old) and old in remote.get("runtimes", []),
        "not-held": remote.get("held") is False,
        "disk": remote.get("disk", 0) >= REMOTE_FLOOR,
        "chat-project": remote.get("chatProject") is True,
    }
    for name in (".local/bin/claude", ".vite-plus/bin/vp", ".cargo/bin/cargo", ".config/t3nightly/public-config.env", CHAT_PROJECT):
        checks[name] = remote.get("files", {}).get(name) is True
    value["evidence"]["pressure"][f"{host}Load"] = remote.get("load")
    value["evidence"]["pressure"][f"{host}Cpus"] = remote.get("cpus")
