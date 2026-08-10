from __future__ import annotations

import sqlite3
from pathlib import Path

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
    assert ledger.schema_info()["schema_version"] == 2
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
        "schema_version": 2,
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
