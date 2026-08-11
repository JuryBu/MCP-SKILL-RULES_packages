from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from wechat_docs_mcp.runtime_flags import (
    resolve_private_runtime_flag,
    resolve_private_runtime_gate,
)


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

    def test_server_reads_private_runtime_gate_without_reimport(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self.write_runtime(root, False)
            environment = os.environ.copy()
            environment["WECHAT_DOCS_MCP_DATA_ROOT"] = str(root)
            result = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    (
                        "import json; "
                        "from pathlib import Path; "
                        "from wechat_docs_mcp.server import "
                        "attachment_outbound_runtime_enabled, outbound_runtime_enabled; "
                        "root=Path(r'" + str(root) + "'); "
                        "path=root/'config'/'service-runtime.json'; "
                        "print(outbound_runtime_enabled(), attachment_outbound_runtime_enabled()); "
                        "path.write_text(json.dumps({'outboundWeChatEnabled': True, "
                        "'attachmentOutboundWeChatEnabled': False}), encoding='utf-8'); "
                        "print(outbound_runtime_enabled(), attachment_outbound_runtime_enabled())"
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
            self.assertEqual(["False False", "True False"], result.stdout.splitlines())

    def test_dynamic_gate_ignores_stale_environment_override(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self.write_runtime(root, True)
            with mock.patch.dict(
                os.environ,
                {"WECHAT_DOCS_MCP_OUTBOUND_ENABLED": "0"},
            ):
                self.assertTrue(
                    resolve_private_runtime_gate(root, "outboundWeChatEnabled")
                )

    def test_dynamic_gate_missing_malformed_and_non_boolean_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self.assertFalse(
                resolve_private_runtime_gate(root, "outboundWeChatEnabled")
            )
            runtime_path = root / "config" / "service-runtime.json"
            runtime_path.parent.mkdir(parents=True)
            runtime_path.write_text("{invalid", encoding="utf-8")
            self.assertFalse(
                resolve_private_runtime_gate(root, "outboundWeChatEnabled")
            )
            runtime_path.write_text(
                json.dumps({"outboundWeChatEnabled": "true"}),
                encoding="utf-8",
            )
            self.assertFalse(
                resolve_private_runtime_gate(root, "outboundWeChatEnabled")
            )

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
