from __future__ import annotations

import json
import secrets
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path


SCHEMA_VERSION = 5
LEGACY_SUBSCRIPTION_NAMESPACE = uuid.UUID("0f2926e1-71c8-4b22-92f7-4ef81461bdf8")
REQUIRED_V2_TABLES = {
    "schema_meta",
    "subscriptions",
    "event_deliveries",
    "subscription_wakes",
    "outbound_drafts",
    "outbound_verifications",
    "attachment_transfers",
    "document_change_batches",
    "document_change_items",
}
REQUIRED_V3_TABLES = REQUIRED_V2_TABLES | {
    "tdocs_monitors",
    "tdocs_monitor_subscriptions",
    "tdocs_monitor_batches",
    "tdocs_monitor_changes",
    "tdocs_batch_deliveries",
    "tdocs_subscription_wakes",
}
REQUIRED_V4_TABLES = REQUIRED_V3_TABLES | {"attachments", "outbound_attachment_verifications"}
REQUIRED_V5_TABLES = REQUIRED_V4_TABLES | {"subscription_notification_attempts"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    return row is not None


def _column_names(connection: sqlite3.Connection, table: str) -> set[str]:
    if not _table_exists(connection, table):
        return set()
    return {row[1] for row in connection.execute(f"PRAGMA table_info([{table}])")}


def _add_column(connection: sqlite3.Connection, table: str, definition: str) -> None:
    name = definition.split()[0]
    if name not in _column_names(connection, table):
        connection.execute(f"ALTER TABLE [{table}] ADD COLUMN {definition}")


def _execute_script(connection: sqlite3.Connection, script: str) -> None:
    statement = ""
    for line in script.splitlines():
        statement += f"{line}\n"
        if sqlite3.complete_statement(statement):
            connection.execute(statement)
            statement = ""
    if statement.strip():
        raise sqlite3.OperationalError("incomplete schema statement")


def _is_current_schema(path: Path) -> bool:
    if not path.exists() or path.stat().st_size == 0:
        return False
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if not REQUIRED_V5_TABLES.issubset(tables):
            return False
        version = connection.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()
        return version is not None and int(version[0]) == SCHEMA_VERSION
    except (sqlite3.DatabaseError, TypeError, ValueError):
        return False
    finally:
        connection.close()


def _detected_schema_version(path: Path) -> int:
    if not path.exists() or path.stat().st_size == 0:
        return 0
    connection = sqlite3.connect(path)
    try:
        if _table_exists(connection, "schema_meta"):
            row = connection.execute(
                "SELECT value FROM schema_meta WHERE key='schema_version'"
            ).fetchone()
            if row is not None:
                return int(row[0])
        return 1 if _table_exists(connection, "routes") else 0
    except (sqlite3.DatabaseError, TypeError, ValueError):
        return 0
    finally:
        connection.close()


def _backup_legacy_database(path: Path) -> Path | None:
    if not path.exists() or path.stat().st_size == 0:
        return None
    source = sqlite3.connect(path)
    try:
        if not _table_exists(source, "routes"):
            return None
        previous_version = _detected_schema_version(path)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = path.with_name(
            f"{path.stem}.v{previous_version}-backup.{timestamp}{path.suffix}"
        )
        suffix = 1
        while backup.exists():
            backup = path.with_name(
                f"{path.stem}.v{previous_version}-backup.{timestamp}.{suffix}{path.suffix}"
            )
            suffix += 1
        target = sqlite3.connect(backup)
        try:
            source.backup(target)
        finally:
            target.close()
        return backup
    finally:
        source.close()


def _create_v1_tables(connection: sqlite3.Connection) -> None:
    _execute_script(
        connection,
        """
        CREATE TABLE IF NOT EXISTS routes(
          route_id TEXT PRIMARY KEY,
          generation INTEGER NOT NULL CHECK(generation >= 1),
          conversation_id TEXT NOT NULL,
          profile TEXT NOT NULL,
          identity_sha256 TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('enrolling','active','quarantine','disabled')),
          baseline_local_id INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events(
          event_id TEXT PRIMARY KEY,
          route_id TEXT NOT NULL REFERENCES routes(route_id),
          generation INTEGER NOT NULL,
          source_fingerprint TEXT NOT NULL,
          occurred_at TEXT,
          observed_at TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          sensitivity TEXT NOT NULL,
          acked_at TEXT,
          UNIQUE(route_id, source_fingerprint)
        );
        CREATE TABLE IF NOT EXISTS wakes(
          wake_id TEXT PRIMARY KEY,
          route_id TEXT NOT NULL REFERENCES routes(route_id),
          generation INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          client_user_message_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','submitted','unknown','closed','failed'))
        );
        CREATE TABLE IF NOT EXISTS drafts(
          draft_id TEXT PRIMARY KEY,
          route_id TEXT NOT NULL REFERENCES routes(route_id),
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          content_sha256 TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','approved','client_sent','chat_observed','failed')),
          owner_authorization_refs_json TEXT,
          dedupe_key TEXT UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deliveries(
          delivery_id TEXT PRIMARY KEY,
          origin_transport TEXT NOT NULL,
          dedupe_key TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          hop_count INTEGER NOT NULL CHECK(hop_count >= 0),
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(origin_transport, dedupe_key)
        );
        """
    )
    _add_column(connection, "routes", "baseline_local_id INTEGER NOT NULL DEFAULT 0")


def _create_v2_tables(connection: sqlite3.Connection) -> None:
    for definition in (
        "identity_version INTEGER NOT NULL DEFAULT 1",
        "owner_account_key_sha256 TEXT",
        "username_sha256 TEXT",
        "chat_type TEXT",
        "display_title TEXT",
    ):
        _add_column(connection, "routes", definition)
    _add_column(connection, "events", "event_seq INTEGER")

    rows = connection.execute(
        "SELECT rowid,event_id FROM events WHERE event_seq IS NULL ORDER BY rowid"
    ).fetchall()
    next_sequence = connection.execute("SELECT COALESCE(MAX(event_seq),0) FROM events").fetchone()[0]
    for row in rows:
        next_sequence += 1
        connection.execute("UPDATE events SET event_seq=? WHERE event_id=?", (next_sequence, row[1]))

    _execute_script(
        connection,
        """
        CREATE TABLE IF NOT EXISTS schema_meta(
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS events_event_seq_unique
          ON events(event_seq) WHERE event_seq IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS routes_precise_identity_unique
          ON routes(owner_account_key_sha256,username_sha256,chat_type)
          WHERE owner_account_key_sha256 IS NOT NULL
            AND username_sha256 IS NOT NULL
            AND chat_type IS NOT NULL;
        CREATE TABLE IF NOT EXISTS subscriptions(
          subscription_id TEXT PRIMARY KEY,
          route_id TEXT NOT NULL REFERENCES routes(route_id),
          conversation_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK(generation >= 1),
          state TEXT NOT NULL CHECK(state IN ('active','paused','closed')),
          baseline_event_seq INTEGER NOT NULL DEFAULT 0,
          cursor_event_seq INTEGER NOT NULL DEFAULT 0,
          listen_capability INTEGER NOT NULL DEFAULT 1 CHECK(listen_capability IN (0,1)),
          send_capability INTEGER NOT NULL DEFAULT 0 CHECK(send_capability IN (0,1)),
          policy_ref TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(route_id,conversation_id,generation)
        );
        CREATE INDEX IF NOT EXISTS subscriptions_route_state_idx
          ON subscriptions(route_id,state);
        CREATE TABLE IF NOT EXISTS event_deliveries(
          subscription_id TEXT NOT NULL REFERENCES subscriptions(subscription_id),
          event_id TEXT NOT NULL REFERENCES events(event_id),
          state TEXT NOT NULL CHECK(state IN ('PENDING','ACKED')),
          delivered_at TEXT NOT NULL,
          acked_at TEXT,
          PRIMARY KEY(subscription_id,event_id)
        );
        CREATE INDEX IF NOT EXISTS event_deliveries_pending_idx
          ON event_deliveries(subscription_id,delivered_at) WHERE state='PENDING';
        CREATE TABLE IF NOT EXISTS subscription_wakes(
          wake_id TEXT PRIMARY KEY,
          subscription_id TEXT NOT NULL REFERENCES subscriptions(subscription_id),
          generation INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          client_user_message_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','submitted','unknown','closed','failed'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS subscription_wakes_one_active
          ON subscription_wakes(subscription_id)
          WHERE state IN ('prepared','submitted','unknown');
        CREATE TABLE IF NOT EXISTS outbound_drafts(
          draft_id TEXT PRIMARY KEY,
          subscription_id TEXT REFERENCES subscriptions(subscription_id),
          route_id TEXT NOT NULL REFERENCES routes(route_id),
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          content_sha256 TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('PREPARED','APPROVED','EXECUTING','SEND_ATTEMPTED','VERIFIED','FAILED','UNKNOWN')),
          owner_authorization_refs_json TEXT,
          dedupe_key TEXT UNIQUE,
          approval_consumed_at TEXT,
          execution_id TEXT UNIQUE,
          lease_scope TEXT,
          lease_expires_at TEXT,
          result_json TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS outbound_one_executing_lease
          ON outbound_drafts(lease_scope) WHERE state='EXECUTING';
        CREATE TABLE IF NOT EXISTS outbound_verifications(
          observed_event_id TEXT PRIMARY KEY REFERENCES events(event_id),
          draft_id TEXT NOT NULL UNIQUE REFERENCES outbound_drafts(draft_id),
          verified_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS attachment_transfers(
          transfer_id TEXT PRIMARY KEY,
          direction TEXT NOT NULL CHECK(direction IN ('download','upload')),
          route_id TEXT NOT NULL REFERENCES routes(route_id),
          source_event_id TEXT REFERENCES events(event_id),
          file_name TEXT NOT NULL,
          byte_count INTEGER,
          sha256 TEXT,
          local_path TEXT,
          state TEXT NOT NULL CHECK(state IN ('PREPARED','MATERIALIZED','VERIFIED','FAILED')),
          dedupe_key TEXT UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS document_change_batches(
          batch_id TEXT PRIMARY KEY,
          document_id_hash TEXT NOT NULL,
          document_kind TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('OPEN','READY','EMITTED')),
          first_observed_at TEXT NOT NULL,
          last_observed_at TEXT NOT NULL,
          emit_after TEXT NOT NULL,
          change_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS document_one_open_batch
          ON document_change_batches(document_id_hash,document_kind) WHERE state='OPEN';
        CREATE TABLE IF NOT EXISTS document_change_items(
          batch_id TEXT NOT NULL REFERENCES document_change_batches(batch_id),
          change_fingerprint TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          PRIMARY KEY(batch_id,change_fingerprint)
        );
        """
    )
    _add_column(
        connection,
        "outbound_drafts",
        "subscription_id TEXT REFERENCES subscriptions(subscription_id)",
    )


def _create_v3_tables(connection: sqlite3.Connection) -> None:
    _execute_script(
        connection,
        """
        CREATE TABLE IF NOT EXISTS tdocs_monitors(
          monitor_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          resource_kind TEXT NOT NULL,
          resource_key_sha256 TEXT NOT NULL,
          poll_tool TEXT NOT NULL,
          poll_arguments_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('active','paused','closed')),
          baseline_fingerprint TEXT,
          baseline_summary_json TEXT,
          baseline_observed_at TEXT,
          last_success_at TEXT,
          last_error_code TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          policy_ref TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(provider,resource_kind,resource_key_sha256)
        );
        CREATE INDEX IF NOT EXISTS tdocs_monitors_state_idx
          ON tdocs_monitors(state);
        CREATE TABLE IF NOT EXISTS tdocs_monitor_subscriptions(
          subscription_id TEXT PRIMARY KEY,
          monitor_id TEXT NOT NULL REFERENCES tdocs_monitors(monitor_id),
          conversation_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK(generation >= 1),
          state TEXT NOT NULL CHECK(state IN ('active','paused','closed')),
          baseline_batch_seq INTEGER NOT NULL DEFAULT 0,
          cursor_batch_seq INTEGER NOT NULL DEFAULT 0,
          listen_capability INTEGER NOT NULL DEFAULT 1 CHECK(listen_capability IN (0,1)),
          policy_ref TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(monitor_id,conversation_id,generation)
        );
        CREATE INDEX IF NOT EXISTS tdocs_monitor_subscriptions_state_idx
          ON tdocs_monitor_subscriptions(monitor_id,state);
        CREATE TABLE IF NOT EXISTS tdocs_monitor_batches(
          batch_id TEXT PRIMARY KEY,
          batch_seq INTEGER NOT NULL UNIQUE,
          monitor_id TEXT NOT NULL REFERENCES tdocs_monitors(monitor_id),
          state TEXT NOT NULL CHECK(state IN ('OPEN','READY')),
          first_observed_at TEXT NOT NULL,
          last_observed_at TEXT NOT NULL,
          emit_after TEXT NOT NULL,
          change_count INTEGER NOT NULL DEFAULT 0,
          summary_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS tdocs_monitor_one_open_batch
          ON tdocs_monitor_batches(monitor_id) WHERE state='OPEN';
        CREATE TABLE IF NOT EXISTS tdocs_monitor_changes(
          monitor_id TEXT NOT NULL REFERENCES tdocs_monitors(monitor_id),
          change_fingerprint TEXT NOT NULL,
          batch_id TEXT NOT NULL REFERENCES tdocs_monitor_batches(batch_id),
          observed_at TEXT NOT NULL,
          summary_json TEXT NOT NULL,
          PRIMARY KEY(monitor_id,change_fingerprint)
        );
        CREATE TABLE IF NOT EXISTS tdocs_batch_deliveries(
          subscription_id TEXT NOT NULL REFERENCES tdocs_monitor_subscriptions(subscription_id),
          batch_id TEXT NOT NULL REFERENCES tdocs_monitor_batches(batch_id),
          state TEXT NOT NULL CHECK(state IN ('PENDING','ACKED')),
          delivered_at TEXT NOT NULL,
          acked_at TEXT,
          PRIMARY KEY(subscription_id,batch_id)
        );
        CREATE INDEX IF NOT EXISTS tdocs_batch_deliveries_pending_idx
          ON tdocs_batch_deliveries(subscription_id,delivered_at) WHERE state='PENDING';
        CREATE TABLE IF NOT EXISTS tdocs_subscription_wakes(
          wake_id TEXT PRIMARY KEY,
          subscription_id TEXT NOT NULL REFERENCES tdocs_monitor_subscriptions(subscription_id),
          generation INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          client_user_message_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','submitted','unknown','closed','failed'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS tdocs_subscription_wakes_one_active
          ON tdocs_subscription_wakes(subscription_id)
          WHERE state IN ('prepared','submitted','unknown');
        """,
    )


def _create_v4_tables(connection: sqlite3.Connection) -> None:
    _execute_script(
        connection,
        """
        CREATE TABLE IF NOT EXISTS attachments(
          attachment_ref TEXT PRIMARY KEY,
          event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
          route_id TEXT NOT NULL REFERENCES routes(route_id),
          kind TEXT NOT NULL CHECK(kind IN ('file','image','sticker')),
          local_id INTEGER,
          server_id TEXT,
          file_name TEXT,
          byte_count INTEGER,
          content_md5 TEXT,
          mime_hint TEXT,
          width INTEGER,
          height INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS attachments_route_event
          ON attachments(route_id,event_id);
        CREATE TABLE IF NOT EXISTS outbound_attachment_verifications(
          draft_id TEXT PRIMARY KEY REFERENCES outbound_drafts(draft_id),
          route_id TEXT NOT NULL REFERENCES routes(route_id),
          local_id INTEGER NOT NULL,
          server_id TEXT NOT NULL,
          verified_at TEXT NOT NULL,
          UNIQUE(route_id,local_id,server_id)
        );
        """,
    )
    for definition in (
        "subscription_id TEXT",
        "attachment_ref TEXT",
        "mime_type TEXT",
        "width INTEGER",
        "height INTEGER",
        "source_kind TEXT",
        "result_json TEXT",
        "draft_id TEXT REFERENCES outbound_drafts(draft_id)",
        "content_md5 TEXT",
    ):
        _add_column(connection, "attachment_transfers", definition)


def _create_v5_tables(connection: sqlite3.Connection) -> None:
    _execute_script(
        connection,
        """
        CREATE TABLE IF NOT EXISTS subscription_notification_attempts(
          notification_id TEXT PRIMARY KEY,
          wake_id TEXT NOT NULL REFERENCES subscription_wakes(wake_id),
          subscription_id TEXT NOT NULL REFERENCES subscriptions(subscription_id),
          generation INTEGER NOT NULL,
          target_event_seq INTEGER NOT NULL CHECK(target_event_seq >= 0),
          created_at TEXT NOT NULL,
          submitted_at TEXT,
          state TEXT NOT NULL CHECK(state IN ('prepared','submitted','unknown','closed','failed')),
          UNIQUE(wake_id,target_event_seq)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS subscription_notification_attempts_one_active
          ON subscription_notification_attempts(subscription_id)
          WHERE state IN ('prepared','unknown');
        CREATE INDEX IF NOT EXISTS subscription_notification_attempts_wake
          ON subscription_notification_attempts(wake_id,target_event_seq);
        """,
    )


def _backfill_attachment_refs(connection: sqlite3.Connection) -> None:
    rows = connection.execute(
        """
        SELECT event_id,route_id,event_type,payload_json,observed_at
        FROM events
        WHERE event_type IN ('file','image','sticker')
        ORDER BY event_seq
        """
    ).fetchall()
    for row in rows:
        existing = connection.execute(
            "SELECT attachment_ref FROM attachments WHERE event_id=?",
            (row[0],),
        ).fetchone()
        if existing is not None:
            attachment_ref = existing[0]
        else:
            payload = json.loads(row[3])
            attachment_ref = f"att_{secrets.token_urlsafe(24)}"
            connection.execute(
                """
                INSERT INTO attachments(
                  attachment_ref,event_id,route_id,kind,local_id,server_id,file_name,
                  byte_count,content_md5,mime_hint,width,height,created_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    attachment_ref,
                    row[0],
                    row[1],
                    row[2],
                    payload.get("local_id"),
                    str(payload["server_id"]) if payload.get("server_id") is not None else None,
                    payload.get("attachment_name"),
                    payload.get("attachment_size"),
                    payload.get("attachment_md5"),
                    payload.get("attachment_mime"),
                    payload.get("attachment_width"),
                    payload.get("attachment_height"),
                    row[4],
                ),
            )
        payload = json.loads(row[3])
        if payload.get("attachment_ref") != attachment_ref:
            payload["attachment_ref"] = attachment_ref
            connection.execute(
                "UPDATE events SET payload_json=? WHERE event_id=?",
                (json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")), row[0]),
            )


def _backfill_notification_attempts(connection: sqlite3.Connection) -> None:
    wakes = connection.execute(
        """
        SELECT wake_id,subscription_id,generation,created_at,state
        FROM subscription_wakes
        WHERE state IN ('prepared','submitted','unknown')
        ORDER BY created_at,wake_id
        """
    ).fetchall()
    for wake in wakes:
        wake_id, subscription_id, generation, created_at, wake_state = wake
        if wake_state == "submitted":
            target_event_seq = connection.execute(
                """
                SELECT COALESCE(MAX(events.event_seq),0)
                FROM event_deliveries
                JOIN events USING(event_id)
                WHERE event_deliveries.subscription_id=?
                  AND event_deliveries.delivered_at<=?
                """,
                (subscription_id, created_at),
            ).fetchone()[0]
            if target_event_seq == 0:
                target_event_seq = connection.execute(
                    """
                    SELECT COALESCE(MIN(events.event_seq),0)
                    FROM event_deliveries
                    JOIN events USING(event_id)
                    WHERE event_deliveries.subscription_id=?
                      AND event_deliveries.state='PENDING'
                    """,
                    (subscription_id,),
                ).fetchone()[0]
        else:
            target_event_seq = connection.execute(
                """
                SELECT COALESCE(MAX(events.event_seq),0)
                FROM event_deliveries
                JOIN events USING(event_id)
                WHERE event_deliveries.subscription_id=?
                  AND event_deliveries.state='PENDING'
                """,
                (subscription_id,),
            ).fetchone()[0]
        connection.execute(
            """
            INSERT OR IGNORE INTO subscription_notification_attempts(
              notification_id,wake_id,subscription_id,generation,target_event_seq,
              created_at,submitted_at,state
            ) VALUES(?,?,?,?,?,?,?,?)
            """,
            (
                wake_id,
                wake_id,
                subscription_id,
                generation,
                target_event_seq,
                created_at,
                created_at if wake_state == "submitted" else None,
                wake_state,
            ),
        )


def legacy_subscription_id(route_id: str, conversation_id: str, generation: int) -> str:
    return str(
        uuid.uuid5(
            LEGACY_SUBSCRIPTION_NAMESPACE,
            f"{route_id}\n{conversation_id}\n{generation}",
        )
    )


def _migrate_v1_rows(connection: sqlite3.Connection) -> None:
    now = utc_now()
    max_event_seq = connection.execute("SELECT COALESCE(MAX(event_seq),0) FROM events").fetchone()[0]
    routes = connection.execute(
        "SELECT route_id,conversation_id,generation,state,created_at,updated_at FROM routes"
    ).fetchall()
    for route in routes:
        conversation_id = str(route[1] or "").strip()
        if not conversation_id:
            continue
        subscription_id = legacy_subscription_id(route[0], conversation_id, route[2])
        subscription_state = "active" if route[3] == "active" else "paused"
        connection.execute(
            """
            INSERT OR IGNORE INTO subscriptions(
              subscription_id,route_id,conversation_id,generation,state,
              baseline_event_seq,cursor_event_seq,listen_capability,send_capability,
              policy_ref,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                subscription_id,
                route[0],
                conversation_id,
                route[2],
                subscription_state,
                max_event_seq,
                max_event_seq,
                1,
                0,
                "legacy-v1-migration",
                route[4],
                route[5],
            ),
        )
        connection.execute(
            """
            INSERT OR IGNORE INTO event_deliveries(
              subscription_id,event_id,state,delivered_at,acked_at
            )
            SELECT ?,event_id,
                   CASE WHEN acked_at IS NULL THEN 'PENDING' ELSE 'ACKED' END,
                   observed_at,acked_at
            FROM events WHERE route_id=?
            """,
            (subscription_id, route[0]),
        )
        wakes = connection.execute(
            "SELECT wake_id,generation,created_at,client_user_message_id,state FROM wakes WHERE route_id=?",
            (route[0],),
        ).fetchall()
        for wake in wakes:
            wake_state = wake[4]
            pending = connection.execute(
                "SELECT COUNT(*) FROM event_deliveries WHERE subscription_id=? AND state='PENDING'",
                (subscription_id,),
            ).fetchone()[0]
            if pending == 0 and wake_state in {"prepared", "submitted", "unknown"}:
                wake_state = "closed"
            connection.execute(
                "INSERT OR IGNORE INTO subscription_wakes VALUES(?,?,?,?,?,?)",
                (wake[0], subscription_id, wake[1], wake[2], wake[3], wake_state),
            )
        pending = connection.execute(
            "SELECT COUNT(*) FROM event_deliveries WHERE subscription_id=? AND state='PENDING'",
            (subscription_id,),
        ).fetchone()[0]
        active_wake = connection.execute(
            """
            SELECT 1 FROM subscription_wakes
            WHERE subscription_id=? AND state IN ('prepared','submitted','unknown')
            """,
            (subscription_id,),
        ).fetchone()
        if pending and active_wake is None:
            connection.execute(
                "INSERT INTO subscription_wakes VALUES(?,?,?,?,?,'prepared')",
                (str(uuid.uuid4()), subscription_id, route[2], now, str(uuid.uuid4())),
            )

    state_map = {
        "prepared": "PREPARED",
        "approved": "APPROVED",
        "client_sent": "SEND_ATTEMPTED",
        "chat_observed": "VERIFIED",
        "failed": "FAILED",
    }
    for draft in connection.execute("SELECT * FROM drafts").fetchall():
        subscription_id = None
        if str(draft[2]).startswith("wechat_"):
            subscription = connection.execute(
                """
                SELECT subscription_id FROM subscriptions
                WHERE route_id=? ORDER BY created_at,subscription_id LIMIT 1
                """,
                (draft[1],),
            ).fetchone()
            subscription_id = subscription[0] if subscription is not None else None
        connection.execute(
            """
            INSERT OR IGNORE INTO outbound_drafts(
              draft_id,subscription_id,route_id,kind,payload_json,content_sha256,expires_at,state,
              owner_authorization_refs_json,dedupe_key,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                draft[0],
                subscription_id,
                draft[1],
                draft[2],
                draft[3],
                draft[4],
                draft[5],
                state_map[draft[6]],
                draft[7],
                draft[8],
                draft[9],
                draft[10],
            ),
        )


def ensure_schema(path: str | Path) -> dict[str, str | int | bool | None]:
    database_path = Path(path)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    if _is_current_schema(database_path):
        return {
            "schema_version": SCHEMA_VERSION,
            "backup_path": None,
            "migrated": False,
        }
    backup = _backup_legacy_database(database_path)
    connection = sqlite3.connect(database_path, timeout=30, isolation_level=None)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("BEGIN IMMEDIATE")
        try:
            _create_v1_tables(connection)
            _create_v2_tables(connection)
            _create_v3_tables(connection)
            _create_v4_tables(connection)
            _create_v5_tables(connection)
            _migrate_v1_rows(connection)
            _backfill_attachment_refs(connection)
            _backfill_notification_attempts(connection)
            connection.execute(
                "INSERT INTO schema_meta(key,value) VALUES('schema_version',?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(SCHEMA_VERSION),),
            )
            connection.execute(
                "INSERT INTO schema_meta(key,value) VALUES('migrated_at',?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (utc_now(),),
            )
            if backup is not None:
                connection.execute(
                    "INSERT INTO schema_meta(key,value) VALUES('legacy_backup_name',?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (backup.name,),
                )
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise sqlite3.DatabaseError(f"integrity_check failed: {integrity}")
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
        version = connection.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()[0]
        return {
            "schema_version": int(version),
            "backup_path": str(backup) if backup is not None else None,
            "migrated": backup is not None,
        }
    finally:
        connection.close()
