from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


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
        timeout=timeout,
        check=False,
    )


class ReleaseProbeTests(unittest.TestCase):
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
                {"active_wakes": 0, "events": 1, "pending": 0, "wakes": 1},
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
        self.assertEqual(15, package["tool_count"])


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

    def test_drill_upgrades_old_manifests_and_verifies_rollbacks(self) -> None:
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
            ],
            timeout=90,
            extra_environment=self.package_environment,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual("READY_FOR_ACTIVATION", summary["status"])
        self.assertFalse(summary["productionTouched"])
        self.assertEqual(3, len(summary["successfulCases"]))
        self.assertTrue(all(case["activeBackendPresent"] for case in summary["successfulCases"]))
        self.assertTrue(all(case["rollbackVerified"] for case in summary["successfulCases"]))
        self.assertTrue(summary["forcedFailure"]["caught"])
        self.assertTrue(summary["forcedFailure"]["rollbackVerified"])
        self.assertEqual("release-old", summary["forcedFailure"]["currentReleaseId"])

        missing_validation = json.loads(
            (drill_root / "missing-validation" / "service" / "releases" / "release-candidate" / "service-manifest.json").read_text(encoding="utf-8")
        )
        null_validation = json.loads(
            (drill_root / "null-validation" / "service" / "releases" / "release-candidate" / "service-manifest.json").read_text(encoding="utf-8")
        )
        null_active_backend = json.loads(
            (drill_root / "null-active-backend" / "service" / "releases" / "release-candidate" / "service-manifest.json").read_text(encoding="utf-8")
        )
        self.assertNotIn("validation", missing_validation)
        self.assertIsNone(null_validation["validation"])
        self.assertIsNone(null_active_backend["validation"]["activeBackend"])

        for case_name in (
            "missing-validation",
            "null-validation",
            "null-active-backend",
            "forced-health-failure",
        ):
            case_root = drill_root / case_name
            active = json.loads((case_root / "service" / "pointers" / "active.json").read_text(encoding="utf-8"))
            last_known_good = json.loads(
                (case_root / "service" / "pointers" / "last-known-good.json").read_text(encoding="utf-8")
            )
            self.assertEqual("release-old", active["releaseId"])
            self.assertEqual("release-old", last_known_good["releaseId"])
            self.assertFalse(list((case_root / "service").glob("current.next-*")))
            rollback_files = list((case_root / "data" / "backups").glob("*/rollback-verification.json"))
            self.assertEqual(1, len(rollback_files))
            rollback = json.loads(rollback_files[0].read_text(encoding="utf-8"))
            self.assertTrue(rollback["verified"])
            self.assertTrue(rollback["protectedBackendStable"])

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


if __name__ == "__main__":
    unittest.main()
