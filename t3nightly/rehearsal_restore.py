import json

from .install_restore_copy import checksum, verify
from .rehearsal_sandbox import sha256


def prove(rehearsal, workload):
    sandbox = rehearsal.sandbox
    state = sandbox.evidence / "installer-state"
    receipt = json.loads((state / "receipts" / f"install-{rehearsal.args.target_host}.json").read_text())
    compatibility = rehearsal.manifest["targets"][rehearsal.args.target_host]["compatibility"]
    copy = receipt["backup"].get("local") or {}
    restored = receipt.get("databaseRollback") or {}
    histories = receipt.get("migrationHistory") or {}
    expected = {"before": compatibility["baseMigrations"]["history"], "candidate": compatibility["candidateMigrations"]["history"], "restored": compatibility["baseMigrations"]["history"]}
    if histories != expected or sandbox.history() != expected["before"]:
        raise ValueError("restore rollback did not apply the candidate migrations and restore the baseline history")
    if receipt["outcome"] != "rolled-back" or not copy.get("sha256") or verify(copy["path"], copy["identity"]) != "ok" or checksum(copy["path"]) != copy["sha256"]:
        raise ValueError("restore rollback has no verified pre-install copy")
    if restored.get("source") != "local-restore-copy" or restored.get("sha256") != copy["sha256"] or restored.get("identity") != copy["identity"] or restored.get("quickCheck") != "ok":
        raise ValueError("stopped restored database did not match the pre-install copy")
    if (receipt.get("hotSwap") or {}).get("method") != "maintenance" or not (receipt.get("restartDrain") or {}).get("drained"):
        raise ValueError("restore rollback did not use a drained hard install")
    writes = json.loads((state / "candidate-writes.json").read_text())
    if sandbox.query("SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id=?", (writes["threadId"],)):
        raise ValueError("candidate-only writes survived database restore")
    runtime = {"version": sandbox.version(), "digest": sandbox.serving_digest()}
    if runtime != {"version": sandbox.old.name, "digest": sha256(sandbox.old / "t3")} or receipt["servingRuntime"] != runtime:
        raise ValueError("old runtime did not return after database restore")
    integrity = sandbox.query("PRAGMA integrity_check")
    if integrity != [("ok",)]:
        raise ValueError(f"restored database integrity failed: {integrity}")
    post, evidence = workload.verify(interrupted=True)
    proof = {"class": "restore-rollback", "backup": receipt["backup"], "databaseRollback": restored, "migrationHistory": histories,
             "restoredMigrationRows": sandbox.query("SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id"),
             "candidateWritesRemoved": writes, "servingAfterRollback": runtime, "databaseIntegrity": integrity,
             "restartDrain": receipt["restartDrain"], "oldRuntimeWrites": post, "workload": evidence}
    path = sandbox.evidence / "rollback-proof.json"
    path.write_text(json.dumps(proof, indent=2) + "\n")
    return path
