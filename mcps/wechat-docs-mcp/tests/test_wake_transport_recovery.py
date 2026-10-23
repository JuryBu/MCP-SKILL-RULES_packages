from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from wechat_docs_mcp.ledger import EventLedger
from wechat_docs_mcp.wake_notifier import CodexWakeNotifier, TencentDocsWakeNotifier


def make_notifier(tmp_path: Path, client: httpx.Client | None = None) -> CodexWakeNotifier:
    ledger = EventLedger(tmp_path / "events.sqlite3")
    ledger.register_route("route-test", "conversation-test", 1, "test", {}, "active")
    ledger.ingest_event("route-test", "source-test", "text", {"visible_text": "private"})
    runtime = tmp_path / "runtime.json"
    runtime.write_text(json.dumps({"controlUrl": "http://127.0.0.1:12345"}), encoding="utf-8")
    token = tmp_path / "token.txt"
    token.write_text("sanitized-token", encoding="utf-8")
    return CodexWakeNotifier(
        ledger, runtime, token, "local", "local", client=client, retry_interval_seconds=1
    )


def test_real_loopback_delivery_ignores_system_proxy_environment(tmp_path: Path) -> None:
    received: list[dict[str, object]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            received.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            body = json.dumps({"ok": True, "outcome": "accepted"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    notifier = None
    try:
        with patch.dict(os.environ, {
            "HTTP_PROXY": "http://127.0.0.1:1",
            "HTTPS_PROXY": "http://127.0.0.1:1",
            "ALL_PROXY": "http://127.0.0.1:1",
            "NO_PROXY": "",
        }):
            notifier = make_notifier(tmp_path)
            notifier.runtime_file.write_text(
                json.dumps({"controlUrl": f"http://127.0.0.1:{server.server_port}"}),
                encoding="utf-8",
            )
            result = notifier.submit_pending()
        assert result["submitted_count"] == 1
        assert result["attempted_count"] == 1
        assert len(received) == 1
        assert "private" not in str(received[0]["prompt"])
    finally:
        if notifier is not None:
            notifier.client.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.parametrize("notifier_type", [CodexWakeNotifier, TencentDocsWakeNotifier])
@pytest.mark.parametrize("error_type,expected", [
    (httpx.ConnectError, "PROXY_CONNECT_ERROR"),
    (httpx.ConnectTimeout, "PROXY_CONNECT_TIMEOUT"),
    (httpx.ReadTimeout, "PROXY_READ_TIMEOUT"),
    (httpx.WriteError, "PROXY_WRITE_ERROR"),
    (httpx.PoolTimeout, "PROXY_POOL_TIMEOUT"),
    (httpx.RemoteProtocolError, "PROXY_REMOTE_PROTOCOL_ERROR"),
    (httpx.ProxyError, "PROXY_CONNECTION_ERROR"),
])
def test_transport_error_codes_do_not_expose_request_data(
    notifier_type: type[CodexWakeNotifier], error_type: type[httpx.HTTPError], expected: str
) -> None:
    request = httpx.Request("POST", "http://127.0.0.1:12345/v1/wakes", headers={"authorization": "private"})
    error = error_type("private token and request content", request=request)
    assert notifier_type._error_code(error) == expected


def test_deferred_attempt_preserves_error_until_success_without_duplicate_identity(tmp_path: Path) -> None:
    requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        if len(requests) == 1:
            raise httpx.ConnectError("connection refused", request=request)
        return httpx.Response(200, json={"ok": True, "outcome": "accepted", "duplicateSuppressed": True})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        notifier = make_notifier(tmp_path, client)
        with patch("wechat_docs_mcp.wake_notifier.time.monotonic", side_effect=[10, 10.5, 12]):
            first = notifier.submit_pending()
            deferred = notifier.submit_pending()
            recovered = notifier.submit_pending()
        assert first["errors"][0]["code"] == "PROXY_CONNECT_ERROR"
        assert deferred["errors"] == first["errors"]
        assert deferred["attempted_count"] == 0
        assert deferred["deferred_count"] == 1
        assert recovered["errors"] == []
        assert recovered["submitted_count"] == 1
        assert recovered["duplicate_count"] == 1
        assert len(requests) == 2
        assert requests[0] == requests[1]
        assert notifier.ledger.get_active_wake("route-test")["state"] == "submitted"
        assert notifier.submit_pending()["attempted_count"] == 0


def test_unresolved_error_is_removed_when_notification_is_no_longer_pending(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("private", request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        notifier = make_notifier(tmp_path, client)
        assert notifier.submit_pending()["errors"][0]["code"] == "PROXY_READ_TIMEOUT"
        with patch.object(notifier, "_list_wakes", return_value=[]):
            result = notifier.submit_pending()
        assert result["errors"] == []
        assert notifier._last_errors == {}


def test_default_batch_limit_preserves_omitted_unknown_notification_error(tmp_path: Path) -> None:
    attempted: list[str] = []
    failing_id = ""

    def handler(request: httpx.Request) -> httpx.Response:
        notification_id = json.loads(request.content)["wakeId"]
        attempted.append(notification_id)
        if notification_id == failing_id:
            raise httpx.ReadTimeout("response not received", request=request)
        return httpx.Response(200, json={"ok": True, "outcome": "accepted"})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        notifier = make_notifier(tmp_path, client)
        for number in range(100):
            route_id = f"route-{number}"
            notifier.ledger.register_route(route_id, f"conversation-{number}", 1, "test", {}, "active")
            notifier.ledger.ingest_event(route_id, f"source-{number}", "text", {})
        candidates = notifier.ledger.list_wakes_for_notification(500)
        assert len(candidates) == 101
        omitted = candidates[-1]
        failing_id = omitted["notification_id"]
        with patch("wechat_docs_mcp.wake_notifier.time.monotonic", return_value=10):
            with patch.object(notifier, "_list_wakes", return_value=[omitted]):
                failed = notifier.submit_pending()
            full_batch = notifier.submit_pending()
            deferred = notifier.submit_pending()
        assert failed["errors"][0]["code"] == "PROXY_READ_TIMEOUT"
        assert full_batch["submitted_count"] == 100
        assert full_batch["errors"] == failed["errors"]
        assert deferred["attempted_count"] == 0
        assert deferred["deferred_count"] == 1
        assert deferred["errors"] == failed["errors"]
        assert attempted.count(failing_id) == 1
        assert notifier.ledger.get_active_wake(omitted["subscription_id"])["state"] == "unknown"
