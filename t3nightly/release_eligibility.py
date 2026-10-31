BINARY_CLASSES = ("compatible", "fork-additive", "rollback-proven")
RESTORE_CLASS = "restore-rollback"
RESTORE_HOSTS = ("ax42",)
RESTORE_WAIVABLE = {"migrations-changed", "persisted-state-changed", "upstream-rebase"}


def classify(compat, host):
    reasons = compat["fastPath"]["reasons"]
    if not reasons:
        return {**compat, "eligibility": compat["persistedState"], "fastPath": {**compat["fastPath"], "waived": [], "conditions": []}}
    if reasons == ["persisted-state-changed"] and not compat["migrationFiles"]:
        name, changes, conditions = "rollback-proven", {"rollbackProof": "required", "binaryRollback": True}, ["forced-rollback-proof"]
    elif host in RESTORE_HOSTS and set(reasons) <= RESTORE_WAIVABLE:
        name, changes, conditions = RESTORE_CLASS, {"rollbackProof": "not-required", "binaryRollback": False}, ["baseline-seed-rehearsal", "offbox", "local-restore-copy"]
    else:
        return {**compat, "eligibility": None, "fastPath": {**compat["fastPath"], "waived": [], "conditions": []}}
    return {**compat, **changes, "eligibility": name, "fastPath": {"eligible": True, "reasons": [], "waived": list(reasons), "conditions": conditions}}


def binary_rollback(compatibility):
    return compatibility.get("binaryRollback") is True and compatibility.get("eligibility") in BINARY_CLASSES and (compatibility.get("eligibility") == "fork-additive" or compatibility.get("migrationFiles") == [])


def restore_refusal(compatibility, host, args):
    if compatibility.get("eligibility") != RESTORE_CLASS or args.rehearsal:
        return None
    if host not in RESTORE_HOSTS or not args.offbox:
        return f"restore-rollback installs only on {', '.join(RESTORE_HOSTS)} with --offbox; nothing stopped"
    return None
