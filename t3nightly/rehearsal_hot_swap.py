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
        self.probe_path = sandbox.evidence / "connection-probe.json"
        self.stop_path = sandbox.evidence / "probe.stop"
        environment = sandbox.version()
        self.hot = {"injection": self.args.inject, "oldVersion": environment, "checks": {}, "unitRenderer": sandbox.unit_renderer}
        if self.args.inject != "none" and not (sandbox.home / "runtime/launcher-config.json").is_file():
            self.hot["status"] = "hot-swap-unsupported"
            raise ValueError("hot-swap-unsupported: crash injection requires a capability-qualified sandbox launcher")
        run = SimpleNamespace(args=SimpleNamespace(drain_s=self.args.drain_s), home=sandbox.home, state=sandbox.evidence, runtime=lambda version: sandbox.home / "runtime/versions" / version / "t3")
        with restart_session(run, sandbox.old.name) as bearer:
            command = ["node", str(self.engine / "client.mjs"), "hot-swap-probe", "--tree", str(self.args.rpc_tree.resolve()), "--origin", f"http://127.0.0.1:{sandbox.port}", "--bearer-file", str(bearer), "--thread", self.probe_thread, "--output", str(self.probe_path), "--stop", str(self.stop_path)]
            self.probe_log = (sandbox.evidence / "connection-probe.log").open("w")
            self.probe_process = subprocess.Popen(command, stdout=self.probe_log, stderr=subprocess.STDOUT)
            wait_for(self.probe_ready, 60, "persistent probe WS snapshot")
            self.hot["walBefore"] = self.wal()
            config = sandbox.home / "runtime/launcher-config.json"
            if config.is_file() and self.args.inject == "none":
                ingress = json.loads(config.read_text())
                pressure = ["node", str(self.engine / "hot_swap_pressure.mjs"), f"http://127.0.0.1:{sandbox.port}", str(self.stop_path), str(sandbox.evidence / "pressure.json"), str(ingress["maxQueued"]), str(ingress["holdBudgetMs"])]
                self.pressure_process = subprocess.Popen(pressure, stdout=self.probe_log, stderr=subprocess.STDOUT)
            try:
                super().install()
            except BaseException:
                self.stop_probe()
                raise

    def probe_ready(self):
        if self.probe_process.poll() is not None:
            raise ValueError("connection probe exited; see connection-probe.log")
        try:
            return json.loads(self.probe_path.read_text()).get("ready") is True
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
        installer_path = self.sandbox.evidence / "installer-state/last.json"
        if installer_path.is_file():
            installer_before = json.loads(installer_path.read_text())
            if installer_before.get("outcome") == "installed" and installer_before.get("hotSwap", {}).get("method") == "launcher-ipc":
                from .rehearsal_crash import launcher_crash

                hot["swapProbe"] = json.loads(self.probe_path.read_text())
                hot["checks"]["launcher-crash"] = launcher_crash(self.sandbox)
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
            hot["install"] = installer
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
            hot["checks"]["queue-saturation"] = {"status": "exercised", "traffic": json.loads(pressure.read_text())}
        if hot.get("walAfter"):
            hot["checks"]["wal-writes"] = {"status": "passed" if hot["walAfter"]["events"] > hot["walBefore"]["events"] and hot["databaseIntegrity"] == [("ok",)] else "failed"}
        if hot.get("probe", {}).get("keepAlive", {}).get("reused", 0):
            hot["checks"]["keep-alive-freeze"] = {"status": "exercised", **hot["probe"]["keepAlive"]}
        probe = hot.get("swapProbe", hot.get("probe", {}))
        hot["candidateMeasuredStartupMs"] = probe.get("flipGapMs")
        if hot.get("install"):
            steps = hot["install"]["steps"]
            hot["checks"]["drain-arrivals"] = {"status": "exercised", "httpSamples": probe.get("httpSamples"), "drain": [step for step in steps if step["step"].startswith("restart-drain")]}
        hot["checks"].update({name: {"status": "awaiting-capable-server"} for name in ("drain-arrivals", "keep-alive-freeze", "launcher-crash", "queue-saturation", "warm-rollback", "pre-routing-rollback") if name not in hot["checks"]})
        receipt_path = self.sandbox.evidence / "rehearsal-receipt.json"
        if receipt_path.is_file():
            from .release_receipts import seal

            receipt = json.loads(receipt_path.read_text())
            receipt["hotSwap"] = {key: hot[key] for key in ("status", "sequenceContinuity", "candidateMeasuredStartupMs", "checks") if key in hot}
            if hot.get("install", {}).get("hotSwap", {}).get("method") == "maintenance":
                receipt["result"] = "PASS"
            if hot.get("status") == "hot-swap" and (probe.get("refusedConnections") or hot.get("sequenceContinuity") is not True or hot.get("databaseIntegrity") != [("ok",)]):
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
        post, evidence = workload.verify(interrupted=True)
        proof = {"installer": installer, "postRollbackChat": post, "workload": evidence, "databaseIntegrity": self.sandbox.query("PRAGMA integrity_check")}
        path = self.sandbox.evidence / "rollback-proof.json"
        path.write_text(json.dumps(proof, indent=2) + "\n")
        return path
