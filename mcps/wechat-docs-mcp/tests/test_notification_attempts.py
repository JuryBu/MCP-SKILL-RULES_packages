from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from wechat_docs_mcp.ledger import EventLedger
from wechat_docs_mcp.wake_notifier import CodexWakeNotifier


def make_ledger(tmp_path: Path) -> EventLedger:
    ledger = EventLedger(tmp_path / "events.sqlite3")
    ledger.register_route("route-test", identity={"chat_name": "safe"}, state="active")
    ledger.register_subscription(
        "route-test", "conversation-a", 1, subscription_id="subscription-a"
    )
    return ledger


def submitted_time(ledger: EventLedger, notification_id: str) -> datetime:
    attempt = next(
        item
        for item in ledger.list_notification_attempts("subscription-a")
        if item["notification_id"] == notification_id
    )
    return datetime.fromisoformat(attempt["submitted_at"])


def test_submitted_logical_wake_rearms_only_for_new_events_after_cooldown(tmp_path: Path) -> None:
    ledger = make_ledger(tmp_path)
    first = ledger.ingest_event("route-test", "fp-1", "text", {"visible_text": "one"})
    initial = ledger.list_wakes_for_notification()[0]
    ledger.mark_notification_state(initial["notification_id"], ["prepared"], "submitted")
    submitted_at = submitted_time(ledger, initial["notification_id"])

    second = ledger.ingest_event("route-test", "fp-2", "text", {"visible_text": "two"})
    before_cooldown = (submitted_at + timedelta(seconds=59)).isoformat()
    after_cooldown = (submitted_at + timedelta(seconds=61)).isoformat()
    assert ledger.list_wakes_for_notification(now=before_cooldown) == []

    reminder = ledger.list_wakes_for_notification(now=after_cooldown)[0]
    assert reminder["wake_id"] == first["wake"]["wake_id"]
    assert reminder["notification_id"] != reminder["wake_id"]
    assert reminder["target_event_seq"] == second["event_seq"]
    assert ledger.list_wakes_for_notification(now=after_cooldown)[0]["notification_id"] == reminder[
        "notification_id"
    ]

    ledger.mark_notification_state(reminder["notification_id"], ["prepared"], "submitted")
    assert ledger.list_wakes_for_notification(
        now=(submitted_at + timedelta(hours=1)).isoformat()
    ) == []


def test_unknown_attempt_retries_same_notification_id_after_restart(tmp_path: Path) -> None:
    ledger = make_ledger(tmp_path)
    ledger.ingest_event("route-test", "fp-unknown", "text", {"visible_text": "one"})
    attempt = ledger.list_wakes_for_notification()[0]
    ledger.mark_notification_state(attempt["notification_id"], ["prepared"], "unknown")

    restarted = EventLedger(ledger.path)
    retried = restarted.list_wakes_for_notification()[0]
    assert retried["notification_id"] == attempt["notification_id"]
    assert retried["state"] == "unknown"


def test_claimed_attempt_identity_is_immutable_across_new_event_and_restart(tmp_path: Path) -> None:
    ledger = make_ledger(tmp_path)
    first = ledger.ingest_event("route-test", "fp-claimed-1", "text", {"visible_text": "one"})
    claimed = ledger.list_wakes_for_notification()[0]
    ledger.ingest_event("route-test", "fp-claimed-2", "text", {"visible_text": "two"})

    restarted = EventLedger(ledger.path)
    retried = restarted.list_wakes_for_notification()[0]
    assert retried["notification_id"] == claimed["notification_id"]
    assert retried["target_event_seq"] == first["event_seq"]
    assert retried["notification_created_at"] == claimed["notification_created_at"]

    restarted.mark_notification_state(retried["notification_id"], ["prepared"], "submitted")
    submitted_at = submitted_time(restarted, retried["notification_id"])
    reminder = restarted.list_wakes_for_notification(
        now=(submitted_at + timedelta(seconds=61)).isoformat()
    )[0]
    assert reminder["notification_id"] != claimed["notification_id"]
    assert reminder["target_event_seq"] > claimed["target_event_seq"]


