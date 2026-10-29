
import os
import re
from pathlib import Path


INTERVAL = 20


def root():
    return Path(
        os.environ.get("LOAD_GUARD_STATE")
        or Path.home() / ".agent-rails/state/load-guard"
    )


def signal_levels(sample):
    levels = {}
    for path, probe in sample.get("read_probes", {}).items():
        if probe.get("timed_out") or probe.get("seconds", 0) > 5:
            levels["io:" + path] = "hard"
        elif probe.get("error"):
            levels["io:" + path] = "soft"
        percent = probe.get("free_percent", 100)
        if percent < 15:
            levels["disk:" + path] = "observe"
    if (
        sample.get("read_probes", {}).get("/Volumes/StudioExt", {}).get("present")
        is False
    ):
        levels["studioext_mount"] = "hard"
    for name, result in sample.get("probe_errors", {}).items():
        levels["probe:" + name] = (
            "hard"
            if result.get("timed_out")
            and name not in ("cpu", "stuck", "processes", "ps_timeout", "degraded")
            else "soft"
        )
    if sample.get("tick_seconds", 0) > INTERVAL:
        levels["watchdog_proxy"] = "hard"
    swap = re.search(r"used\s*=\s*([\d.]+)([MG])", sample.get("swap", ""))
    if swap:
        used_gb = float(swap[1]) / (1024 if swap[2] == "M" else 1)
        if used_gb >= 2:
            levels["swap"] = "hard" if used_gb >= 8 else "soft"
    memory = sample.get("memory", "")
    if str(memory).isdigit() and int(memory) < 15:
        levels["memory_available"] = "hard" if int(memory) < 10 else "soft"
    if sample.get("lume_observation_only"):
        levels["lume_observation_only"] = "observe"
    thermal = sample.get("cached", {}).get("thermal", "")
    limits = re.findall(r"(?:CPU_Speed_Limit|CPU_Scheduler_Limit)\s*=\s*(\d+)", thermal)
    if any(int(limit) < 80 for limit in limits):
        levels["thermal"] = "soft"
    if any(
        job.get("looping") for job in sample.get("cached", {}).get("jobs", {}).values()
    ):
        levels["launchd_crash_loop"] = "observe"
    if sample.get("pressure") == 2:
        levels["memory_pressure"] = "soft"
    return levels
