from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from wechat_docs_mcp.document_monitor import DocumentMonitorStore
from wechat_docs_mcp.ledger import EventLedger
from wechat_docs_mcp.wake_notifier import TencentDocsWakeNotifier


def test_document_wake_routes_by_subscription_without_document_body(tmp_path: Path) -> None:
    store = DocumentMonitorStore(EventLedger(tmp_path / "events.sqlite3"))
    start = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
    store.register_monitor(
        "sheet",
        "private-file-id",
        "manage.query_file_info",
        {"file_id": "private-file-id"},
        "baseline-a",
        {},
        policy_ref="private-policy",
        monitor_id="monitor-one",
        observed_at=start,
    )
    store.register_subscription(
        "monitor-one",
        "conversation-one",
        1,
        subscription_id="subscription-one",
    )
    store.record_poll_success(
        "monitor-one",
        "change-b",
        {"sentinel": "DO_NOT_INCLUDE_DOCUMENT_BODY"},
        start,
    )
    store.promote_ready(start + timedelta(minutes=5))

    runtime = tmp_path / "runtime.json"
    token = tmp_path / "token.txt"
    runtime.write_text(json.dumps({"controlUrl": "http://127.0.0.1:14599"}), encoding="utf-8")
    token.write_text("private-token", encoding="utf-8")
    requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "outcome": "accepted"})

    notifier = TencentDocsWakeNotifier(
        store,
        runtime,
        token,
        "development",
        "development",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        retry_interval_seconds=1,
    )
    result = notifier.submit_pending()

    assert result["submitted_count"] == 1
    assert requests[0]["threadId"] == "conversation-one"
    assert "monitor_id=monitor-one" in str(requests[0]["prompt"])
    assert "subscription_id=subscription-one" in str(requests[0]["prompt"])
    assert "DO_NOT_INCLUDE_DOCUMENT_BODY" not in str(requests[0]["prompt"])
    assert store.get_active_wake("subscription-one")["state"] == "submitted"
