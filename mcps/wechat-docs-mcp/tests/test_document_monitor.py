from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import pytest

from wechat_docs_mcp.document_monitor import DocumentMonitorStore, TencentDocsMonitorService
from wechat_docs_mcp.document_policy import (
    DocumentMonitorPolicyError,
    PrivateBindingDocumentMonitorVerifier,
)
from wechat_docs_mcp.ledger import EventLedger, LedgerError


TOOL = {
    "name": "manage.query_file_info",
    "description": "query file metadata",
    "inputSchema": {
        "type": "object",
        "properties": {"file_id": {"type": "string"}},
        "required": ["file_id"],
    },
}

CONTENT_TOOL = {
    "name": "get_content",
    "description": "read document content",
    "inputSchema": {
        "type": "object",
        "properties": {"file_id": {"type": "string"}},
        "required": ["file_id"],
    },
}


def policy_binding(
    *,
    state: str = "active",
    listen: bool = True,
    resource_key: str = "private-file-id",
    policy_ref: str = "private-monitor-policy",
    poll_tool: str = "manage.query_file_info",
    poll_arguments: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "tencentDocs": {
            "monitors": [
                {
                    "policy_ref": policy_ref,
                    "resource_kind": "doc",
                    "resource_key": resource_key,
                    "poll_tool": poll_tool,
                    "poll_arguments": (
                        {"file_id": resource_key} if poll_arguments is None else poll_arguments
                    ),
                    "state": state,
                    "listen": listen,
                }
            ]
        },
    }


def tool_result(payload: Any, *, is_error: bool = False) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "result": {
            "isError": is_error,
            "content": [{"type": "text", "text": json.dumps(payload)}],
        },
    }


class FakeDocsClient:
    def __init__(self, responses: list[Any], catalog: list[dict[str, Any]] | None = None) -> None:
        self.responses = list(responses)
        self.catalog = catalog if catalog is not None else [TOOL]
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def tool_catalog(self) -> list[dict[str, Any]]:
        return self.catalog

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((name, arguments))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def monitor_service(
    store: DocumentMonitorStore,
    client: FakeDocsClient,
    binding: dict[str, Any] | None = None,
) -> TencentDocsMonitorService:
    return TencentDocsMonitorService(
        store,
        client,
        PrivateBindingDocumentMonitorVerifier(binding or policy_binding()),
    )


def make_store(tmp_path: Path) -> tuple[Path, DocumentMonitorStore]:
    database = tmp_path / "events.sqlite3"
    return database, DocumentMonitorStore(EventLedger(database))


def register_monitor(
    store: DocumentMonitorStore,
    start: datetime,
    *,
    monitor_id: str = "monitor-one",
) -> None:
    store.register_monitor(
        "doc",
        "private-file-id",
        "manage.query_file_info",
        {"file_id": "private-file-id"},
        "baseline-a",
        {"payload_type": "dict"},
        policy_ref="private-monitor-policy",
        monitor_id=monitor_id,
        observed_at=start,
    )


def test_create_monitor_establishes_current_baseline_without_replay(tmp_path: Path) -> None:
    _, store = make_store(tmp_path)
    client = FakeDocsClient([tool_result({"modified_at": 1, "trace_id": "volatile"})])
    service = monitor_service(store, client)

    monitor = asyncio.run(
        service.create_monitor(
            "doc",
            "private-file-id",
            "manage.query_file_info",
            {"file_id": "private-file-id"},
            "private-monitor-policy",
            monitor_id="monitor-one",
        )
    )
    subscription = store.register_subscription(
        monitor["monitor_id"], "conversation-one", 1, subscription_id="subscription-one"
    )

    assert monitor["baseline_fingerprint"]
    assert "poll_arguments_json" not in monitor
    assert subscription["baseline_batch_seq"] == 0
    assert store.list_pending("subscription-one") == []
    assert store.get_active_wake("subscription-one") is None


