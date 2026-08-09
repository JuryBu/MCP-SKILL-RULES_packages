from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Sequence


class LedgerError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def payload_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


class EventLedger:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        connection = self._connect()
        try:
            connection.executescript(
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
                CREATE INDEX IF NOT EXISTS events_pending_idx
                  ON events(route_id, observed_at) WHERE acked_at IS NULL;
                CREATE TABLE IF NOT EXISTS wakes(
                  wake_id TEXT PRIMARY KEY,
                  route_id TEXT NOT NULL REFERENCES routes(route_id),
                  generation INTEGER NOT NULL,
                  created_at TEXT NOT NULL,
                  client_user_message_id TEXT NOT NULL,
                  state TEXT NOT NULL CHECK(state IN ('prepared','submitted','unknown','closed','failed'))
                );
                CREATE UNIQUE INDEX IF NOT EXISTS wakes_one_active_per_route
                  ON wakes(route_id) WHERE state IN ('prepared','submitted','unknown');
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
            try:
                connection.execute("ALTER TABLE routes ADD COLUMN baseline_local_id INTEGER NOT NULL DEFAULT 0")
            except sqlite3.OperationalError:
                pass
        finally:
            connection.close()

    def register_route(
        self,
        route_id: str,
        conversation_id: str,
        generation: int,
        profile: str,
        identity: dict[str, Any],
        state: str = "enrolling",
        baseline_local_id: int = 0,
    ) -> dict[str, Any]:
        if generation < 1:
            raise LedgerError("INVALID_GENERATION", "generation 必须大于等于 1")
        now = utc_now()
        with self._transaction() as connection:
            connection.execute(
                "INSERT INTO routes VALUES(?,?,?,?,?,?,?,?,?)",
                (route_id, generation, conversation_id, profile, payload_sha256(identity), state, baseline_local_id, now, now),
            )
        return self.get_route(route_id)

    def get_route(self, route_id: str) -> dict[str, Any]:
        connection = self._connect()
        try:
            row = connection.execute("SELECT * FROM routes WHERE route_id=?", (route_id,)).fetchone()
        finally:
            connection.close()
        if row is None:
            raise LedgerError("ROUTE_NOT_FOUND", f"route 不存在：{route_id}")
        return dict(row)

    def get_baseline(self, route_id: str) -> int:
        """Return the stored baseline_local_id for a route."""
        return self.get_route(route_id)["baseline_local_id"]

    def update_baseline(self, route_id: str, baseline_local_id: int) -> dict[str, Any]:
        """Advance the baseline_local_id for a route.

        The new value must be >= the current value to prevent regression.
        """
        with self._transaction() as connection:
            current = connection.execute(
                "SELECT baseline_local_id FROM routes WHERE route_id=?", (route_id,)
            ).fetchone()
            if current is None:
                raise LedgerError("ROUTE_NOT_FOUND", f"route 不存在：{route_id}")
            if baseline_local_id < current["baseline_local_id"]:
                raise LedgerError("BASELINE_REGRESSION", "baseline 不能回退")
            connection.execute(
                "UPDATE routes SET baseline_local_id=?, updated_at=? WHERE route_id=?",
                (baseline_local_id, utc_now(), route_id),
            )
        return self.get_route(route_id)

    def ingest_event(
        self,
        route_id: str,
        source_fingerprint: str,
        event_type: str,
        payload: dict[str, Any],
        occurred_at: str | None = None,
        sensitivity: str = "normal",
    ) -> dict[str, Any]:
        event_id = str(uuid.uuid4())
        observed_at = utc_now()
        with self._transaction() as connection:
            route = connection.execute("SELECT * FROM routes WHERE route_id=?", (route_id,)).fetchone()
            if route is None or route["state"] != "active":
                raise LedgerError("ROUTE_NOT_ACTIVE", f"route 未处于 active：{route_id}")
            pending_before = connection.execute(
                "SELECT COUNT(*) FROM events WHERE route_id=? AND acked_at IS NULL", (route_id,)
            ).fetchone()[0]
            try:
                connection.execute(
                    "INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,NULL)",
                    (
                        event_id,
                        route_id,
                        route["generation"],
                        source_fingerprint,
                        occurred_at,
                        observed_at,
                        event_type,
                        canonical_json(payload),
                        sensitivity,
                    ),
                )
            except sqlite3.IntegrityError:
                existing = connection.execute(
                    "SELECT event_id FROM events WHERE route_id=? AND source_fingerprint=?",
                    (route_id, source_fingerprint),
                ).fetchone()
                return {"inserted": False, "event_id": existing["event_id"], "wake": None}
            wake = connection.execute(
                "SELECT * FROM wakes WHERE route_id=? AND state IN ('prepared','submitted','unknown')",
                (route_id,),
            ).fetchone()
            if pending_before == 0 and wake is None:
                wake_id = str(uuid.uuid4())
                connection.execute(
                    "INSERT INTO wakes VALUES(?,?,?,?,?,?)",
                    (wake_id, route_id, route["generation"], observed_at, str(uuid.uuid4()), "prepared"),
                )
                wake = connection.execute("SELECT * FROM wakes WHERE wake_id=?", (wake_id,)).fetchone()
            return {"inserted": True, "event_id": event_id, "wake": dict(wake) if wake else None}

    def get_active_wake(self, route_id: str) -> dict[str, Any] | None:
        """Return the current active wake for a route, or None if no wake is active."""
        connection = self._connect()
        try:
            row = connection.execute(
                "SELECT * FROM wakes WHERE route_id=? AND state IN ('prepared','submitted','unknown')",
                (route_id,),
            ).fetchone()
        finally:
            connection.close()
        return dict(row) if row else None

    def list_wakes_for_notification(self, limit: int = 100) -> list[dict[str, Any]]:
        if not 1 <= limit <= 500:
            raise LedgerError("INVALID_LIMIT", "limit 必须在 1 到 500 之间")
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT
                  wakes.*,
                  routes.conversation_id,
                  routes.profile,
                  (
                    SELECT COUNT(*)
                    FROM events
                    WHERE events.route_id=wakes.route_id AND events.acked_at IS NULL
                  ) AS pending_count
                FROM wakes
                JOIN routes ON routes.route_id=wakes.route_id
                WHERE wakes.state IN ('prepared','unknown')
                  AND routes.state='active'
                  AND EXISTS(
                    SELECT 1
                    FROM events
                    WHERE events.route_id=wakes.route_id AND events.acked_at IS NULL
                  )
                ORDER BY wakes.created_at,wakes.wake_id
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        finally:
            connection.close()
        return [dict(row) for row in rows]

    def mark_wake_state(
        self,
        wake_id: str,
        expected_states: Sequence[str],
        next_state: str,
    ) -> dict[str, Any]:
        allowed_states = {"prepared", "submitted", "unknown", "closed", "failed"}
        expected = set(expected_states)
        if not expected or not expected.issubset(allowed_states) or next_state not in allowed_states:
            raise LedgerError("INVALID_WAKE_STATE", "wake state 参数无效")
        with self._transaction() as connection:
            wake = connection.execute("SELECT * FROM wakes WHERE wake_id=?", (wake_id,)).fetchone()
            if wake is None:
                raise LedgerError("WAKE_NOT_FOUND", f"wake 不存在：{wake_id}")
            if wake["state"] not in expected:
                raise LedgerError("WAKE_STATE_CONFLICT", "wake state 已变化")
            connection.execute("UPDATE wakes SET state=? WHERE wake_id=?", (next_state, wake_id))
            updated = connection.execute("SELECT * FROM wakes WHERE wake_id=?", (wake_id,)).fetchone()
        return dict(updated)

    def list_pending(self, route_id: str, limit: int = 100) -> list[dict[str, Any]]:
        if not 1 <= limit <= 500:
            raise LedgerError("INVALID_LIMIT", "limit 必须在 1 到 500 之间")
        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT * FROM events WHERE route_id=? AND acked_at IS NULL ORDER BY observed_at,event_id LIMIT ?",
                (route_id, limit),
            ).fetchall()
        finally:
            connection.close()
        return [{**dict(row), "payload": json.loads(row["payload_json"])} for row in rows]

    def ack(self, route_id: str, generation: int, wake_id: str, event_ids: Sequence[str]) -> dict[str, Any]:
        unique_ids = list(dict.fromkeys(event_ids))
        if not unique_ids:
            raise LedgerError("EMPTY_ACK", "event_ids 不能为空")
        now = utc_now()
        with self._transaction() as connection:
            wake = connection.execute(
                "SELECT * FROM wakes WHERE wake_id=? AND route_id=?", (wake_id, route_id)
            ).fetchone()
            if wake is None or wake["state"] not in {"prepared", "submitted", "unknown"}:
                raise LedgerError("STALE_WAKE", "wake 已失效或不存在")
            if wake["generation"] != generation:
                raise LedgerError("STALE_GENERATION", "generation 与 wake 不一致")
            placeholders = ",".join("?" for _ in unique_ids)
            rows = connection.execute(
                f"SELECT event_id FROM events WHERE route_id=? AND generation=? AND event_id IN ({placeholders})",
                (route_id, generation, *unique_ids),
            ).fetchall()
            found = {row["event_id"] for row in rows}
            if found != set(unique_ids):
                raise LedgerError("ACK_EVENT_MISMATCH", "ACK 包含不存在或不属于当前代次的 event_id")
            connection.executemany(
                "UPDATE events SET acked_at=COALESCE(acked_at,?) WHERE event_id=?",
                [(now, event_id) for event_id in unique_ids],
            )
            pending = connection.execute(
                "SELECT COUNT(*) FROM events WHERE route_id=? AND acked_at IS NULL", (route_id,)
            ).fetchone()[0]
            if pending == 0:
                connection.execute("UPDATE wakes SET state='closed' WHERE wake_id=?", (wake_id,))
        return {"processed_event_ids": unique_ids, "pending_count": pending, "wake_active": pending > 0}

    def prepare_draft(
        self,
        route_id: str,
        kind: str,
        payload: dict[str, Any],
        expires_at: str,
    ) -> dict[str, Any]:
        draft_id = str(uuid.uuid4())
        now = utc_now()
        content_hash = payload_sha256(payload)
        with self._transaction() as connection:
            connection.execute(
                "INSERT INTO drafts VALUES(?,?,?,?,?,?,'prepared',NULL,NULL,?,?)",
                (draft_id, route_id, kind, canonical_json(payload), content_hash, expires_at, now, now),
            )
        return {"draft_id": draft_id, "content_sha256": content_hash, "state": "prepared"}

    def approve_draft(
        self,
        draft_id: str,
        payload: dict[str, Any],
        owner_authorization_refs: Sequence[dict[str, Any]],
        dedupe_key: str,
        called_at: str | None = None,
    ) -> dict[str, Any]:
        if not owner_authorization_refs:
            raise LedgerError("OWNER_AUTH_REQUIRED", "owner_authorization_refs 不能为空")
        call_time = datetime.fromisoformat(called_at or utc_now())
        for reference in owner_authorization_refs:
            required = {"conversation_id", "turn_id", "message_item_id", "role", "authorized_at"}
            if not required.issubset(reference) or reference["role"] != "user":
                raise LedgerError("OWNER_AUTH_INVALID", "授权引用字段不完整或角色不是 user")
            if datetime.fromisoformat(reference["authorized_at"]) >= call_time:
                raise LedgerError("OWNER_AUTH_FUTURE", "授权时间必须早于调用时间")
        now = utc_now()
        with self._transaction() as connection:
            draft = connection.execute("SELECT * FROM drafts WHERE draft_id=?", (draft_id,)).fetchone()
            if draft is None:
                raise LedgerError("DRAFT_NOT_FOUND", "draft 不存在")
            if draft["state"] != "prepared":
                raise LedgerError("DRAFT_STATE_INVALID", f"draft 当前状态为 {draft['state']}")
            if datetime.fromisoformat(draft["expires_at"]) <= call_time:
                raise LedgerError("DRAFT_EXPIRED", "draft 已过期")
            if payload_sha256(payload) != draft["content_sha256"]:
                raise LedgerError("DRAFT_CHANGED", "正文或附件发生变化，旧批准失效")
            try:
                connection.execute(
                    "UPDATE drafts SET state='approved',owner_authorization_refs_json=?,dedupe_key=?,updated_at=? WHERE draft_id=?",
                    (canonical_json(list(owner_authorization_refs)), dedupe_key, now, draft_id),
                )
            except sqlite3.IntegrityError as error:
                raise LedgerError("DEDUPE_KEY_CONFLICT", "dedupe_key 已被使用") from error
        return {"draft_id": draft_id, "state": "approved", "dedupe_key": dedupe_key}

    def get_draft(self, draft_id: str) -> dict[str, Any]:
        connection = self._connect()
        try:
            row = connection.execute("SELECT * FROM drafts WHERE draft_id=?", (draft_id,)).fetchone()
        finally:
            connection.close()
        if row is None:
            raise LedgerError("DRAFT_NOT_FOUND", "draft 不存在")
        result = dict(row)
        result["payload"] = json.loads(result.pop("payload_json"))
        if result["owner_authorization_refs_json"]:
            result["owner_authorization_refs"] = json.loads(result.pop("owner_authorization_refs_json"))
        else:
            result.pop("owner_authorization_refs_json")
            result["owner_authorization_refs"] = []
        return result

    def require_approved_draft(self, draft_id: str, payload: dict[str, Any], dedupe_key: str) -> dict[str, Any]:
        draft = self.get_draft(draft_id)
        if draft["state"] != "approved":
            raise LedgerError("DRAFT_NOT_APPROVED", f"draft 当前状态为 {draft['state']}")
        if draft["dedupe_key"] != dedupe_key:
            raise LedgerError("DEDUPE_KEY_MISMATCH", "dedupe_key 与批准记录不一致")
        if payload_sha256(payload) != draft["content_sha256"]:
            raise LedgerError("DRAFT_CHANGED", "执行参数与批准草稿不一致")
        if not draft["owner_authorization_refs"]:
            raise LedgerError("OWNER_AUTH_REQUIRED", "批准记录缺少 owner_authorization_refs")
        return draft

    def mark_draft_state(self, draft_id: str, expected: str, next_state: str) -> dict[str, Any]:
        allowed = {"prepared", "approved", "client_sent", "chat_observed", "failed"}
        if expected not in allowed or next_state not in allowed:
            raise LedgerError("DRAFT_STATE_INVALID", "draft 状态不在允许集合中")
        with self._transaction() as connection:
            changed = connection.execute(
                "UPDATE drafts SET state=?,updated_at=? WHERE draft_id=? AND state=?",
                (next_state, utc_now(), draft_id, expected),
            ).rowcount
            if changed != 1:
                raise LedgerError("DRAFT_STATE_CONFLICT", f"draft 不是预期状态 {expected}")
        return self.get_draft(draft_id)
