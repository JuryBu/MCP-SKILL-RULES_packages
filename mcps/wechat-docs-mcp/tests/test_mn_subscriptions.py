from __future__ import annotations

from pathlib import Path

import pytest

from wechat_docs_mcp.ledger import EventLedger, LedgerError


@pytest.fixture()
def mn_ledger(tmp_path: Path) -> EventLedger:
    ledger = EventLedger(tmp_path / "events.sqlite3")
    ledger.register_route(
        "route-shared",
        profile="human_group",
        identity={
            "owner_account_key": "owner-test",
            "username": "room-test",
            "chat_type": "group",
            "chat_name": "sanitized",
        },
        owner_account_key="owner-test",
        username="room-test",
        chat_type="group",
        display_title="sanitized",
        state="active",
    )
    ledger.register_subscription(
        "route-shared", "conversation-a", 1, subscription_id="subscription-a"
    )
    ledger.register_subscription(
        "route-shared", "conversation-b", 1, subscription_id="subscription-b"
    )
    return ledger


def test_event_fans_out_once_and_ack_is_isolated(mn_ledger: EventLedger) -> None:
    event = mn_ledger.ingest_event("route-shared", "fp-1", "text", {"text": "one"})
    assert event["delivery_count"] == 2
    assert {wake["subscription_id"] for wake in event["wakes"]} == {
        "subscription-a",
        "subscription-b",
    }
    wake_a = mn_ledger.get_active_wake("subscription-a")
    wake_b = mn_ledger.get_active_wake("subscription-b")
    result = mn_ledger.ack(
        "subscription-a", 1, wake_a["wake_id"], [event["event_id"]]
    )
    assert result["pending_count"] == 0
    assert mn_ledger.list_pending("subscription-a") == []
    assert [item["event_id"] for item in mn_ledger.list_pending("subscription-b")] == [
        event["event_id"]
    ]
    assert mn_ledger.get_active_wake("subscription-b")["wake_id"] == wake_b["wake_id"]


def test_duplicate_event_does_not_duplicate_deliveries(mn_ledger: EventLedger) -> None:
    first = mn_ledger.ingest_event("route-shared", "same", "text", {"text": "one"})
    duplicate = mn_ledger.ingest_event("route-shared", "same", "text", {"text": "one"})
    assert duplicate["inserted"] is False
    assert duplicate["event_id"] == first["event_id"]
    assert len(mn_ledger.list_pending("subscription-a")) == 1
    assert len(mn_ledger.list_pending("subscription-b")) == 1


def test_new_subscription_uses_current_baseline_without_replay(mn_ledger: EventLedger) -> None:
    old = mn_ledger.ingest_event("route-shared", "old", "text", {"text": "old"})
    created = mn_ledger.register_subscription(
        "route-shared", "conversation-c", 1, subscription_id="subscription-c"
    )
    assert created["baseline_event_seq"] == old["event_seq"]
    assert mn_ledger.list_pending("subscription-c") == []
    new = mn_ledger.ingest_event("route-shared", "new", "text", {"text": "new"})
    assert [item["event_id"] for item in mn_ledger.list_pending("subscription-c")] == [
        new["event_id"]
    ]


def test_paused_subscription_does_not_receive_new_delivery(mn_ledger: EventLedger) -> None:
    mn_ledger.set_subscription_state("subscription-b", 1, "paused")
    event = mn_ledger.ingest_event("route-shared", "paused", "text", {"text": "only-a"})
    assert [item["event_id"] for item in mn_ledger.list_pending("subscription-a")] == [
        event["event_id"]
    ]
    assert mn_ledger.list_pending("subscription-b") == []
    mn_ledger.set_subscription_state("subscription-b", 1, "active")
    assert mn_ledger.list_pending("subscription-b") == []


def test_route_compatibility_refuses_ambiguous_subscription(mn_ledger: EventLedger) -> None:
    mn_ledger.ingest_event("route-shared", "ambiguous", "text", {"text": "one"})
    with pytest.raises(LedgerError) as raised:
        mn_ledger.list_pending("route-shared")
    assert raised.value.code == "AMBIGUOUS_SUBSCRIPTION"


def test_generation_and_session_tuple_are_enforced(mn_ledger: EventLedger) -> None:
    with pytest.raises(LedgerError) as duplicate:
        mn_ledger.register_subscription("route-shared", "conversation-a", 1)
    assert duplicate.value.code == "SUBSCRIPTION_CONFLICT"
    event = mn_ledger.ingest_event("route-shared", "generation", "text", {"text": "one"})
    wake = mn_ledger.get_active_wake("subscription-a")
    with pytest.raises(LedgerError) as stale:
        mn_ledger.ack("subscription-a", 2, wake["wake_id"], [event["event_id"]])
    assert stale.value.code == "STALE_GENERATION"


def test_close_refuses_to_strand_pending_delivery(mn_ledger: EventLedger) -> None:
    event = mn_ledger.ingest_event("route-shared", "close-pending", "text", {"text": "one"})
    wake = mn_ledger.get_active_wake("subscription-a")
    with pytest.raises(LedgerError) as pending:
        mn_ledger.set_subscription_state("subscription-a", 1, "closed")
    assert pending.value.code == "SUBSCRIPTION_HAS_PENDING"
    mn_ledger.ack("subscription-a", 1, wake["wake_id"], [event["event_id"]])
    closed = mn_ledger.set_subscription_state("subscription-a", 1, "closed")
    assert closed["state"] == "closed"
