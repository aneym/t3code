import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .release_manifest import TARGETS, digest, engine_identity, load
from .release_receipts import REHEARSAL_SCHEMA, provenance, seal, write
from .release_signatures import cli_binary, verify_archive
from .rehearsal_retention import retain
from .rehearsal_sandbox import Sandbox, sha256
from .rehearsal_workload import Workload


def now():
    return datetime.now(timezone.utc).isoformat()


class Rehearsal:
    def __init__(self, args):
        self.args = args
        self.sandbox = Sandbox(args)
        self.started = now()
        self.clock = time.monotonic()
        self.timings = {}
        self.phase = "preflight"
        self.manifest = load(args.candidate_manifest)
        self.engine = Path(__file__).resolve().parent

    def mark(self, phase, start):
        self.timings[phase] = round(time.monotonic() - start, 3)
        print(json.dumps({"phase": phase, "seconds": self.timings[phase], "at": now()}), flush=True)

    def preflight(self):
        if sys.platform == "darwin":
            from .rehearsal_lifecycle import disk_gate

            disk_gate(self.sandbox.home.parent / "root-df-before.json")
        platform, arch = TARGETS[self.args.target_host]
        if platform != sys.platform:
            raise ValueError("target host platform does not match this machine")
        if self.manifest["engine"]["digest"] != engine_identity(self.engine)["digest"]:
            raise ValueError("candidate engine content differs from rehearsal engine")
        if not self.manifest["compatibility"]["fastPath"]["eligible"] and not self.args.compatibility_probe:
            raise ValueError("candidate is not fast-path eligible; use --compatibility-probe for non-release evidence only")
        if sys.platform != "darwin" and not (self.engine / "install_hard.py").is_file():
            raise ValueError("Linux rehearsal requires P4 isolated hard installer; refusing before boot")
        self.version = self.manifest["version"]
        self.archive = self.args.assets / f"t3-{self.version}-{platform}-{arch}.tar.gz"
        verify_archive(self.archive)
        with cli_binary(self.archive) as binary:
            self.candidate_digest = sha256(binary)
        self.artifact_digest = sha256(self.archive)
        if self.args.artifact_manifest:
            artifact = json.loads(self.args.artifact_manifest.read_text())
            if (artifact.get("schema"), artifact.get("kind"), artifact.get("release"), artifact.get("platform"), artifact.get("arch")) != ("t3nightly.artifact-manifest/1", "cli", self.version, platform, arch):
                raise ValueError("artifact manifest target or release mismatch")
            if platform == "darwin" and not (artifact["codesign"]["verified"] and artifact["notarization"]["verified"]):
                raise ValueError("Mac artifact requires verified signature and notarization")
            self.artifact_digest = artifact["digest"]
            if digest({key: value for key, value in artifact.items() if key != "digest"}) != self.artifact_digest:
                raise ValueError("artifact manifest content digest mismatch")
            if artifact["archive"]["sha256"] != sha256(self.archive) or artifact["runtime"]["sha256"] != self.candidate_digest:
                raise ValueError("artifact manifest does not match rehearsal bytes")
        elif not self.args.compatibility_probe:
            raise ValueError("release rehearsal requires --artifact-manifest from P2")

    def install(self):
        sandbox = self.sandbox
        service_label = sandbox.label if sys.platform == "darwin" else f"{sandbox.label}.service"
        command = [sys.executable, str(self.engine / "install"), "--hard", "--version", self.version, "--home", str(sandbox.home), "--port", str(sandbox.port), "--service-label", service_label, "--service-plist", str(sandbox.unit), "--service-env", str(sandbox.home / "service.env"), "--systemd-dropin", str(sandbox.systemd_dropin), "--assets", str(self.args.assets.resolve()), "--state-dir", str(sandbox.evidence / "installer-state"), "--health-s", str(self.args.health_s), "--settle-s", "1", "--load-max", "24"]
        if sys.platform != "darwin":
            command += ["--backups", str(sandbox.evidence / "backups")]
        if (self.engine / "install_hard.py").is_file():
            artifact_path = self.args.artifact_manifest
            if artifact_path is None:
                artifact = {"archive": {"sha256": sha256(self.archive)}, "runtime": {"sha256": self.candidate_digest}}
                artifact = {**artifact, "digest": digest(artifact)}
                artifact_path = sandbox.evidence / "probe-artifact.json"
                artifact_path.write_text(json.dumps(artifact, indent=2) + "\n")
                self.artifact_digest = artifact["digest"]
            command.extend(["--rehearsal", "--manifest", str(self.args.candidate_manifest.resolve()), "--artifact-manifest", str(artifact_path.resolve()), "--receipt-host", self.args.target_host, "--chat-project", str(sandbox.project), "--chat-provider", self.args.provider, "--chat-model", self.args.model, "--chat-timeout", str(self.args.chat_timeout)])
            if self.args.compatibility_probe:
                command.append("--compatibility-probe")
            if self.args.force_rollback:
                command.append("--force-rollback")
        if getattr(self.args, "hot_swap", False):
            command[command.index("--hard")] = "--seamless"
            command.extend(["--rpc-tree", str(self.args.rpc_tree.resolve()), "--drain-s", str(self.args.drain_s)])
            for name in ("launcher_artifact", "connector_artifact"):
                if getattr(self.args, name):
                    command.extend(["--" + name.replace("_", "-"), getattr(self.args, name)])
        if self.args.verdict:
            command.extend(["--verdict", str(self.args.verdict)])
        installer_home = Path.home() if (self.engine / "install_hard.py").is_file() else sandbox.os_home
        environment = dict(os.environ, HOME=str(installer_home), LOAD_GUARD_STATE=str(Path.home() / ".agent-rails/state/load-guard"))
        with (sandbox.evidence / "installer.log").open("w") as output:
            result = subprocess.run(command, env=environment, stdout=output, stderr=subprocess.STDOUT, timeout=260 + getattr(self.args, "drain_s", 0), check=False)
        report = json.loads((sandbox.evidence / "installer-state/last.json").read_text())
        if self.args.force_rollback or (getattr(self.args, "hot_swap", False) and self.args.inject != "none"):
            if report["outcome"] != "rolled-back":
                raise RuntimeError(f"forced rollback did not roll back: {report['outcome']}; see installer.log")
            sandbox.wait_ready(sandbox.old.name, 30)
            if sandbox.version() != sandbox.old.name or sandbox.serving_digest() != sha256(sandbox.old / "t3"):
                raise ValueError("old runtime is not serving after forced rollback")
            return
        if result.returncode or report["outcome"] not in ("installed", "current"):
            raise RuntimeError(f"hard installer failed: {report['outcome']}; see installer.log")
        sandbox.wait_ready(self.version, 30)
        if sandbox.version() != self.version or sandbox.serving_digest() != self.candidate_digest:
            raise ValueError("serving version or service-owned executable digest mismatch")

    def main(self):
        result = {"result": "FAIL", "phase": self.phase}
        try:
            tick = time.monotonic()
            if getattr(self.args, "hot_swap", False):
                from .hot_swap_retention import reserve

                self.reservation = reserve(self.sandbox)
            self.preflight()
            self.mark("preflight", tick)
            self.phase = "prepare"
            tick = time.monotonic()
            self.sandbox.prepare(self.args.health_s)
            self.old_history = self.sandbox.history()
            if self.old_history != self.manifest["compatibility"]["baseMigrations"]["history"]:
                raise ValueError("seed migration history differs from candidate base")
            self.mark("prepare", tick)
            workload = Workload(self.sandbox)
            self.phase = "baseline"
            tick = time.monotonic()
            baseline = workload.baseline()
            self.mark("baseline", tick)
            self.phase = "workload"
            tick = time.monotonic()
            before = workload.prepare()
            (self.sandbox.evidence / "before.json").write_text(json.dumps(before, indent=2) + "\n")
            self.mark("workload", tick)
            self.phase = "install"
            tick = time.monotonic()
            self.install()
            self.mark("install", tick)
            if self.args.force_rollback or (getattr(self.args, "hot_swap", False) and self.args.inject != "none"):
                self.phase = "rollback-verify"
                tick = time.monotonic()
                proof = self.rollback_proof(workload)
                self.mark("rollback-verify", tick)
                result = {"result": "ROLLBACK-PROOF", "releaseEligible": False, "proof": str(proof)}
                return self.report(result)
            self.phase = "verify"
            tick = time.monotonic()
            post, evidence = workload.verify()
            candidate_history = self.sandbox.history()
            if candidate_history != self.manifest["compatibility"]["candidateMigrations"]["history"]:
                raise ValueError("candidate migration history differs from manifest")
            (self.sandbox.evidence / "workload.json").write_text(json.dumps(evidence, indent=2) + "\n")
            self.mark("verify", tick)
            receipt = {"schema": REHEARSAL_SCHEMA, "release": self.version, "runId": uuid.uuid4().hex, "host": self.args.target_host, "platform": TARGETS[self.args.target_host][0], "arch": TARGETS[self.args.target_host][1], "candidateDigest": self.manifest["digest"], "sourceTree": self.manifest["source"]["stampedTree"], "artifactManifestDigest": self.artifact_digest, "engineDigest": self.manifest["engine"]["digest"], "oldRuntime": {"version": self.sandbox.old.name, "digest": sha256(self.sandbox.old / "t3")}, "candidateRuntime": {"version": self.version, "digest": self.candidate_digest}, "oldMigrationHistory": self.old_history, "candidateMigrationHistory": candidate_history, "baselineChat": baseline, "postCutoverChat": post, "workload": {name: {"outcome": "passed", "evidenceDigest": digest(evidence)} for name in ("stopped-history", "active-turn", "queued-message", "snoozed-thread", "resume", "dispositions")}, "result": "PASS", "startedAt": self.started, "finishedAt": now()}
            sealed = seal(receipt)
            reasons = provenance(sealed, self.manifest, self.args.target_host)
            if reasons and not self.args.compatibility_probe:
                raise ValueError("; ".join(reasons))
            receipt_path = self.sandbox.evidence / "rehearsal-receipt.json"
            write(receipt_path, receipt)
            result = {"result": "COMPATIBILITY-PROBE" if self.args.compatibility_probe else "PASS", "receipt": str(receipt_path), "releaseEligible": not reasons and not self.args.compatibility_probe, "provenanceRefusals": reasons}
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, TimeoutError) as error:
            blocked = "environment-refused" if "sandbox" in str(error) or "live T3" in str(error) else "environment-blocked"
            result = {"result": blocked if self.phase in ("prepare", "baseline") else "FAIL", "phase": self.phase, "error": str(error)}
        return self.report(result)

    def report(self, result):
        try:
            self.sandbox.close()
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            result = {**result, "result": "FAIL", "teardownError": str(error)}
        finally:
            if getattr(self, "reservation", None):
                from .rehearsal_lifecycle import finish

                finish(self.sandbox.home.parent)
                self.reservation.close()
        result = {**result, "timings": self.timings, "elapsedSeconds": round(time.monotonic() - self.clock, 3), "startedAt": self.started, "finishedAt": now()}
        path = self.sandbox.evidence / "result.json"
        try:
            if self.sandbox.home.parent.name.startswith("rehearsal-hot-swap-"):
                from .hot_swap_retention import retain as hot_retain

                retention = hot_retain(self.sandbox.home.parent)
            else:
                retention = retain(self.sandbox.home.parent)
        except Exception as error:
            retention = {"error": f"{type(error).__name__}: {error}"}
        if self.sandbox.home.parent.name.startswith("rehearsal-hot-swap-"):
            from .rehearsal_store_gc import prune

            try:
                retention["sharedStore"] = prune()
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                retention["sharedStore"] = {"error": str(error)}
        result = {**result, "retention": retention}
        if self.sandbox.evidence.exists():
            try:
                path.write_text(json.dumps(result, indent=2) + "\n")
                path.with_name("retention.json").write_text(json.dumps(retention, indent=2) + "\n")
            except OSError as error:
                result = {**result, "receiptError": str(error), "result": "FAIL"}
        print(json.dumps(result, indent=2), flush=True)
        return 0 if result["result"] in ("PASS", "COMPATIBILITY-PROBE", "ROLLBACK-PROOF") else 1

    def rollback_proof(self, workload):
        state = self.sandbox.evidence / "installer-state"
        writes = json.loads((state / "candidate-writes.json").read_text())
        receipt = json.loads((state / "receipts" / f"install-{self.args.target_host}.json").read_text())
        if receipt["backup"].get("method") != "binary-rollback":
            raise ValueError(f"rollback used {receipt['backup'].get('method')}, not binary-rollback")
        shown = self.sandbox.t3("thread", "show", writes["threadId"], "--messages", "50", "--json")
        if not any(message["role"] == "assistant" and message["text"].strip() == writes["nonce"] for message in shown["messages"]):
            raise ValueError("old runtime cannot read the candidate's turn reply")
        snoozed = shown["thread"].get("snoozedUntil")
        if not snoozed or datetime.fromisoformat(snoozed.replace("Z", "+00:00")) != datetime.fromisoformat(writes["snoozedUntil"]):
            raise ValueError("old runtime cannot read the candidate's snooze")
        post, evidence = workload.verify(interrupted=True)
        proof = {"candidateWrites": writes, "backup": receipt["backup"], "receiptOutcome": receipt["outcome"], "oldReadBack": {"thread": shown["thread"], "messages": shown["messages"]},
                 "servingAfterRollback": {"version": self.sandbox.version(), "digest": self.sandbox.serving_digest()}, "oldRuntimeWrites": post, "workload": evidence}
        path = self.sandbox.evidence / "rollback-proof.json"
        path.write_text(json.dumps(proof, indent=2) + "\n")
        return path