def test_create_monitor_reconfigures_paused_monitor_without_replay(tmp_path: Path) -> None:
    _, store = make_store(tmp_path)
    original_client = FakeDocsClient([tool_result({"modified_at": 1})])
    original_service = monitor_service(store, original_client)
    original = asyncio.run(
        original_service.create_monitor(
            "doc",
            "private-file-id",
            "manage.query_file_info",
            {"file_id": "private-file-id"},
            "private-monitor-policy",
            monitor_id="monitor-one",
        )
    )
    store.register_subscription(
        "monitor-one", "conversation-one", 1, subscription_id="subscription-one"
    )
    store.set_subscription_state("subscription-one", 1, "paused")
    store.set_monitor_state("monitor-one", "paused")

    content_client = FakeDocsClient(
        [tool_result({"text": "current document"})],
        catalog=[CONTENT_TOOL],
    )
    content_service = monitor_service(
        store,
        content_client,
        policy_binding(poll_tool="get_content"),
    )
    reconfigured = asyncio.run(
        content_service.create_monitor(
            "doc",
            "private-file-id",
            "get_content",
            {"file_id": "private-file-id"},
            "private-monitor-policy",
            monitor_id="monitor-one",
        )
    )

    assert reconfigured["poll_tool"] == "get_content"
    assert reconfigured["state"] == "active"
    assert reconfigured["baseline_fingerprint"] != original["baseline_fingerprint"]
    assert store.list_pending("subscription-one") == []
    assert store.get_active_wake("subscription-one") is None


def test_active_monitor_cannot_be_reconfigured(tmp_path: Path) -> None:
    _, store = make_store(tmp_path)
    register_monitor(store, datetime(2026, 8, 10, tzinfo=timezone.utc))
    content_client = FakeDocsClient([], catalog=[CONTENT_TOOL])
    service = monitor_service(
        store,
        content_client,
        policy_binding(poll_tool="get_content"),
    )

    with pytest.raises(LedgerError) as raised:
        asyncio.run(
            service.create_monitor(
                "doc",
                "private-file-id",
                "get_content",
                {"file_id": "private-file-id"},
                "private-monitor-policy",
                monitor_id="monitor-one",
            )
        )

    assert raised.value.code == "DOCUMENT_MONITOR_RECONFIGURE_REQUIRES_PAUSED"
    assert content_client.calls == []


def test_monitor_with_pending_delivery_cannot_be_reconfigured(tmp_path: Path) -> None:
    _, store = make_store(tmp_path)
    start = datetime(2026, 8, 10, tzinfo=timezone.utc)
    register_monitor(store, start)
    store.register_subscription(
        "monitor-one", "conversation-one", 1, subscription_id="subscription-one"
    )
    store.record_poll_success("monitor-one", "change-b", {"object_count": 1}, start)
    store.promote_ready(start + timedelta(minutes=5))
    store.set_monitor_state("monitor-one", "paused")
    content_client = FakeDocsClient([], catalog=[CONTENT_TOOL])
    service = monitor_service(
        store,
        content_client,
        policy_binding(poll_tool="get_content"),
    )

    with pytest.raises(LedgerError) as raised:
        asyncio.run(
            service.create_monitor(
                "doc",
                "private-file-id",
                "get_content",
                {"file_id": "private-file-id"},
                "private-monitor-policy",
                monitor_id="monitor-one",
            )
        )

    assert raised.value.code == "DOCUMENT_MONITOR_RECONFIGURE_PENDING"
    assert content_client.calls == []


def test_quiet_and_max_windows_merge_many_changes_into_one_wake(tmp_path: Path) -> None:
    _, store = make_store(tmp_path)
    start = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
    register_monitor(store, start)
    store.register_subscription(
        "monitor-one", "conversation-one", 1, subscription_id="subscription-one"
    )

    for minute, fingerprint in ((0, "b"), (4, "c"), (8, "d"), (12, "e"), (14, "f")):
        store.record_poll_success(
            "monitor-one",
            fingerprint,
            {"array_items": minute + 1},
            start + timedelta(minutes=minute),
        )

    assert store.promote_ready(start + timedelta(minutes=14, seconds=59)) == []
    promoted = store.promote_ready(start + timedelta(minutes=15))
    pending = store.list_pending("subscription-one")

    assert len(promoted) == 1
    assert len(pending) == 1
    assert pending[0]["change_count"] == 5
    assert store.get_active_wake("subscription-one") is not None


