from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from wechat_docs_mcp.runtime_flags import resolve_private_runtime_flag


class PrivateRuntimeFlagTests(unittest.TestCase):
    def test_environment_true_overrides_false_runtime_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self.write_runtime(root, False)
            self.assertTrue(self.resolve(root, {"TEST_ATTACHMENT_FLAG": "1"}))

    def test_environment_false_overrides_true_runtime_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self.write_runtime(root, True)
            self.assertFalse(self.resolve(root, {"TEST_ATTACHMENT_FLAG": "false"}))

    def test_runtime_file_true_is_used_when_environment_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self.write_runtime(root, True)
            self.assertTrue(self.resolve(root, {}))

    def test_server_import_consumes_private_runtime_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self.write_runtime(root, True)
            environment = os.environ.copy()
            environment["WECHAT_DOCS_MCP_DATA_ROOT"] = str(root)
            environment.pop("WECHAT_DOCS_MCP_OUTBOUND_ENABLED", None)
            environment.pop("WECHAT_DOCS_MCP_ATTACHMENT_OUTBOUND_ENABLED", None)
            result = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    (
                        "from wechat_docs_mcp.server import "
                        "ATTACHMENT_OUTBOUND_ENABLED, OUTBOUND_ENABLED; "
                        "print(OUTBOUND_ENABLED, ATTACHMENT_OUTBOUND_ENABLED)"
                    ),
                ],
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
                check=False,
            )
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertEqual("True True", result.stdout.strip())

    def test_missing_malformed_and_non_boolean_values_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self.assertFalse(self.resolve(root, {}))
            runtime_path = root / "config" / "service-runtime.json"
            runtime_path.parent.mkdir(parents=True)
            runtime_path.write_text("{invalid", encoding="utf-8")
            self.assertFalse(self.resolve(root, {}))
            runtime_path.write_text(
                json.dumps({"attachmentOutboundWeChatEnabled": "true"}),
                encoding="utf-8",
            )
            self.assertFalse(self.resolve(root, {}))
            self.assertFalse(self.resolve(root, {"TEST_ATTACHMENT_FLAG": "unexpected"}))

    @staticmethod
    def write_runtime(root: Path, value: bool) -> None:
        runtime_path = root / "config" / "service-runtime.json"
        runtime_path.parent.mkdir(parents=True)
        runtime_path.write_text(
            json.dumps(
                {
                    "outboundWeChatEnabled": value,
                    "attachmentOutboundWeChatEnabled": value,
                }
            ),
            encoding="utf-8",
        )

    @staticmethod
    def resolve(root: Path, environ: dict[str, str]) -> bool:
        return resolve_private_runtime_flag(
            root,
            "attachmentOutboundWeChatEnabled",
            "TEST_ATTACHMENT_FLAG",
            environ=environ,
        )
