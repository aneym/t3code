import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote

from .install_rpc import restart_session
from .rehearsal_run import Rehearsal
from .rehearsal_sandbox import wait_for


class HotSwapRehearsal(Rehearsal):
    def install(self):
        sandbox = self.sandbox
        before = json.loads((sandbox.evidence / "before.json").read_text())
        self.probe_thread = before["work"]["active-turn"]["threadId"]
        self.stream_id = unquote(self.probe_thread.removeprefix("thread:"))
        self.probe_run = before["work"]["active-turn"]["runId"]
        self.probe_path = sandbox.evidence / "connection-probe.json"
        self.stop_path = sandbox.evidence / "probe.stop"
        environment = sandbox.version()
        self.hot = {"oldChildPid": json.loads((sandbox.home / "userdata/server-runtime.json").read_text())["pid"], "previousMeasuredStartupMs": self.manifest.get("hotSwap", {}).get("previousMeasuredStartupMs"), "injection": self.args.inject, "oldVersion": environment, "checks": {}, "unitRenderer": sandbox.unit_renderer}
        if self.args.inject != "none" and not (sandbox.home / "runtime/launcher-config.json").is_file():
            self.hot["status"] = "hot-swap-unsupported"
            raise ValueError("hot-swap-unsupported: crash injection requires a capability-qualified sandbox launcher")
        run = SimpleNamespace(args=SimpleNamespace(drain_s=self.args.drain_s), home=sandbox.home, state=sandbox.evidence, runtime=lambda version: sandbox.home / "runtime/versions" / version / "t3")
        with restart_session(run, sandbox.old.name) as bearer:
            command = ["node", str(self.engine / "client.mjs"), "hot-swap-probe", "--tree", str(self.args.rpc_tree.resolve()), "--origin", f"http://127.0.0.1:{sandbox.port}", "--bearer-file", str(bearer), "--thread", self.probe_thread, "--output", str(self.probe_path), "--stop", str(self.stop_path)]
            if self.args.stock_client:
                command.extend(["--stock-client", "true"])
            self.probe_log = (sandbox.evidence / "connection-probe.log").open("w")
            self.probe_process = subprocess.Popen(command, stdout=self.probe_log, stderr=subprocess.STDOUT)
            wait_for(self.probe_ready, 60, "persistent probe WS snapshot")
            self.hot["walBefore"] = self.wal()
            self.hot["providerTurnBefore"] = sandbox.query("SELECT r.run_id,r.status,t.provider_turn_id,t.status FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_turns t ON r.thread_id=t.thread_id AND t.run_attempt_id=json_extract(r.payload_json,'$.activeAttemptId') WHERE r.run_id=?", (self.probe_run,))
            config = sandbox.home / "runtime/launcher-config.json"
            if config.is_file() and self.args.queue_mode != "none":
                ingress = json.loads(config.read_text())
                pressure = ["node", str(self.engine / "hot_swap_pressure.mjs"), f"http://127.0.0.1:{sandbox.port}", str(self.stop_path), str(sandbox.evidence / "pressure.json"), str(ingress["maxQueued"]), str(ingress["holdBudgetMs"]), str(sandbox.evidence / "launcher-ipc.jsonl"), self.version, self.args.queue_mode]
                self.pressure_process = subprocess.Popen(pressure, stdout=self.probe_log, stderr=subprocess.STDOUT)
            try:
                super().install()
                self.hot["providerTurnAfter"] = sandbox.query("SELECT r.run_id,r.status,t.provider_turn_id,t.status FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_turns t ON r.thread_id=t.thread_id AND t.run_attempt_id=json_extract(r.payload_json,'$.activeAttemptId') WHERE r.run_id=?", (self.probe_run,))
                if self.args.inject == "none" and not self.args.force_rollback:
                    before_running = any(row[1] == "running" and row[3] == "running" for row in self.hot["providerTurnBefore"])
                    self.hot["checks"]["provider-turn-in-flight-before-freeze"] = {"status": "passed" if before_running else "failed", "runId": self.probe_run, "interruptionExpected": True}
            except BaseException:
                self.stop_probe()
                raise

    def probe_ready(self):
        if self.probe_process.poll() is not None:
            raise ValueError("connection probe exited; see connection-probe.log")
        try:
            probe = json.loads(self.probe_path.read_text())
            return probe.get("ready") is True and (not self.args.stock_client or probe.get("stockClient", {}).get("ready") is True)
        except (OSError, ValueError):
            return False

    def wal(self):
        path = Path(str(self.sandbox.db) + "-wal")
        return {"bytes": path.stat().st_size if path.exists() else 0, "events": self.sandbox.query("SELECT count(*) FROM orchestration_events")[0][0]}

    def stop_probe(self):
        process = getattr(self, "probe_process", None)
        if process is None:
            return
        self.stop_path.touch()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=10)
        pressure = getattr(self, "pressure_process", None)
        if pressure:
            try:
                pressure.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pressure.terminate()
                pressure.wait(timeout=10)
            self.pressure_process = None
        self.probe_log.close()
        self.probe_process = None

    def collect_report(self, result):
        hot = getattr(self, "hot", {"checks": {}})
        injection = self.sandbox.evidence / "fault-injected.json"
        if injection.exists():
            hot["injected"] = json.loads(injection.read_text())
        ipc = self.sandbox.evidence / "launcher-ipc.jsonl"
        if ipc.exists():
            hot["launcherIPC"] = [json.loads(line) for line in ipc.read_text().splitlines() if line.strip()]
        final_sequence = 0
        if getattr(self, "probe_path", None):
            final_sequence = self.sandbox.query("SELECT coalesce(max(sequence),0) FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?", (self.stream_id,))[0][0]
        if getattr(self, "probe_process", None):
            try:
                wait_for(lambda: max(json.loads(self.probe_path.read_text()).get("sequences", [0]) or [0]) >= final_sequence, 15, "probe final persisted event cursor")
            except (OSError, ValueError, TimeoutError) as error:
                hot["cursorError"] = str(error)
            self.stop_probe()
        if getattr(self, "probe_path", None) and self.probe_path.exists():
            probe = json.loads(self.probe_path.read_text())
            hot["probe"] = probe
            start = probe["snapshots"][0] if probe["snapshots"] else final_sequence
            end = max(probe["sequences"] or [start])
            expected = [row[0] for row in self.sandbox.query("SELECT sequence FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=? AND sequence>? AND sequence<=? ORDER BY sequence", (self.stream_id, start, final_sequence))]
            missing = sorted(set(expected) - set(probe["sequences"]))
            hot.update(probe=probe, missedEvents=missing, sequenceContinuity=bool(probe["snapshots"]) and not missing and not probe["resnapshots"] and not hot.get("cursorError"), walAfter=self.wal(), databaseIntegrity=self.sandbox.query("PRAGMA integrity_check"), servedVersion=self.sandbox.version(), finalPersistedSequence=final_sequence, lastAppliedSequence=end)
        state = self.sandbox.evidence / "installer-state/last.json"
        if state.exists():
            installer = json.loads(state.read_text())
            if not getattr(self.args, "focused", False) and installer.get("outcome") == "installed" and installer.get("hotSwap", {}).get("method") == "launcher-ipc":
                from .rehearsal_crash import launcher_crash

                hot["checks"]["launcher-crash"] = launcher_crash(self.sandbox)
            hot["install"] = installer
            hot["servingChildPid"] = json.loads((self.sandbox.home / "userdata/server-runtime.json").read_text())["pid"]
            rollback = installer.get("hotSwap", {}).get("rollback")
            if self.args.inject != "none":
                automatic = rollback == "launcher-automatic" and installer.get("outcome") == "rolled-back"
                unchanged = self.args.inject != "warm-death" or hot["oldChildPid"] == hot["servingChildPid"]
                name = "warm-rollback" if self.args.inject == "warm-death" else "pre-routing-rollback"
                hot["checks"][name] = {"status": "passed" if automatic and unchanged and hot.get("injected") else "failed", "method": rollback, "oldChildPid": hot["oldChildPid"], "servingChildPid": hot["servingChildPid"], "warmOldUntouched": unchanged if self.args.inject == "warm-death" else None}
            if self.args.force_rollback:
                hot["checks"]["post-routing-binary-rollback"] = {"status": "passed" if rollback == "launcher-ipc" and result.get("result") == "ROLLBACK-PROOF" else "failed", "method": rollback, "databaseKeptProof": result.get("proof")}
            fallback = installer.get("hotSwap", {}).get("method") != "launcher-ipc"
            hot["status"] = "hot-swap-unsupported" if fallback else "hot-swap"
            hot["fallbackAccepted"] = installer.get("outcome") == "installed"
            if fallback and result.get("result") in ("PASS", "COMPATIBILITY-PROBE"):
                result.update(result="COMPATIBILITY-PROBE", releaseEligible=False)
                from .release_receipts import seal

                receipt_path = self.sandbox.evidence / "rehearsal-receipt.json"
                if receipt_path.is_file():
                    receipt = json.loads(receipt_path.read_text())
                    receipt["result"] = "HOT-SWAP-UNSUPPORTED"
                    receipt_path.write_text(json.dumps(seal(receipt), indent=2) + "\n")
        pressure = self.sandbox.evidence / "pressure.json"
        if pressure.is_file():
            traffic = json.loads(pressure.read_text())
            capacity_pass = traffic.get("queuedAcrossRelease", 0) > 0 and traffic.get("overflowBeforeRelease", 0) > 0 and traffic.get("servedNew", 0) > 0 and traffic.get("servedOld", 0) == 0 and traffic.get("reset", 0) > 0 and traffic.get("refused", 0) == 0
            budget_pass = traffic.get("pastBudget", 0) > 0 and traffic.get("refused", 0) == 0
            passed = bool(traffic.get("drained")) and traffic.get("status") == "complete" and (capacity_pass if self.args.queue_mode == "capacity" else budget_pass)
            hot["checks"]["queue-saturation"] = {"status": "passed" if passed else "failed", "traffic": traffic}
        from .hot_swap_client_evidence import client_checks

        client_checks(self, hot)
        if hot.get("walAfter"):
            hot["checks"]["wal-writes"] = {"status": "passed" if hot["walAfter"]["events"] > hot["walBefore"]["events"] and hot["databaseIntegrity"] == [("ok",)] else "failed"}
        probe = hot.get("swapProbe", hot.get("probe", {}))
        hot["candidateMeasuredStartupMs"] = probe.get("flipGapMs")
        if hot.get("install"):
            steps = hot["install"]["steps"]
            ipc = hot.get("launcherIPC", [])
            warm = next((row for row in ipc if row["phase"] == "warm"), None)
            drained = next((row for row in ipc if row["phase"] == "drained" and warm and row.get("updateId") == warm.get("updateId")), None)
            arrivals = [row for row in probe.get("httpObservations", []) if warm and drained and warm["at"] <= row["at"] <= drained["at"]]
            hot["checks"]["drain-arrivals"] = {"status": "passed" if arrivals and all(row["version"] == hot["oldVersion"] for row in arrivals) else "failed", "freshConnectionSamples": arrivals, "drainStart": warm, "drainEnd": drained, "maintenanceDrain": [step for step in steps if step["step"].startswith("restart-drain")]}
        hot["checks"].update({name: {"status": "awaiting-capable-server"} for name in ("drain-arrivals", "keep-alive-freeze", "launcher-crash", "queue-saturation", "warm-rollback", "pre-routing-rollback") if name not in hot["checks"]})
        receipt_path = self.sandbox.evidence / "rehearsal-receipt.json"
        if receipt_path.is_file():
            from .release_receipts import seal

            receipt = json.loads(receipt_path.read_text())
            if self.args.queue_mode != "none":
                receipt["result"] = "QUEUE-PROOF"
                result["releaseEligible"] = False
            receipt["hotSwap"] = {key: hot[key] for key in ("status", "sequenceContinuity", "candidateMeasuredStartupMs", "previousMeasuredStartupMs", "checks") if key in hot}
            if hot.get("install", {}).get("hotSwap", {}).get("method") == "maintenance":
                receipt["result"] = "PASS"
            queue_failed = self.args.queue_mode != "none" and hot.get("checks", {}).get("queue-saturation", {}).get("status") != "passed"
            presentation_failed = self.args.queue_mode != "budget" and self.args.inject == "none" and hot.get("checks", {}).get("presentation", {}).get("status") != "passed"
            normal = self.args.inject == "none" and not self.args.force_rollback and self.args.queue_mode == "none"
            provider_failed = normal and any(hot["checks"].get(name, {}).get("status") != "passed" for name in ("provider-turn-in-flight-before-freeze", "active-automatic-continuation", "handoff-reply-and-NEW-event"))
            provider_failed = provider_failed or (self.args.stock_client and hot["checks"].get("stock-client", {}).get("status") != "passed")
            connection_failed = self.args.inject == "none" and any(hot["checks"].get(name, {}).get("status") != "passed" for name in ("keep-alive-freeze", "drain-arrivals"))
            if hot.get("status") == "hot-swap" and (provider_failed or connection_failed or probe.get("refusedConnections") or hot.get("sequenceContinuity") is not True or hot.get("databaseIntegrity") != [("ok",)] or queue_failed or presentation_failed):
                receipt["result"] = "FAIL"
                result.update(result="FAIL", releaseEligible=False)
            receipt_path.write_text(json.dumps(seal(receipt), indent=2) + "\n")
        if self.sandbox.evidence.exists():
            (self.sandbox.evidence / "hot-swap-receipt.json").write_text(json.dumps(hot, indent=2) + "\n")
            (self.sandbox.evidence / "hot-swap.md").write_text("# Isolated hot-swap rehearsal\n\n```json\n" + json.dumps(hot, indent=2) + "\n```\n")
        return {**result, "hotSwap": hot}

    def report(self, result):
        try:
            result = self.collect_report(result)
        except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError) as error:
            result = {**result, "result": "FAIL", "receiptError": str(error), "releaseEligible": False}
        finally:
            self.stop_probe()
        return super().report(result)

    def rollback_proof(self, workload):
        state = self.sandbox.evidence / "installer-state"
        installer = json.loads((state / "last.json").read_text())
        if self.args.inject != "none":
            injected = json.loads((self.sandbox.evidence / "fault-injected.json").read_text())
            update = installer.get("hotSwap", {}).get("update", {})
            if injected.get("updateId") != update.get("updateId") or installer.get("hotSwap", {}).get("rollback") != "launcher-automatic":
                raise ValueError("trial death was not bound to the launcher automatic rollback")
            post, evidence = workload.verify(interrupted=True)
            path = self.sandbox.evidence / "rollback-proof.json"
            path.write_text(json.dumps({"injected": injected, "installer": installer, "postRollbackChat": post, "workload": evidence, "databaseIntegrity": self.sandbox.query("PRAGMA integrity_check")}, indent=2) + "\n")
            return path
        if installer.get("hotSwap", {}).get("method") != "launcher-ipc":
            return super().rollback_proof(workload)
        if installer.get("hotSwap", {}).get("rollback") != "launcher-ipc":
            raise ValueError("post-flip failure did not use a schema-compatible hot swap back")
        writes = json.loads((state / "candidate-writes.json").read_text())
        shown = self.sandbox.t3("thread", "show", writes["threadId"], "--messages", "50", "--json")
        if not any(message["role"] == "assistant" and message["text"].strip() == writes["nonce"] for message in shown["messages"]):
            raise ValueError("hot-swap-back lost the candidate's persisted reply")
        from datetime import datetime

        observed_snooze = shown["thread"].get("snoozedUntil")
        if not observed_snooze or datetime.fromisoformat(observed_snooze.replace("Z", "+00:00")) != datetime.fromisoformat(writes["snoozedUntil"].replace("Z", "+00:00")):
            raise ValueError("hot-swap-back lost the candidate's snooze write")
        post, evidence = workload.verify(interrupted=True)
        proof = {"installer": installer, "candidateWrites": writes, "oldReadBack": shown, "databaseKept": True, "postRollbackChat": post, "workload": evidence, "databaseIntegrity": self.sandbox.query("PRAGMA integrity_check")}
        path = self.sandbox.evidence / "rollback-proof.json"
        path.write_text(json.dumps(proof, indent=2) + "\n")
        return path