def test_multiple_events_and_mn_subscriptions_keep_independent_attempts(tmp_path: Path) -> None:
    ledger = make_ledger(tmp_path)
    ledger.register_subscription(
        "route-test", "conversation-b", 1, subscription_id="subscription-b"
    )
    first = ledger.ingest_event("route-test", "fp-a", "text", {"visible_text": "one"})
    second = ledger.ingest_event("route-test", "fp-b", "text", {"visible_text": "two"})
    candidates = ledger.list_wakes_for_notification()
    assert {item["subscription_id"] for item in candidates} == {
        "subscription-a",
        "subscription-b",
    }
    assert {item["target_event_seq"] for item in candidates} == {second["event_seq"]}

    candidate_a = next(item for item in candidates if item["subscription_id"] == "subscription-a")
    ledger.mark_notification_state(candidate_a["notification_id"], ["prepared"], "submitted")
    remaining = ledger.list_wakes_for_notification()
    assert [item["subscription_id"] for item in remaining] == ["subscription-b"]

    ack = ledger.ack(
        "subscription-a", 1, candidate_a["wake_id"], [second["event_id"]]
    )
    assert ack["pending_count"] == 1
    assert ledger.get_active_wake("subscription-a")["wake_id"] == candidate_a["wake_id"]
    assert len(ledger.list_pending("subscription-b")) == 2


def test_notifier_uses_attempt_id_but_prompt_keeps_logical_wake_id(tmp_path: Path) -> None:
    ledger = make_ledger(tmp_path)
    first = ledger.ingest_event("route-test", "fp-1", "text", {"visible_text": "one"})
    initial = ledger.list_wakes_for_notification()[0]
    ledger.mark_notification_state(initial["notification_id"], ["prepared"], "submitted")
    submitted_at = submitted_time(ledger, initial["notification_id"])
    ledger.ingest_event("route-test", "fp-2", "text", {"visible_text": "two"})
    reminder = ledger.list_wakes_for_notification(
        now=(submitted_at + timedelta(seconds=61)).isoformat()
    )[0]
    runtime = tmp_path / "runtime.json"
    token = tmp_path / "token.txt"
    runtime.write_text(json.dumps({"controlUrl": "http://127.0.0.1:1"}), encoding="utf-8")
    token.write_text("safe", encoding="utf-8")
    notifier = CodexWakeNotifier(
        ledger,
        runtime,
        token,
        "local",
        "local",
        client=httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200))),
    )
    body = notifier._request_body(reminder)
    assert body["wakeId"] == reminder["notification_id"]
    assert f"wake_id={first['wake']['wake_id']}" in body["prompt"]
    assert f"notification_id={reminder['notification_id']}" in body["prompt"]
    assert body["pendingThroughSequence"] == reminder["target_event_seq"]
    assert body["pendingThroughTime"] == reminder["notification_created_at"]


def test_v4_submitted_wake_migration_preserves_logical_wake_and_rearms(tmp_path: Path) -> None:
    ledger = make_ledger(tmp_path)
    first = ledger.ingest_event("route-test", "fp-old", "text", {"visible_text": "old"})
    initial = ledger.list_wakes_for_notification()[0]
    ledger.mark_notification_state(initial["notification_id"], ["prepared"], "submitted")
    base = datetime(2026, 8, 20, tzinfo=timezone.utc)
    later = base + timedelta(minutes=5)
    connection = sqlite3.connect(ledger.path)
    try:
        connection.execute(
            "UPDATE subscription_wakes SET created_at=? WHERE wake_id=?",
            (base.isoformat(), first["wake"]["wake_id"]),
        )
        event_seq = connection.execute("SELECT MAX(event_seq)+1 FROM events").fetchone()[0]
        connection.execute(
            "INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (
                "event-new",
                "route-test",
                1,
                "fp-new",
                None,
                later.isoformat(),
                "text",
                "{}",
                "normal",
                None,
                event_seq,
            ),
        )
        connection.execute(
            "INSERT INTO event_deliveries VALUES(?,?, 'PENDING', ?, NULL)",
            ("subscription-a", "event-new", later.isoformat()),
        )
        connection.execute("DROP TABLE subscription_notification_attempts")
        connection.execute("UPDATE schema_meta SET value='4' WHERE key='schema_version'")
        connection.commit()
    finally:
        connection.close()

    migrated = EventLedger(ledger.path)
    assert migrated.schema_info()["schema_version"] == 5
    assert ".v4-backup." in Path(migrated.migration["backup_path"]).name
    attempts = migrated.list_notification_attempts("subscription-a")
    assert attempts[0]["notification_id"] == first["wake"]["wake_id"]
    assert attempts[0]["target_event_seq"] == first["event_seq"]
    reminder = migrated.list_wakes_for_notification(
        now=(later + timedelta(minutes=2)).isoformat()
    )[0]
    assert reminder["wake_id"] == first["wake"]["wake_id"]
    assert reminder["target_event_seq"] == event_seq