def test_two_subscriptions_receive_and_ack_same_batch_independently(tmp_path: Path) -> None:
    _, store = make_store(tmp_path)
    start = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
    register_monitor(store, start)
    for suffix in ("a", "b"):
        store.register_subscription(
            "monitor-one",
            f"conversation-{suffix}",
            1,
            subscription_id=f"subscription-{suffix}",
        )
    store.record_poll_success("monitor-one", "change-b", {"object_count": 2}, start)
    store.promote_ready(start + timedelta(minutes=5))

    pending_a = store.list_pending("subscription-a")
    pending_b = store.list_pending("subscription-b")
    wake_a = store.get_active_wake("subscription-a")
    wake_b = store.get_active_wake("subscription-b")
    assert pending_a[0]["batch_id"] == pending_b[0]["batch_id"]

    result = store.ack(
        "subscription-a", 1, wake_a["wake_id"], [pending_a[0]["batch_id"]]
    )
    assert result["pending_count"] == 0
    assert store.list_pending("subscription-a") == []
    assert store.list_pending("subscription-b")[0]["batch_id"] == pending_b[0]["batch_id"]
    assert store.get_active_wake("subscription-b")["wake_id"] == wake_b["wake_id"]


@pytest.mark.parametrize(
    ("response", "error_code"),
    [
        (tool_result({"modified_at": 2}, is_error=True), "OFFICIAL_TOOL_IS_ERROR"),
        (tool_result({"items": [1], "has_next": True}), "OFFICIAL_RESULT_INCOMPLETE"),
        ({"jsonrpc": "2.0", "error": {"code": -32000}}, "OFFICIAL_JSONRPC_ERROR"),
        ({"jsonrpc": "2.0", "result": {}}, "OFFICIAL_RESULT_INCOMPLETE"),
        (httpx.ConnectError("offline"), "OFFICIAL_TRANSPORT_ERROR"),
    ],
)
def test_failed_or_incomplete_poll_does_not_advance_baseline(
    tmp_path: Path, response: Any, error_code: str
) -> None:
    _, store = make_store(tmp_path)
    client = FakeDocsClient([tool_result({"modified_at": 1}), response])
    service = monitor_service(store, client)
    asyncio.run(
        service.create_monitor(
            "doc",
            "private-file-id",
            "manage.query_file_info",
            {"file_id": "private-file-id"},
            "private-monitor-policy",
            monitor_id="monitor-one",
        )
    )
    baseline = store.get_monitor("monitor-one", private=True)["baseline_fingerprint"]

    result = asyncio.run(service.poll_one("monitor-one"))
    current = store.get_monitor("monitor-one", private=True)

    assert result["status"] == "failed"
    assert result["error_code"] == error_code
    assert result["baseline_advanced"] is False
    assert current["baseline_fingerprint"] == baseline
    assert current["consecutive_failures"] == 1


def test_restart_does_not_replay_and_global_change_fingerprint_dedupes(tmp_path: Path) -> None:
    database, store = make_store(tmp_path)
    start = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
    register_monitor(store, start)
    store.register_subscription(
        "monitor-one", "conversation-one", 1, subscription_id="subscription-one"
    )
    first = store.record_poll_success("monitor-one", "change-b", {}, start)
    duplicate = store.record_poll_success(
        "monitor-one", "change-b", {}, start + timedelta(minutes=1)
    )
    assert first["change_inserted"] is True
    assert duplicate["changed"] is False

    restarted = DocumentMonitorStore(EventLedger(database))
    after_restart = restarted.record_poll_success(
        "monitor-one", "change-b", {}, start + timedelta(minutes=2)
    )
    assert after_restart["changed"] is False
    assert restarted.list_pending("subscription-one") == []


def test_subscription_created_after_existing_batch_uses_current_baseline(tmp_path: Path) -> None:
    _, store = make_store(tmp_path)
    start = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
    register_monitor(store, start)
    store.record_poll_success("monitor-one", "change-b", {}, start)
    subscription = store.register_subscription(
        "monitor-one", "conversation-late", 1, subscription_id="subscription-late"
    )
    store.promote_ready(start + timedelta(minutes=5))

    assert subscription["baseline_batch_seq"] == 1
    assert store.list_pending("subscription-late") == []


