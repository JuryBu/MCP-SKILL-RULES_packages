from __future__ import annotations

import sqlite3
from pathlib import Path
from unittest.mock import patch

import pytest

from ops.release_probe import ledger_state
from wechat_docs_mcp import schema
from wechat_docs_mcp.ledger import EventLedger


def _create_v1_database(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE routes(
          route_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,conversation_id TEXT NOT NULL,
          profile TEXT NOT NULL,identity_sha256 TEXT NOT NULL,state TEXT NOT NULL,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,baseline_local_id INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE events(
          event_id TEXT PRIMARY KEY,route_id TEXT NOT NULL,generation INTEGER NOT NULL,
          source_fingerprint TEXT NOT NULL,occurred_at TEXT,observed_at TEXT NOT NULL,
          event_type TEXT NOT NULL,payload_json TEXT NOT NULL,sensitivity TEXT NOT NULL,
          acked_at TEXT,UNIQUE(route_id,source_fingerprint)
        );
        CREATE TABLE wakes(
          wake_id TEXT PRIMARY KEY,route_id TEXT NOT NULL,generation INTEGER NOT NULL,
          created_at TEXT NOT NULL,client_user_message_id TEXT NOT NULL,state TEXT NOT NULL
        );
        CREATE TABLE drafts(
          draft_id TEXT PRIMARY KEY,route_id TEXT NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,
          content_sha256 TEXT NOT NULL,expires_at TEXT NOT NULL,state TEXT NOT NULL,
          owner_authorization_refs_json TEXT,dedupe_key TEXT UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
        );
        CREATE TABLE deliveries(
          delivery_id TEXT PRIMARY KEY,origin_transport TEXT NOT NULL,dedupe_key TEXT NOT NULL,
          trace_id TEXT NOT NULL,hop_count INTEGER NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,
          UNIQUE(origin_transport,dedupe_key)
        );
        INSERT INTO routes VALUES('route-v1',3,'conversation-v1','human','identity','active','2026-08-09T00:00:00+00:00','2026-08-09T00:00:00+00:00',42);
        INSERT INTO events VALUES('event-acked','route-v1',3,'fp-1',NULL,'2026-08-09T00:01:00+00:00','text','{}','normal','2026-08-09T00:02:00+00:00');
        INSERT INTO events VALUES('event-pending','route-v1',3,'fp-2',NULL,'2026-08-09T00:03:00+00:00','text','{}','normal',NULL);
        INSERT INTO wakes VALUES('wake-v1','route-v1',3,'2026-08-09T00:03:00+00:00','client-v1','prepared');
        INSERT INTO drafts VALUES('draft-v1','route-v1','wechat_text','{}','hash','2099-08-09T00:00:00+00:00','approved','[]','dedupe-v1','2026-08-09T00:00:00+00:00','2026-08-09T00:00:00+00:00');
        """
    )
    connection.close()


def test_v1_migrates_with_backup_and_independent_delivery(tmp_path: Path) -> None:
    database = tmp_path / "events.sqlite3"
    _create_v1_database(database)
    ledger = EventLedger(database)
    assert ledger.schema_info()["schema_version"] == 6
    assert ledger.migration["migrated"] is True
    backup = Path(ledger.migration["backup_path"])
    assert backup.is_file()
    subscription = ledger.list_subscriptions(route_id="route-v1")[0]
    assert subscription["conversation_id"] == "conversation-v1"
    assert subscription["generation"] == 3
    assert [item["event_id"] for item in ledger.list_pending(subscription["subscription_id"])] == [
        "event-pending"
    ]
    assert ledger.get_active_wake(subscription["subscription_id"])["wake_id"] == "wake-v1"
    migrated_draft = ledger.get_draft("draft-v1")
    assert migrated_draft["state"] == "APPROVED"
    assert migrated_draft["subscription_id"] == subscription["subscription_id"]

    connection = sqlite3.connect(database)
    try:
        states = dict(
            connection.execute(
                "SELECT event_id,state FROM event_deliveries WHERE subscription_id=?",
                (subscription["subscription_id"],),
            )
        )
        assert states == {"event-acked": "ACKED", "event-pending": "PENDING"}
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        connection.close()

    connection = sqlite3.connect(database)
    try:
        migrated_at = connection.execute(
            "SELECT value FROM schema_meta WHERE key='migrated_at'"
        ).fetchone()[0]
    finally:
        connection.close()
        reopened = EventLedger(database)
        assert reopened.migration == {
            "schema_version": 6,
            "backup_path": None,
            "migrated": False,
        }
    connection = sqlite3.connect(database)
    try:
        assert connection.execute(
            "SELECT value FROM schema_meta WHERE key='migrated_at'"
        ).fetchone()[0] == migrated_at
    finally:
        connection.close()

    restored = tmp_path / "restored-v1.sqlite3"
    source = sqlite3.connect(backup)
    target = sqlite3.connect(restored)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()
    rollback = sqlite3.connect(restored)
    try:
        tables = {row[0] for row in rollback.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "subscriptions" not in tables
        assert rollback.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 2
        assert rollback.execute("SELECT COUNT(*) FROM wakes").fetchone()[0] == 1
    finally:
        rollback.close()


def test_incomplete_v2_adds_single_use_verification_table_with_backup(tmp_path: Path) -> None:
    database = tmp_path / "events.sqlite3"
    ledger = EventLedger(database)
    ledger.register_route("route-v2", identity={"chat_name": "synthetic"}, state="active")
    connection = sqlite3.connect(database)
    try:
        connection.execute("DROP TABLE outbound_verifications")
        connection.commit()
    finally:
        connection.close()

    repaired = EventLedger(database)
    backup = Path(repaired.migration["backup_path"])
    assert repaired.migration["migrated"] is True
    assert backup.is_file()
    assert repaired.get_route("route-v2")["route_id"] == "route-v2"
    connection = sqlite3.connect(database)
    try:
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "outbound_verifications" in tables
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        connection.close()


def test_v2_to_v3_preserves_existing_rows_and_creates_v2_backup(tmp_path: Path) -> None:
    database = tmp_path / "events.sqlite3"
    ledger = EventLedger(database)
    ledger.register_route("route-preserved", identity={"chat_name": "synthetic"}, state="active")
    connection = sqlite3.connect(database)
    try:
        for table in (
            "tdocs_subscription_wakes",
            "tdocs_batch_deliveries",
            "tdocs_monitor_changes",
            "tdocs_monitor_batches",
            "tdocs_monitor_subscriptions",
            "tdocs_monitors",
        ):
            connection.execute(f"DROP TABLE {table}")
        connection.execute(
            "UPDATE schema_meta SET value='2' WHERE key='schema_version'"
        )
        connection.commit()
    finally:
        connection.close()

    migrated = EventLedger(database)
    backup = Path(migrated.migration["backup_path"])

    assert migrated.schema_info()["schema_version"] == 6
    assert migrated.get_route("route-preserved")["route_id"] == "route-preserved"
    assert ".v2-backup." in backup.name
    assert backup.is_file()


def test_v2_to_v3_failure_rolls_back_partial_schema_and_keeps_backup(tmp_path: Path) -> None:
    database = tmp_path / "events.sqlite3"
    ledger = EventLedger(database)
    ledger.register_route("route-preserved", identity={"chat_name": "synthetic"}, state="active")
    connection = sqlite3.connect(database)
    try:
        for table in (
            "tdocs_subscription_wakes",
            "tdocs_batch_deliveries",
            "tdocs_monitor_changes",
            "tdocs_monitor_batches",
            "tdocs_monitor_subscriptions",
            "tdocs_monitors",
        ):
            connection.execute(f"DROP TABLE {table}")
        connection.execute("UPDATE schema_meta SET value='2' WHERE key='schema_version'")
        connection.commit()
    finally:
        connection.close()

    original_create = schema._create_v3_tables

    def fail_after_create(connection: sqlite3.Connection) -> None:
        original_create(connection)
        raise RuntimeError("synthetic migration failure")

    with patch.object(schema, "_create_v3_tables", side_effect=fail_after_create):
        with pytest.raises(RuntimeError, match="synthetic migration failure"):
            schema.ensure_schema(database)

    connection = sqlite3.connect(database)
    try:
        tables = {
            row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "tdocs_monitors" not in tables
        assert connection.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()[0] == "2"
        assert connection.execute("SELECT COUNT(*) FROM routes").fetchone()[0] == 1
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        connection.close()
    backups = list(tmp_path.glob("events.v2-backup.*.sqlite3"))
    assert len(backups) == 1


def test_v4_to_v5_failure_rolls_back_attempt_table_and_keeps_backup(tmp_path: Path) -> None:
    database = tmp_path / "events.sqlite3"
    ledger = EventLedger(database)
    ledger.register_route("route-preserved", identity={"chat_name": "safe"}, state="active")
    ledger.register_subscription(
        "route-preserved", "conversation-preserved", 1, subscription_id="subscription-preserved"
    )
    event = ledger.ingest_event("route-preserved", "fp-preserved", "text", {"text": "safe"})
    connection = sqlite3.connect(database)
    try:
        connection.execute("DROP TABLE subscription_notification_attempts")
        connection.execute("UPDATE schema_meta SET value='4' WHERE key='schema_version'")
        connection.commit()
    finally:
        connection.close()

    original_create = schema._create_v5_tables

    def fail_after_create(connection: sqlite3.Connection) -> None:
        original_create(connection)
        raise RuntimeError("synthetic v5 migration failure")

    with patch.object(schema, "_create_v5_tables", side_effect=fail_after_create):
        with pytest.raises(RuntimeError, match="synthetic v5 migration failure"):
            schema.ensure_schema(database)

    connection = sqlite3.connect(database)
    try:
        tables = {
            row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "subscription_notification_attempts" not in tables
        assert connection.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()[0] == "4"
        assert connection.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM event_deliveries").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM subscription_wakes").fetchone()[0] == 1
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        connection.close()
    assert event["event_id"]
    assert len(list(tmp_path.glob("events.v4-backup.*.sqlite3"))) == 1


def test_v5_to_v6_defaults_context_read_capability_with_backup_and_idempotence(tmp_path: Path) -> None:
    database = tmp_path / "events.sqlite3"
    ledger = EventLedger(database)
    ledger.register_route("route-v5", identity={"chat_name": "safe"}, state="active")
    ledger.register_subscription(
        "route-v5", "conversation-v5", 1, subscription_id="subscription-v5"
    )
    connection = sqlite3.connect(database)
    try:
        connection.execute("ALTER TABLE subscriptions DROP COLUMN context_read_capability")
        connection.execute("UPDATE schema_meta SET value='5' WHERE key='schema_version'")
        connection.commit()
    finally:
        connection.close()
    before = ledger_state(database, "route-v5")

    migrated = EventLedger(database)
    after = ledger_state(database, "route-v5")

    assert migrated.migration["schema_version"] == 6
    assert migrated.migration["migrated"] is True
    backup = Path(migrated.migration["backup_path"])
    assert backup.is_file()
    assert ".v5-backup." in backup.name
    assert migrated.get_subscription("subscription-v5")["context_read_capability"] == 0
    assert before["schema_version"] == 5
    assert after["schema_version"] == 6
    assert before["business_state_sha256"] == after["business_state_sha256"]

    reopened = EventLedger(database)

    assert reopened.migration == {
        "schema_version": 6,
        "backup_path": None,
        "migrated": False,
    }


def test_v5_to_v6_failure_rolls_back_context_column_and_keeps_backup(tmp_path: Path) -> None:
    database = tmp_path / "events.sqlite3"
    ledger = EventLedger(database)
    ledger.register_route("route-preserved", identity={"chat_name": "safe"}, state="active")
    ledger.register_subscription(
        "route-preserved", "conversation-preserved", 1, subscription_id="subscription-preserved"
    )
    connection = sqlite3.connect(database)
    try:
        connection.execute("ALTER TABLE subscriptions DROP COLUMN context_read_capability")
        connection.execute("UPDATE schema_meta SET value='5' WHERE key='schema_version'")
        connection.commit()
    finally:
        connection.close()

    original_create = schema._create_v6_tables

    def fail_after_create(connection: sqlite3.Connection) -> None:
        original_create(connection)
        raise RuntimeError("synthetic v6 migration failure")

    with patch.object(schema, "_create_v6_tables", side_effect=fail_after_create):
        with pytest.raises(RuntimeError, match="synthetic v6 migration failure"):
            schema.ensure_schema(database)

    connection = sqlite3.connect(database)
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(subscriptions)")}
        assert "context_read_capability" not in columns
        assert connection.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()[0] == "5"
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        connection.close()
    assert len(list(tmp_path.glob("events.v5-backup.*.sqlite3"))) == 1
