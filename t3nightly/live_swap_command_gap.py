import math


def command_gap(probe, changed):
    reasons = []
    changed = changed or bool(probe.get("commandFlips"))
    samples = probe.get("commandSamples", 0)
    failures = probe.get("commandFailures", 0)
    flip = probe.get("commandFlipGapMs")
    wait = probe.get("maxCommandWaitMs", 0)
    if not samples:
        reasons.append("no-command-samples")
    if failures:
        reasons.append("command-timeouts-or-errors")
    if not isinstance(wait, (int, float)) or not math.isfinite(wait) or wait > 8000 or probe.get("commandOverBudget", 0):
        reasons.append("command-wait-exceeded-8000ms")
    if changed:
        if not isinstance(flip, (int, float)) or not math.isfinite(flip) or flip < 0:
            reasons.append("command-flip-gap-unproved")
        elif flip > 8000:
            reasons.append("command-flip-gap-exceeded-8000ms")
    return {
        "verdict": "FAIL" if reasons else "PASS" if changed else "NO-SWAP-OBSERVED",
        "reasons": reasons,
        "targetMs": 8000,
        "method": probe.get("commandProbe", {}).get("method"),
        "commandSamples": samples,
        "commandFailures": failures,
        "commandFlipGapMs": flip,
        "maxCommandGapMs": probe.get("maxCommandGapMs", 0),
        "maxCommandWaitMs": wait,
        "commandOverBudget": probe.get("commandOverBudget", 0),
        "flips": probe.get("commandFlips", []),
    }
