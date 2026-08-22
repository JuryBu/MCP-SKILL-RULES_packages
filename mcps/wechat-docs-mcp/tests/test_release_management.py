from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from ops.release_probe import parse_arguments
from wechat_docs_mcp.ledger import EventLedger


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
RELEASE_SCRIPT = PACKAGE_ROOT / "ops" / "manage-wechat-docs-release.ps1"
PROBE_SCRIPT = PACKAGE_ROOT / "ops" / "release_probe.py"
POWERSHELL = shutil.which("powershell") or shutil.which("powershell.exe")


def run_process(
    arguments: list[str],
    timeout: int = 60,
    extra_environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["PYTHONUTF8"] = "1"
    environment.update(extra_environment or {})
    return subprocess.run(
        arguments,
        cwd=PACKAGE_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


class ReleaseProbeTests(unittest.TestCase):
    def test_base64_arguments_preserve_json_property_names(self) -> None:
        encoded = "eyJ0aW1lb3V0Ijo2NS4wLCJmb3JjZV9yZWZyZXNoIjp0cnVlfQ=="
        self.assertEqual(
            {"timeout": 65.0, "force_refresh": True},
            parse_arguments("{}", encoded),
        )

    def test_fixture_and_read_only_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            ledger = Path(temporary_directory) / "含 # 与 % 字符" / "events.sqlite3"
            created = run_process(
                [
                    sys.executable,
                    str(PROBE_SCRIPT),
                    "create-fixture",
                    "--ledger",
                    str(ledger),
                    "--route-id",
                    "route-test",
                ]
            )
            self.assertEqual(0, created.returncode, created.stderr)
            self.assertEqual(
                {
                    "active_wakes": 0,
                    "active_wakes_total": 0,
                    "events": 1,
                    "events_total": 1,
                    "expected_legacy_subscriptions": 0,
                    "pending": 0,
                    "pending_subscriptions": 0,
                    "pending_subscriptions_total": 0,
                    "pending_total": 0,
                    "route_subscription_expected": 0,
                    "routes": 0,
                    "schema_version": 1,
                    "subscriptions": 0,
                    "subscriptions_total": 0,
                    "wakes": 1,
                    "wakes_total": 1,
                },
                json.loads(created.stdout),
            )

            snapshot = run_process(
                [
                    sys.executable,
                    str(PROBE_SCRIPT),
                    "ledger-state",
                    "--ledger",
                    str(ledger),
                    "--route-id",
                    "route-test",
                ]
            )
            self.assertEqual(0, snapshot.returncode, snapshot.stderr)
            self.assertEqual(json.loads(created.stdout), json.loads(snapshot.stdout))

    def test_v2_snapshot_counts_subscription_deliveries(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "events.sqlite3"
            ledger = EventLedger(path)
            ledger.register_route("route-v2", profile="test", state="active")
            ledger.register_subscription(
                "route-v2", "conversation-a", 1, subscription_id="subscription-a"
            )
            ledger.register_subscription(
                "route-v2", "conversation-b", 1, subscription_id="subscription-b"
            )
            event = ledger.ingest_event("route-v2", "fingerprint-v2", "text", {"text": "safe"})
            wake = ledger.get_active_wake("subscription-a")
            self.assertIsNotNone(wake)
            ledger.ack("subscription-a", 1, wake["wake_id"], [event["event_id"]])

            snapshot = run_process(
                [
                    sys.executable,
                    str(PROBE_SCRIPT),
                    "ledger-state",
                    "--ledger",
                    str(path),
                    "--route-id",
                    "route-v2",
                ]
            )
            self.assertEqual(0, snapshot.returncode, snapshot.stderr)
            snapshot_state = json.loads(snapshot.stdout)
            business_state_sha256 = snapshot_state.pop("business_state_sha256")
            self.assertEqual(64, len(business_state_sha256))
            self.assertEqual(
                {
                    "active_wakes": 1,
                    "active_wakes_total": 1,
                    "events": 1,
                    "events_total": 1,
                    "expected_legacy_subscriptions": 0,
                    "pending": 1,
                    "pending_subscriptions": 1,
                    "pending_subscriptions_total": 1,
                    "pending_total": 1,
                    "routes": 1,
                    "schema_version": 6,
                    "subscriptions": 2,
                    "subscriptions_total": 2,
                    "wakes": 2,
                    "wakes_total": 2,
                },
                snapshot_state,
            )

    def test_ledger_state_hash_detects_delivery_state_swaps(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "events.sqlite3"
            ledger = EventLedger(path)
            ledger.register_route("route-hash", profile="test", state="active")
            ledger.register_subscription(
                "route-hash",
                "conversation-hash",
                1,
                subscription_id="subscription-hash",
            )
            first = ledger.ingest_event("route-hash", "fingerprint-first", "text", {"text": "one"})
            second = ledger.ingest_event("route-hash", "fingerprint-second", "text", {"text": "two"})
            wake = ledger.get_active_wake("subscription-hash")
            self.assertIsNotNone(wake)
            ledger.ack("subscription-hash", 1, wake["wake_id"], [first["event_id"]])

            before = json.loads(
                run_process(
                    [
                        sys.executable,
                        str(PROBE_SCRIPT),
                        "ledger-state",
                        "--ledger",
                        str(path),
                        "--route-id",
                        "route-hash",
                    ]
                ).stdout
            )
            connection = sqlite3.connect(path)
            try:
                connection.execute(
                    "UPDATE event_deliveries SET state='PENDING',acked_at=NULL WHERE event_id=?",
                    (first["event_id"],),
                )
                connection.execute(
                    "UPDATE event_deliveries SET state='ACKED',acked_at=? WHERE event_id=?",
                    ("2026-08-22T00:00:00+00:00", second["event_id"]),
                )
                connection.commit()
            finally:
                connection.close()
            after = json.loads(
                run_process(
                    [
                        sys.executable,
                        str(PROBE_SCRIPT),
                        "ledger-state",
                        "--ledger",
                        str(path),
                        "--route-id",
                        "route-hash",
                    ]
                ).stdout
            )

            self.assertNotEqual(before["business_state_sha256"], after["business_state_sha256"])
            before.pop("business_state_sha256")
            after.pop("business_state_sha256")
            self.assertEqual(before, after)

    def test_online_backup_is_complete_and_refuses_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "source.sqlite3"
            backup = root / "backup" / "events.sqlite3"
            ledger = EventLedger(source)
            ledger.register_route("route-backup", profile="test", state="active")
            result = run_process(
                [
                    sys.executable,
                    str(PROBE_SCRIPT),
                    "backup-ledger",
                    "--source",
                    str(source),
                    "--destination",
                    str(backup),
                ]
            )
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual("ok", json.loads(result.stdout)["integrity"])
            copied = EventLedger(backup)
            self.assertEqual("route-backup", copied.get_route("route-backup")["route_id"])
            duplicate = run_process(
                [
                    sys.executable,
                    str(PROBE_SCRIPT),
                    "backup-ledger",
                    "--source",
                    str(source),
                    "--destination",
                    str(backup),
                ]
            )
            self.assertNotEqual(0, duplicate.returncode)
            ledger.register_route("route-after-backup", profile="test", state="active")
            restored = run_process(
                [
                    sys.executable,
                    str(PROBE_SCRIPT),
                    "restore-ledger",
                    "--source",
                    str(backup),
                    "--destination",
                    str(source),
                ]
            )
            self.assertEqual(0, restored.returncode, restored.stderr)
            self.assertEqual("ok", json.loads(restored.stdout)["integrity"])
            connection = sqlite3.connect(source)
            try:
                route_ids = {row[0] for row in connection.execute("SELECT route_id FROM routes")}
            finally:
                connection.close()
            self.assertEqual({"route-backup"}, route_ids)

    def test_package_probe_resolves_inside_expected_root(self) -> None:
        result = run_process(
            [
                sys.executable,
                str(PROBE_SCRIPT),
                "package-info",
                "--expected-root",
                str(PACKAGE_ROOT),
            ]
        )
        self.assertEqual(0, result.returncode, result.stderr)
        package = json.loads(result.stdout)
        self.assertTrue(package["inside_release"])
        self.assertEqual(51, package["tool_count"])


@unittest.skipUnless(os.name == "nt" and POWERSHELL, "Windows PowerShell and Junctions required")
class ReleaseManagerDrillTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.manifest = self.root / "candidate-manifest.json"
        self.manifest.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "releaseId": "candidate-source",
                    "sourceCommit": "candidate-source-commit",
                    "activated": False,
                    "validation": {"unitTests": "fixture"},
                }
            ),
            encoding="utf-8",
        )
        self.package_source = self.root / "src" / "wechat_docs_mcp"
        shutil.copytree(PACKAGE_ROOT / "src" / "wechat_docs_mcp", self.package_source)
        inherited_python_path = os.environ.get("PYTHONPATH", "")
        self.package_environment = {
            "PYTHONPATH": os.pathsep.join(
                value for value in (str(self.root / "src"), inherited_python_path) if value
            )
        }

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_drill_uses_two_phase_polling_and_verifies_precommit_rollbacks(self) -> None:
        drill_root = self.root / "drill"
        result = run_process(
            [
                str(POWERSHELL),
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(RELEASE_SCRIPT),
                "-Action",
                "Drill",
                "-DrillRoot",
                str(drill_root),
                "-CandidateManifestPath",
                str(self.manifest),
                "-ProbePython",
                sys.executable,
                "-ServiceRoot",
                str(self.root / "protected-service"),
                "-DataRoot",
                str(self.root / "protected-data"),
                "-BrokerRoot",
                str(self.root / "protected-broker"),
                "-TimeoutSeconds",
                "5",
                "-StartupProbeTimeoutSeconds",
                "25",
            ],
            timeout=90,
            extra_environment=self.package_environment,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual("READY_FOR_ACTIVATION", summary["status"])
        self.assertFalse(summary["productionTouched"])
        self.assertEqual(4, len(summary["successfulCases"]))
        self.assertTrue(all(case["activeBackendPresent"] for case in summary["successfulCases"]))
        self.assertTrue(all(case["activationToolCount"] == 51 for case in summary["successfulCases"]))
        self.assertTrue(all(case["activated"] for case in summary["successfulCases"]))
        self.assertTrue(all(case["phaseAWatcherFrozen"] for case in summary["successfulCases"]))
        self.assertTrue(all(case["postCommitStatusVerified"] for case in summary["successfulCases"]))
        self.assertTrue(all(case["ledgerBackupPresent"] for case in summary["successfulCases"]))
        self.assertIn("v2-schema", {case["case"] for case in summary["successfulCases"]})
        self.assertTrue(all(case["schemaMigrated"] for case in summary["successfulCases"]))
        self.assertTrue(summary["forcedFailure"]["caught"])
        self.assertTrue(summary["forcedFailure"]["rollbackVerified"])
        self.assertEqual("release-old", summary["forcedFailure"]["currentReleaseId"])
        self.assertTrue(summary["forcedPreCommitFailure"]["caught"])
        self.assertTrue(summary["forcedPreCommitFailure"]["rollbackVerified"])
        self.assertTrue(summary["forcedPreCommitFailure"]["ledgerRestoredExactly"])
        self.assertEqual("release-old", summary["forcedPreCommitFailure"]["currentReleaseId"])

        missing_validation = json.loads(
            (drill_root / "missing-validation" / "service" / "releases" / "release-candidate" / "service-manifest.json").read_text(encoding="utf-8")
        )
        null_validation = json.loads(
            (drill_root / "null-validation" / "service" / "releases" / "release-candidate" / "service-manifest.json").read_text(encoding="utf-8")
        )
        null_active_backend = json.loads(
            (drill_root / "null-active-backend" / "service" / "releases" / "release-candidate" / "service-manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(51, missing_validation["validation"]["activeBackend"]["toolCount"])
        self.assertEqual(51, null_validation["validation"]["activeBackend"]["toolCount"])
        self.assertEqual(51, null_active_backend["validation"]["activeBackend"]["toolCount"])

        for case_name in ("missing-validation", "null-validation", "null-active-backend", "v2-schema"):
            case_root = drill_root / case_name
            active = json.loads((case_root / "service" / "pointers" / "active.json").read_text(encoding="utf-8"))
            last_known_good = json.loads(
                (case_root / "service" / "pointers" / "last-known-good.json").read_text(encoding="utf-8")
            )
            self.assertEqual("release-candidate", active["releaseId"])
            self.assertEqual("release-candidate", last_known_good["releaseId"])
            private_env = json.loads((case_root / "broker" / "broker-private.env.json").read_text(encoding="utf-8"))
            self.assertEqual("25000", private_env["CODEX_MCP_BROKER_WECHAT_DOCS_STARTUP_TIMEOUT_MS"])
            self.assertFalse(list((case_root / "service").glob("current.next-*")))
            connection = sqlite3.connect(case_root / "data" / "state" / "events.sqlite3")
            try:
                self.assertEqual(
                    "6",
                    connection.execute(
                        "SELECT value FROM schema_meta WHERE key='schema_version'"
                    ).fetchone()[0],
                )

                self.assertEqual("ok", connection.execute("PRAGMA integrity_check").fetchone()[0])
            finally:
                connection.close()

        for case_name in ("forced-health-failure", "forced-precommit-failure"):
            case_root = drill_root / case_name
            active = json.loads((case_root / "service" / "pointers" / "active.json").read_text(encoding="utf-8"))
            last_known_good = json.loads(
                (case_root / "service" / "pointers" / "last-known-good.json").read_text(encoding="utf-8")
            )
            self.assertEqual("release-old", active["releaseId"])
            self.assertEqual("release-old", last_known_good["releaseId"])
            private_env = json.loads((case_root / "broker" / "broker-private.env.json").read_text(encoding="utf-8"))
            self.assertEqual("25000", private_env["CODEX_MCP_BROKER_WECHAT_DOCS_STARTUP_TIMEOUT_MS"])
            self.assertFalse(list((case_root / "service").glob("current.next-*")))
            rollback_files = list((case_root / "data" / "backups").glob("*/rollback-verification.json"))
            self.assertEqual(1, len(rollback_files))
            rollback = json.loads(rollback_files[0].read_text(encoding="utf-8"))
            self.assertTrue(rollback["verified"])
            self.assertTrue(rollback["protectedBackendStable"])
            self.assertTrue(rollback["ledgerRestoredExactly"])
            self.assertTrue(Path(rollback["ledgerBackupPath"]).is_file())

    def test_release_reads_post_migration_ledger_after_status(self) -> None:
        script = RELEASE_SCRIPT.read_text(encoding="utf-8")
        status_call = script.index(
            '$PhaseAStatus = Invoke-McpTool -Mode $Mode -PythonPath $SwitchProbePython '
            '-FixtureStatePath $FixtureStatePath -ToolName "wechat_status"'
        )
        ledger_snapshot = script.index(
            "$AfterLedger = Get-LedgerState -PythonPath $SwitchProbePython"
        )
        self.assertLess(status_call, ledger_snapshot)

    def test_drill_rejects_missing_candidate_python(self) -> None:
        drill_root = self.root / "missing-python-drill"
        result = run_process(
            [
                str(POWERSHELL),
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(RELEASE_SCRIPT),
                "-Action",
                "Drill",
                "-DrillRoot",
                str(drill_root),
                "-CandidateManifestPath",
                str(self.manifest),
                "-ServiceRoot",
                str(self.root / "protected-service"),
                "-DataRoot",
                str(self.root / "protected-data"),
                "-BrokerRoot",
                str(self.root / "protected-broker"),
            ]
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("Candidate Python not found", result.stderr)
        self.assertFalse(drill_root.exists())

    def test_activate_requires_explicit_confirmation(self) -> None:
        result = run_process(
            [
                str(POWERSHELL),
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(RELEASE_SCRIPT),
                "-Action",
                "Activate",
                "-ServiceRoot",
                str(self.root / "service"),
                "-DataRoot",
                str(self.root / "data"),
                "-BrokerRoot",
                str(self.root / "broker"),
            ]
        )
        self.assertNotEqual(0, result.returncode)
        self.assertIn("ConfirmProductionActivation", result.stderr)
        self.assertFalse((self.root / "service").exists())
        self.assertFalse((self.root / "data").exists())
        self.assertFalse((self.root / "broker").exists())

    def test_timeout_contract_accepts_300_and_rejects_above_900(self) -> None:
        accepted = run_process(
            [
                str(POWERSHELL),
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(RELEASE_SCRIPT),
                "-Action",
                "Activate",
                "-TimeoutSeconds",
                "300",
                "-StartupProbeTimeoutSeconds",
                "300",
            ]
        )
        self.assertNotEqual(0, accepted.returncode)
        self.assertIn("ConfirmProductionActivation", accepted.stderr)
        self.assertNotIn("TimeoutSeconds", accepted.stderr.split("ConfirmProductionActivation")[0])

        rejected = run_process(
            [
                str(POWERSHELL),
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(RELEASE_SCRIPT),
                "-Action",
                "Activate",
                "-TimeoutSeconds",
                "901",
            ]
        )
        self.assertNotEqual(0, rejected.returncode)
        self.assertIn("TimeoutSeconds", rejected.stderr)
        self.assertNotIn("ConfirmProductionActivation", rejected.stderr)

    def test_http_wait_budgets_cover_backend_startup_timeout(self) -> None:
        script = RELEASE_SCRIPT.read_text(encoding="utf-8")
        self.assertIn(
            '-TimeoutSec ($StartupProbeTimeoutSeconds + 5)',
            script,
        )
        self.assertIn(
            '[Math]::Max($TimeoutSeconds, $StartupProbeTimeoutSeconds + 5)',
            script,
        )
        self.assertIn(
            '[Math]::Max($TimeoutSeconds, $StartupProbeTimeoutSeconds + 45)',
            script,
        )


if __name__ == "__main__":
    unittest.main()
