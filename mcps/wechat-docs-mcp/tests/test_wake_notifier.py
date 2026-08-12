from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import httpx

from wechat_docs_mcp.ledger import EventLedger
from wechat_docs_mcp.wake_notifier import CodexWakeNotifier, WakeNotifierError


class WakeNotifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.ledger = EventLedger(self.root / "events.sqlite3")
        self.ledger.register_route(
            "route-test",
            "conversation-test",
            1,
            "human_group_test",
            {"chat_name": "sanitized"},
            "active",
        )
        self.runtime_file = self.root / "proxy-runtime.json"
        self.runtime_file.write_text(json.dumps({"controlUrl": "http://127.0.0.1:12345"}), encoding="utf-8")
        self.token_file = self.root / "proxy-token.txt"
        self.token_file.write_text("sanitized-token", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _notifier(
        self, handler: object, message_visibility: str = "visible"
    ) -> CodexWakeNotifier:
        client = httpx.Client(transport=httpx.MockTransport(handler))
        return CodexWakeNotifier(
            self.ledger,
            self.runtime_file,
            self.token_file,
            "development",
            "development",
            client=client,
            retry_interval_seconds=1,
            message_visibility=message_visibility,
        )

    def test_visible_wake_omits_message_content_and_marks_submitted(self) -> None:
        event = self.ledger.ingest_event(
            "route-test",
            "fp-secret",
            "text",
            {"visible_text": "DO_NOT_INCLUDE_THIS_MESSAGE"},
        )
        requests: list[dict[str, object]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            requests.append(body)
            self.assertEqual("Bearer sanitized-token", request.headers["authorization"])
            return httpx.Response(200, json={"ok": True, "outcome": "accepted", "duplicateSuppressed": False})

        result = self._notifier(handler).submit_pending()

        self.assertEqual(1, result["submitted_count"])
        self.assertEqual(event["wake"]["wake_id"], requests[0]["wakeId"])
        self.assertEqual("visible", requests[0]["messageVisibility"])
        self.assertNotIn("DO_NOT_INCLUDE_THIS_MESSAGE", requests[0]["prompt"])
        self.assertEqual("submitted", self.ledger.get_active_wake("route-test")["state"])

    def test_hidden_request_body_matches_visible_except_visibility(self) -> None:
        self.ledger.ingest_event(
            "route-test",
            "fp-visibility-ab",
            "text",
            {"visible_text": "private"},
        )
        wake = self.ledger.list_wakes_for_notification(1)[0]
        handler = lambda request: httpx.Response(200, json={"ok": True})
        visible = self._notifier(handler)._request_body(wake)
        hidden = self._notifier(handler, "hidden")._request_body(wake)

        self.assertEqual("visible", visible.pop("messageVisibility"))
        self.assertEqual("hidden", hidden.pop("messageVisibility"))
        self.assertEqual(visible, hidden)

    def test_invalid_message_visibility_is_rejected(self) -> None:
        with self.assertRaises(WakeNotifierError) as raised:
            self._notifier(
                lambda request: httpx.Response(200),
                "transparent",
            )

        self.assertEqual("WAKE_MESSAGE_VISIBILITY_INVALID", raised.exception.code)

    def test_server_startup_rejects_invalid_message_visibility(self) -> None:
        environment = os.environ.copy()
        environment["WECHAT_DOCS_MCP_WAKE_MESSAGE_VISIBILITY"] = "transparent"

        result = subprocess.run(
            [sys.executable, "-c", "import wechat_docs_mcp.server"],
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
            check=False,
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("wake message visibility must be visible or hidden", result.stderr)

    def test_transport_uncertainty_reuses_same_wake_id(self) -> None:
        event = self.ledger.ingest_event("route-test", "fp-retry", "text", {"visible_text": "private"})
        attempts: list[tuple[str, str]] = []

        def failing_handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            attempts.append((body["wakeId"], body["messageVisibility"]))
            raise httpx.ConnectError("temporary", request=request)

        first = self._notifier(failing_handler, "hidden").submit_pending()
        self.assertEqual(1, first["unknown_count"])
        self.assertEqual("unknown", self.ledger.get_active_wake("route-test")["state"])

        def success_handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            attempts.append((body["wakeId"], body["messageVisibility"]))
            return httpx.Response(200, json={"ok": True, "outcome": "accepted", "duplicateSuppressed": True})

        second = self._notifier(success_handler, "hidden").submit_pending()
        self.assertEqual(1, second["submitted_count"])
        self.assertEqual(1, second["duplicate_count"])
        self.assertEqual([(event["wake"]["wake_id"], "hidden")] * 2, attempts)

    def test_busy_proxy_keeps_wake_prepared_for_retry(self) -> None:
        self.ledger.ingest_event("route-test", "fp-busy", "text", {"visible_text": "private"})

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"ok": True, "outcome": "busy", "duplicateSuppressed": False})

        result = self._notifier(handler).submit_pending()

        self.assertEqual(0, result["submitted_count"])
        self.assertEqual(1, result["deferred_count"])
        self.assertEqual("THREAD_BUSY", result["errors"][0]["code"])
        self.assertEqual("prepared", self.ledger.get_active_wake("route-test")["state"])

    def test_proxy_unknown_outcome_marks_wake_unknown(self) -> None:
        self.ledger.ingest_event("route-test", "fp-unknown", "text", {"visible_text": "private"})

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"ok": True, "outcome": "unknown", "duplicateSuppressed": True})

        result = self._notifier(handler).submit_pending()

        self.assertEqual(1, result["unknown_count"])
        self.assertEqual("unknown", self.ledger.get_active_wake("route-test")["state"])

    def test_non_loopback_control_url_is_rejected(self) -> None:
        self.runtime_file.write_text(json.dumps({"controlUrl": "https://example.invalid"}), encoding="utf-8")
        self.ledger.ingest_event("route-test", "fp-loopback", "text", {"visible_text": "private"})
        result = self._notifier(lambda request: httpx.Response(500)).submit_pending()
        self.assertEqual("PROXY_CONTROL_URL_NOT_LOOPBACK", result["errors"][0]["code"])


if __name__ == "__main__":
    unittest.main()
