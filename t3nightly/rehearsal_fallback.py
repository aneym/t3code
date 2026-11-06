import json
import threading

from .hot_swap_retention import reserve
from .install_hot_swap import measure_candidate
from .rehearsal_drain import hold_after_rollback, verify_refusal
from .rehearsal_run import Rehearsal
from .rehearsal_workload import Workload
from .proof_cleanup import threads


class RollbackFallbackRehearsal(Rehearsal):
    def execute(self):
        self.reservation = reserve(self.sandbox)
        self.preflight()
        self.phase = "prepare"
        self.sandbox.prepare(self.args.health_s)
        self.proof_baseline = threads(self.sandbox.home)
        self.phase = "baseline"
        baseline = Workload(self.sandbox).baseline()
        measured = measure_candidate(self.sandbox, self.manifest)
        self.phase = "install"
        strict = getattr(self.args, "strict_drain_proof", False)
        stopped = threading.Event()
        worker = None
        if strict:
            worker = threading.Thread(target=hold_after_rollback, args=(self.sandbox, stopped), daemon=True)
            worker.start()
        try:
            try:
                self.install()
            except RuntimeError:
                if not strict:
                    raise
        finally:
            stopped.set()
            if worker:
                worker.join(timeout=125)
                if worker.is_alive():
                    raise ValueError("Replay proof observer did not stop")
        self.phase = "verify"
        state = json.loads((self.sandbox.evidence / "installer-state/last.json").read_text())
        if strict:
            return verify_refusal(self.sandbox, state, baseline, measured)
        steps = state["steps"]
        required = ("hot-swap-rolled-back", "hot-swap-fallback", "restart-drain-start", "restart-drain", "hard-service-stop", "hard-service-start", "hard-install-receipt")
        positions = [next(index for index, row in enumerate(steps) if row["step"] == name) for name in required]
        if positions != sorted(positions) or any(sum(row["step"] == name for row in steps) != 1 for name in ("hard-service-stop", "hard-service-start")):
            raise ValueError("fallback did not perform exactly one ordered drained hard install")
        drain = state["restartDrain"]
        if not drain.get("drained") or drain.get("activeRunIds") or drain.get("stopForcedInRehearsal"):
            raise ValueError("fallback did not drain to zero naturally")
        hot = state["hotSwap"]
        trial = hot["trialRollback"]
        injected = json.loads((self.sandbox.evidence / "fault-injected.json").read_text())
        if hot.get("rollback") or hot.get("method") != "maintenance" or trial.get("method") != "launcher-automatic" or trial.get("status") not in ("rolled-back", "failed") or trial.get("id") != injected["updateId"]:
            raise ValueError("trial rollback identity or fallback method was confused")
        chat = Workload(self.sandbox).baseline()
        integrity = self.sandbox.query("PRAGMA integrity_check")
        if integrity != [("ok",)]:
            raise ValueError("fallback database integrity failed")
        proof = {"result": "PASS", "releaseEligible": False, "case": "launcher-rollback-drain-hard", "baselineChat": baseline, "candidateChat": chat, "startupMeasurement": measured, "rollback": trial, "drain": drain, "servingVersion": self.sandbox.version(), "databaseIntegrity": integrity, "steps": steps, "injection": injected}
        path = self.sandbox.evidence / "fallback-proof.json"
        path.write_text(json.dumps(proof, indent=2) + "\n")
        return {"result": "PASS", "releaseEligible": False, "proof": str(path)}