def test_dynamic_catalog_and_required_arguments_are_enforced(tmp_path: Path) -> None:
    _, store = make_store(tmp_path)
    private_policy = policy_binding(resource_key="private", policy_ref="policy")
    missing_tool = monitor_service(store, FakeDocsClient([], catalog=[]), private_policy)
    with pytest.raises(LedgerError) as absent:
        asyncio.run(
            missing_tool.create_monitor(
                "doc", "private", "manage.query_file_info", {"file_id": "private"}, "policy"
            )
        )
    assert absent.value.code == "OFFICIAL_TOOL_NOT_FOUND"

    missing_argument = monitor_service(
        store,
        FakeDocsClient([], catalog=[TOOL]),
        policy_binding(resource_key="private", policy_ref="policy", poll_arguments={}),
    )
    with pytest.raises(LedgerError) as invalid:
        asyncio.run(
            missing_argument.create_monitor(
                "doc", "private", "manage.query_file_info", {}, "policy"
            )
        )
    assert invalid.value.code == "DOCUMENT_POLL_ARGUMENTS_MISSING"


def test_same_change_fingerprint_is_not_inserted_twice_across_batches(tmp_path: Path) -> None:
    _, store = make_store(tmp_path)
    start = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
    register_monitor(store, start)
    store.record_poll_success("monitor-one", "change-b", {}, start)
    store.record_poll_success("monitor-one", "change-c", {}, start + timedelta(minutes=6))
    duplicate = store.record_poll_success(
        "monitor-one", "change-b", {}, start + timedelta(minutes=7)
    )

    connection = store.ledger._connect()
    try:
        count = connection.execute(
            "SELECT COUNT(*) FROM tdocs_monitor_changes WHERE monitor_id='monitor-one'"
        ).fetchone()[0]
    finally:
        connection.close()
    assert duplicate["change_inserted"] is False
    assert count == 2


def test_monitor_creation_requires_an_exact_active_private_allowlist(tmp_path: Path) -> None:
    _, store = make_store(tmp_path)
    client = FakeDocsClient([tool_result({"modified_at": 1})])
    service = monitor_service(store, client, {"schemaVersion": 2})

    with pytest.raises(DocumentMonitorPolicyError) as raised:
        asyncio.run(
            service.create_monitor(
                "doc",
                "private-file-id",
                "manage.query_file_info",
                {"file_id": "private-file-id"},
                "private-monitor-policy",
            )
        )

    assert raised.value.code == "NOT_FOUND"
    assert client.calls == []
    assert store.list_monitors() == []


def test_poll_rechecks_private_allowlist_before_remote_read(tmp_path: Path) -> None:
    _, store = make_store(tmp_path)
    binding = policy_binding()
    client = FakeDocsClient(
        [tool_result({"modified_at": 1}), tool_result({"modified_at": 2})]
    )
    service = monitor_service(store, client, binding)
    asyncio.run(
        service.create_monitor(
            "doc",
            "private-file-id",
            "manage.query_file_info",
            {"file_id": "private-file-id"},
            "private-monitor-policy",
            monitor_id="monitor-one",
        )
    )
    baseline = store.get_monitor("monitor-one", private=True)["baseline_fingerprint"]
    binding["tencentDocs"]["monitors"][0]["state"] = "paused"

    result = asyncio.run(service.poll_one("monitor-one"))

    assert result["status"] == "failed"
    assert result["error_code"] == "UNVERIFIED"
    assert result["baseline_advanced"] is False
    assert len(client.calls) == 1
    assert store.get_monitor("monitor-one", private=True)["baseline_fingerprint"] == baseline


def test_failed_poll_still_promotes_an_already_due_batch(tmp_path: Path) -> None:
    _, store = make_store(tmp_path)
    start = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
    register_monitor(store, start)
    store.register_subscription(
        "monitor-one", "conversation-one", 1, subscription_id="subscription-one"
    )
    observed = store.record_poll_success("monitor-one", "change-b", {}, start)
    service = monitor_service(store, FakeDocsClient([httpx.ConnectError("offline")]))

    result = asyncio.run(service.poll_one("monitor-one"))

    assert result["status"] == "failed"
    assert result["error_code"] == "OFFICIAL_TRANSPORT_ERROR"
    assert result["promoted_batch_ids"] == [observed["batch_id"]]
    assert store.list_pending("subscription-one")[0]["batch_id"] == observed["batch_id"]
