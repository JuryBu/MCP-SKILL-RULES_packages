from __future__ import annotations

import hashlib
import json
import sqlite3
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Sequence

from .schema import SCHEMA_VERSION, ensure_schema, legacy_subscription_id


ACTIVE_WAKE_STATES = ("prepared", "submitted", "unknown")
OUTBOUND_STATES = {
    "PREPARED",
    "APPROVED",
    "EXECUTING",
    "SEND_ATTEMPTED",
    "VERIFIED",
    "FAILED",
    "UNKNOWN",
}


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


def route_identity_sha256(owner_account_key: str, username: str, chat_type: str) -> str:
    owner_account_key, username, chat_type = normalize_route_identity(
        owner_account_key, username, chat_type
    )
    return payload_sha256(
        {
            "owner_account_key": owner_account_key,
            "username": username,
            "chat_type": chat_type,
        }
    )


def normalize_route_identity(owner_account_key: str, username: str, chat_type: str) -> tuple[str, str, str]:
    return (
        unicodedata.normalize("NFC", owner_account_key.strip()),
        unicodedata.normalize("NFC", username.strip()),
        chat_type.strip().casefold(),
    )


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise LedgerError("TIMEZONE_REQUIRED", "时间必须包含时区")
    return parsed


class EventLedger:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.migration = ensure_schema(self.path)

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

    def schema_info(self) -> dict[str, Any]:
        connection = self._connect()
        try:
            values = {
                row["key"]: row["value"]
                for row in connection.execute("SELECT key,value FROM schema_meta")
            }
        finally:
            connection.close()
        return {
            "schema_version": int(values.get("schema_version", SCHEMA_VERSION)),
            "migrated_at": values.get("migrated_at"),
            "legacy_backup_name": values.get("legacy_backup_name"),
        }

    def backup_to(self, destination: str | Path) -> Path:
        target_path = Path(destination)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        source = sqlite3.connect(self.path)
        try:
            target = sqlite3.connect(target_path)
            try:
                source.backup(target)
            finally:
                target.close()
        finally:
            source.close()
        return target_path

    def register_route(
        self,
        route_id: str,
        conversation_id: str = "",
        generation: int = 1,
        profile: str = "human",
        identity: dict[str, Any] | None = None,
        state: str = "enrolling",
        baseline_local_id: int = 0,
        *,
        owner_account_key: str = "",
        username: str = "",
        chat_type: str = "",
        display_title: str = "",
    ) -> dict[str, Any]:
        if generation < 1:
            raise LedgerError("INVALID_GENERATION", "generation 必须大于等于 1")
        identity = dict(identity or {})
        owner_account_key = owner_account_key or str(
            identity.get("ownerAccountKey") or identity.get("owner_account_key") or ""
        )
        username = username or str(identity.get("username") or "")
        chat_type = chat_type or str(identity.get("chat_type") or "")
        owner_account_key, username, chat_type = normalize_route_identity(
            owner_account_key, username, chat_type
        )
        display_title = display_title or str(identity.get("chat_name") or "")
        precise = bool(owner_account_key and username and chat_type)
        identity_hash = (
            route_identity_sha256(owner_account_key, username, chat_type)
            if precise
            else payload_sha256(identity)
        )
        now = utc_now()
        try:
            with self._transaction() as connection:
                connection.execute(
                    """
                    INSERT INTO routes(
                      route_id,generation,conversation_id,profile,identity_sha256,state,
                      baseline_local_id,created_at,updated_at,identity_version,
                      owner_account_key_sha256,username_sha256,chat_type,display_title
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        route_id,
                        generation,
                        conversation_id,
                        profile,
                        identity_hash,
                        state,
                        baseline_local_id,
                        now,
                        now,
                        2 if precise else 1,
                        hashlib.sha256(owner_account_key.encode("utf-8")).hexdigest() if precise else None,
                        hashlib.sha256(username.encode("utf-8")).hexdigest() if precise else None,
                        chat_type or None,
                        display_title or None,
                    ),
                )
                if conversation_id.strip():
                    current_event_seq = connection.execute(
                        "SELECT COALESCE(MAX(event_seq),0) FROM events"
                    ).fetchone()[0]
                    connection.execute(
                        """
                        INSERT INTO subscriptions(
                          subscription_id,route_id,conversation_id,generation,state,
                          baseline_event_seq,cursor_event_seq,listen_capability,send_capability,
                          policy_ref,created_at,updated_at
                        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        (
                            legacy_subscription_id(route_id, conversation_id, generation),
                            route_id,
                            conversation_id,
                            generation,
                            "active" if state == "active" else "paused",
                            current_event_seq,
                            current_event_seq,
                            1,
                            0,
                            "legacy-register-route",
                            now,
                            now,
                        ),
                    )
        except sqlite3.IntegrityError as error:
            raise LedgerError("ROUTE_IDENTITY_CONFLICT", "route_id 或精确微信身份已登记") from error
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

    def verify_or_upgrade_route_identity(
        self,
        route_id: str,
        legacy_identity: dict[str, Any],
        owner_account_key: str,
        username: str,
        chat_type: str,
        display_title: str = "",
    ) -> dict[str, Any]:
        owner_account_key, username, chat_type = normalize_route_identity(
            owner_account_key, username, chat_type
        )
        if not owner_account_key or not username or chat_type not in {"friend", "group"}:
            raise LedgerError("ROUTE_IDENTITY_INCOMPLETE", "精确 route 身份字段不完整")
        precise_hash = route_identity_sha256(owner_account_key, username, chat_type)
        with self._transaction() as connection:
            route = connection.execute("SELECT * FROM routes WHERE route_id=?", (route_id,)).fetchone()
            if route is None:
                raise LedgerError("ROUTE_NOT_FOUND", f"route 不存在：{route_id}")
            if route["identity_version"] >= 2:
                if route["identity_sha256"] != precise_hash:
                    raise LedgerError("ROUTE_IDENTITY_MISMATCH", "精确 route 身份与已登记指纹不一致")
                return dict(route)
            if route["identity_sha256"] != payload_sha256(legacy_identity):
                connection.execute(
                    "UPDATE routes SET state='quarantine',updated_at=? WHERE route_id=?",
                    (utc_now(), route_id),
                )
                raise LedgerError("ROUTE_IDENTITY_MISMATCH", "旧 route 身份校验失败，已进入 quarantine")
            try:
                connection.execute(
                    """
                    UPDATE routes
                    SET identity_sha256=?,identity_version=2,owner_account_key_sha256=?,
                        username_sha256=?,chat_type=?,display_title=?,updated_at=?
                    WHERE route_id=?
                    """,
                    (
                        precise_hash,
                        hashlib.sha256(owner_account_key.encode("utf-8")).hexdigest(),
                        hashlib.sha256(username.encode("utf-8")).hexdigest(),
                        chat_type,
                        display_title or None,
                        utc_now(),
                        route_id,
                    ),
                )
            except sqlite3.IntegrityError as error:
                raise LedgerError("ROUTE_IDENTITY_CONFLICT", "该精确微信会话已绑定到另一 route") from error
        return self.get_route(route_id)

    def get_baseline(self, route_id: str) -> int:
        return int(self.get_route(route_id)["baseline_local_id"])

    def update_baseline(self, route_id: str, baseline_local_id: int) -> dict[str, Any]:
        with self._transaction() as connection:
            current = connection.execute(
                "SELECT baseline_local_id FROM routes WHERE route_id=?", (route_id,)
            ).fetchone()
            if current is None:
                raise LedgerError("ROUTE_NOT_FOUND", f"route 不存在：{route_id}")
            if baseline_local_id < current["baseline_local_id"]:
                raise LedgerError("BASELINE_REGRESSION", "baseline 不能回退")
            connection.execute(
                "UPDATE routes SET baseline_local_id=?,updated_at=? WHERE route_id=?",
                (baseline_local_id, utc_now(), route_id),
            )
        return self.get_route(route_id)

    def register_subscription(
        self,
        route_id: str,
        conversation_id: str,
        generation: int,
        *,
        subscription_id: str | None = None,
        state: str = "active",
        listen_capability: bool = True,
        send_capability: bool = False,
        policy_ref: str | None = None,
        baseline_event_seq: int | None = None,
    ) -> dict[str, Any]:
        if not conversation_id.strip():
            raise LedgerError("CONVERSATION_REQUIRED", "conversation_id 不能为空")
        if generation < 1:
            raise LedgerError("INVALID_GENERATION", "generation 必须大于等于 1")
        if state not in {"active", "paused", "closed"}:
            raise LedgerError("INVALID_SUBSCRIPTION_STATE", "subscription state 无效")
        if send_capability and not (policy_ref or "").strip():
            raise LedgerError("POLICY_REF_REQUIRED", "启用发送能力必须提供本机 policy_ref")
        subscription_id = subscription_id or str(uuid.uuid4())
        now = utc_now()
        try:
            with self._transaction() as connection:
                route = connection.execute("SELECT state FROM routes WHERE route_id=?", (route_id,)).fetchone()
                if route is None:
                    raise LedgerError("ROUTE_NOT_FOUND", f"route 不存在：{route_id}")
                if state == "active" and route["state"] != "active":
                    raise LedgerError("ROUTE_NOT_ACTIVE", f"route 未处于 active：{route_id}")
                current_event_seq = connection.execute(
                    "SELECT COALESCE(MAX(event_seq),0) FROM events"
                ).fetchone()[0]
                baseline = current_event_seq if baseline_event_seq is None else baseline_event_seq
                if baseline < 0 or baseline > current_event_seq:
                    raise LedgerError("INVALID_SUBSCRIPTION_BASELINE", "subscription baseline 超出事件账本范围")
                connection.execute(
                    """
                    INSERT INTO subscriptions(
                      subscription_id,route_id,conversation_id,generation,state,
                      baseline_event_seq,cursor_event_seq,listen_capability,send_capability,
                      policy_ref,created_at,updated_at
                    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        subscription_id,
                        route_id,
                        conversation_id,
                        generation,
                        state,
                        baseline,
                        baseline,
                        int(listen_capability),
                        int(send_capability),
                        policy_ref,
                        now,
                        now,
                    ),
                )
        except sqlite3.IntegrityError as error:
            raise LedgerError(
                "SUBSCRIPTION_CONFLICT",
                "subscription_id 或 (route_id,conversation_id,generation) 已存在",
            ) from error
        return self.get_subscription(subscription_id)

    def get_subscription(self, subscription_id: str) -> dict[str, Any]:
        connection = self._connect()
        try:
            row = connection.execute(
                "SELECT * FROM subscriptions WHERE subscription_id=?",
                (subscription_id,),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise LedgerError("SUBSCRIPTION_NOT_FOUND", f"subscription 不存在：{subscription_id}")
        return dict(row)

    def list_subscriptions(
        self,
        *,
        route_id: str = "",
        conversation_id: str = "",
        state: str = "",
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        parameters: list[Any] = []
        if route_id:
            clauses.append("route_id=?")
            parameters.append(route_id)
        if conversation_id:
            clauses.append("conversation_id=?")
            parameters.append(conversation_id)
        if state:
            clauses.append("state=?")
            parameters.append(state)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        connection = self._connect()
        try:
            rows = connection.execute(
                f"SELECT * FROM subscriptions{where} ORDER BY created_at,subscription_id",
                parameters,
            ).fetchall()
        finally:
            connection.close()
        return [dict(row) for row in rows]

    def _resolve_subscription(
        self,
        connection: sqlite3.Connection,
        identifier: str,
        *,
        route_id: str = "",
    ) -> sqlite3.Row:
        row = connection.execute(
            "SELECT * FROM subscriptions WHERE subscription_id=?",
            (identifier,),
        ).fetchone()
        if row is not None:
            if route_id and row["route_id"] != route_id:
                raise LedgerError("SUBSCRIPTION_ROUTE_MISMATCH", "subscription 不属于指定 route")
            return row
        compatibility_route = route_id or identifier
        rows = connection.execute(
            "SELECT * FROM subscriptions WHERE route_id=? AND state='active' ORDER BY generation DESC",
            (compatibility_route,),
        ).fetchall()
        if not rows:
            raise LedgerError("SUBSCRIPTION_NOT_FOUND", f"route 没有 active subscription：{compatibility_route}")
        if len(rows) > 1:
            raise LedgerError("AMBIGUOUS_SUBSCRIPTION", "route 已连接多个 active subscription，必须显式指定 subscription_id")
        return rows[0]

    def set_subscription_state(
        self,
        subscription_id: str,
        generation: int,
        state: str,
    ) -> dict[str, Any]:
        if state not in {"active", "paused", "closed"}:
            raise LedgerError("INVALID_SUBSCRIPTION_STATE", "subscription state 无效")
        now = utc_now()
        with self._transaction() as connection:
            subscription = connection.execute(
                "SELECT * FROM subscriptions WHERE subscription_id=?",
                (subscription_id,),
            ).fetchone()
            if subscription is None:
                raise LedgerError("SUBSCRIPTION_NOT_FOUND", f"subscription 不存在：{subscription_id}")
            if subscription["generation"] != generation:
                raise LedgerError("STALE_GENERATION", "generation 与 subscription 不一致")
            if subscription["state"] == "closed" and state != "closed":
                raise LedgerError("SUBSCRIPTION_CLOSED", "closed subscription 不能重新启用")
            if state == "closed":
                pending = connection.execute(
                    "SELECT COUNT(*) FROM event_deliveries WHERE subscription_id=? AND state='PENDING'",
                    (subscription_id,),
                ).fetchone()[0]
                if pending:
                    raise LedgerError(
                        "SUBSCRIPTION_HAS_PENDING",
                        "subscription 仍有 pending delivery，必须先精确 ACK 或保持 paused",
                    )
            if state == "active":
                route = connection.execute(
                    "SELECT state FROM routes WHERE route_id=?", (subscription["route_id"],)
                ).fetchone()
                if route is None or route["state"] != "active":
                    raise LedgerError("ROUTE_NOT_ACTIVE", "route 未处于 active")
                current_event_seq = connection.execute(
                    "SELECT COALESCE(MAX(event_seq),0) FROM events"
                ).fetchone()[0]
                connection.execute(
                    "UPDATE subscriptions SET state='active',cursor_event_seq=?,updated_at=? WHERE subscription_id=?",
                    (current_event_seq, now, subscription_id),
                )
                pending = connection.execute(
                    "SELECT COUNT(*) FROM event_deliveries WHERE subscription_id=? AND state='PENDING'",
                    (subscription_id,),
                ).fetchone()[0]
                active_wake = connection.execute(
                    "SELECT 1 FROM subscription_wakes WHERE subscription_id=? AND state IN ('prepared','submitted','unknown')",
                    (subscription_id,),
                ).fetchone()
                if pending and active_wake is None:
                    connection.execute(
                        "INSERT INTO subscription_wakes VALUES(?,?,?,?,?,'prepared')",
                        (str(uuid.uuid4()), subscription_id, generation, now, str(uuid.uuid4())),
                    )
            else:
                connection.execute(
                    "UPDATE subscriptions SET state=?,updated_at=? WHERE subscription_id=?",
                    (state, now, subscription_id),
                )
                connection.execute(
                    "UPDATE subscription_wakes SET state='closed' WHERE subscription_id=? AND state IN ('prepared','submitted','unknown')",
                    (subscription_id,),
                )
        return self.get_subscription(subscription_id)

    def set_subscription_capabilities(
        self,
        subscription_id: str,
        generation: int,
        *,
        listen_capability: bool,
        send_capability: bool,
        policy_ref: str | None = None,
    ) -> dict[str, Any]:
        if send_capability and not (policy_ref or "").strip():
            raise LedgerError("POLICY_REF_REQUIRED", "启用发送能力必须提供本机 policy_ref")
        with self._transaction() as connection:
            changed = connection.execute(
                """
                UPDATE subscriptions
                SET listen_capability=?,send_capability=?,policy_ref=?,updated_at=?
                WHERE subscription_id=? AND generation=? AND state!='closed'
                """,
                (
                    int(listen_capability),
                    int(send_capability),
                    policy_ref,
                    utc_now(),
                    subscription_id,
                    generation,
                ),
            ).rowcount
            if changed != 1:
                raise LedgerError("SUBSCRIPTION_STATE_CONFLICT", "subscription 不存在、代次不匹配或已关闭")
        return self.get_subscription(subscription_id)

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
            existing = connection.execute(
                "SELECT event_id FROM events WHERE route_id=? AND source_fingerprint=?",
                (route_id, source_fingerprint),
            ).fetchone()
            if existing is not None:
                return {"inserted": False, "event_id": existing["event_id"], "wake": None, "wakes": []}
            event_seq = connection.execute(
                "SELECT COALESCE(MAX(event_seq),0)+1 FROM events"
            ).fetchone()[0]
            connection.execute(
                """
                INSERT INTO events(
                  event_id,route_id,generation,source_fingerprint,occurred_at,observed_at,
                  event_type,payload_json,sensitivity,acked_at,event_seq
                ) VALUES(?,?,?,?,?,?,?,?,?,NULL,?)
                """,
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
                    event_seq,
                ),
            )
            subscriptions = connection.execute(
                """
                SELECT * FROM subscriptions
                WHERE route_id=? AND state='active' AND listen_capability=1
                ORDER BY created_at,subscription_id
                """,
                (route_id,),
            ).fetchall()
            wakes: list[dict[str, Any]] = []
            for subscription in subscriptions:
                pending_before = connection.execute(
                    "SELECT COUNT(*) FROM event_deliveries WHERE subscription_id=? AND state='PENDING'",
                    (subscription["subscription_id"],),
                ).fetchone()[0]
                connection.execute(
                    "INSERT INTO event_deliveries VALUES(?,?, 'PENDING', ?, NULL)",
                    (subscription["subscription_id"], event_id, observed_at),
                )
                connection.execute(
                    "UPDATE subscriptions SET cursor_event_seq=?,updated_at=? WHERE subscription_id=?",
                    (event_seq, observed_at, subscription["subscription_id"]),
                )
                active_wake = connection.execute(
                    "SELECT * FROM subscription_wakes WHERE subscription_id=? AND state IN ('prepared','submitted','unknown')",
                    (subscription["subscription_id"],),
                ).fetchone()
                if pending_before == 0 and active_wake is None:
                    wake_id = str(uuid.uuid4())
                    connection.execute(
                        "INSERT INTO subscription_wakes VALUES(?,?,?,?,?,'prepared')",
                        (
                            wake_id,
                            subscription["subscription_id"],
                            subscription["generation"],
                            observed_at,
                            str(uuid.uuid4()),
                        ),
                    )
                    active_wake = connection.execute(
                        "SELECT * FROM subscription_wakes WHERE wake_id=?", (wake_id,)
                    ).fetchone()
                if active_wake is not None:
                    wakes.append(dict(active_wake))
            return {
                "inserted": True,
                "event_id": event_id,
                "event_seq": event_seq,
                "delivery_count": len(subscriptions),
                "wake": wakes[0] if len(wakes) == 1 else None,
                "wakes": wakes,
            }

    def get_active_wake(self, identifier: str, *, route_id: str = "") -> dict[str, Any] | None:
        connection = self._connect()
        try:
            subscription = self._resolve_subscription(connection, identifier, route_id=route_id)
            row = connection.execute(
                "SELECT * FROM subscription_wakes WHERE subscription_id=? AND state IN ('prepared','submitted','unknown')",
                (subscription["subscription_id"],),
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
                  subscription_wakes.*,
                  subscriptions.route_id,
                  subscriptions.conversation_id,
                  subscriptions.policy_ref,
                  routes.profile,
                  (
                    SELECT COUNT(*) FROM event_deliveries
                    WHERE event_deliveries.subscription_id=subscription_wakes.subscription_id
                      AND event_deliveries.state='PENDING'
                  ) AS pending_count
                FROM subscription_wakes
                JOIN subscriptions USING(subscription_id)
                JOIN routes ON routes.route_id=subscriptions.route_id
                WHERE subscription_wakes.state IN ('prepared','unknown')
                  AND subscriptions.state='active'
                  AND subscriptions.listen_capability=1
                  AND routes.state='active'
                  AND EXISTS(
                    SELECT 1 FROM event_deliveries
                    WHERE event_deliveries.subscription_id=subscription_wakes.subscription_id
                      AND event_deliveries.state='PENDING'
                  )
                ORDER BY subscription_wakes.created_at,subscription_wakes.wake_id
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
            wake = connection.execute(
                "SELECT * FROM subscription_wakes WHERE wake_id=?", (wake_id,)
            ).fetchone()
            if wake is None:
                raise LedgerError("WAKE_NOT_FOUND", f"wake 不存在：{wake_id}")
            if wake["state"] not in expected:
                raise LedgerError("WAKE_STATE_CONFLICT", "wake state 已变化")
            connection.execute(
                "UPDATE subscription_wakes SET state=? WHERE wake_id=?", (next_state, wake_id)
            )
            updated = connection.execute(
                "SELECT * FROM subscription_wakes WHERE wake_id=?", (wake_id,)
            ).fetchone()
        return dict(updated)

    def list_pending(self, identifier: str, limit: int = 100, *, route_id: str = "") -> list[dict[str, Any]]:
        if not 1 <= limit <= 500:
            raise LedgerError("INVALID_LIMIT", "limit 必须在 1 到 500 之间")
        connection = self._connect()
        try:
            subscription = self._resolve_subscription(connection, identifier, route_id=route_id)
            rows = connection.execute(
                """
                SELECT events.*,event_deliveries.delivered_at,event_deliveries.state AS delivery_state
                FROM event_deliveries
                JOIN events USING(event_id)
                WHERE event_deliveries.subscription_id=? AND event_deliveries.state='PENDING'
                ORDER BY events.event_seq
                LIMIT ?
                """,
                (subscription["subscription_id"], limit),
            ).fetchall()
        finally:
            connection.close()
        return [
            {
                **dict(row),
                "subscription_id": subscription["subscription_id"],
                "payload": json.loads(row["payload_json"]),
            }
            for row in rows
        ]

    def ack(
        self,
        identifier: str,
        generation: int,
        wake_id: str,
        event_ids: Sequence[str],
        *,
        route_id: str = "",
    ) -> dict[str, Any]:
        unique_ids = list(dict.fromkeys(event_ids))
        if not unique_ids:
            raise LedgerError("EMPTY_ACK", "event_ids 不能为空")
        now = utc_now()
        with self._transaction() as connection:
            subscription = self._resolve_subscription(connection, identifier, route_id=route_id)
            if subscription["generation"] != generation:
                raise LedgerError("STALE_GENERATION", "generation 与 subscription 不一致")
            wake = connection.execute(
                "SELECT * FROM subscription_wakes WHERE wake_id=? AND subscription_id=?",
                (wake_id, subscription["subscription_id"]),
            ).fetchone()
            if wake is None or wake["state"] not in ACTIVE_WAKE_STATES:
                raise LedgerError("STALE_WAKE", "wake 已失效或不存在")
            if wake["generation"] != generation:
                raise LedgerError("STALE_GENERATION", "generation 与 wake 不一致")
            placeholders = ",".join("?" for _ in unique_ids)
            rows = connection.execute(
                f"""
                SELECT event_deliveries.event_id
                FROM event_deliveries
                JOIN events USING(event_id)
                WHERE event_deliveries.subscription_id=?
                  AND events.route_id=?
                  AND event_deliveries.event_id IN ({placeholders})
                """,
                (subscription["subscription_id"], subscription["route_id"], *unique_ids),
            ).fetchall()
            found = {row["event_id"] for row in rows}
            if found != set(unique_ids):
                raise LedgerError("ACK_EVENT_MISMATCH", "ACK 包含未投递给当前 subscription 的 event_id")
            connection.executemany(
                """
                UPDATE event_deliveries
                SET state='ACKED',acked_at=COALESCE(acked_at,?)
                WHERE subscription_id=? AND event_id=?
                """,
                [(now, subscription["subscription_id"], event_id) for event_id in unique_ids],
            )
            pending = connection.execute(
                "SELECT COUNT(*) FROM event_deliveries WHERE subscription_id=? AND state='PENDING'",
                (subscription["subscription_id"],),
            ).fetchone()[0]
            if pending == 0:
                connection.execute(
                    "UPDATE subscription_wakes SET state='closed' WHERE wake_id=?", (wake_id,)
                )
        return {
            "subscription_id": subscription["subscription_id"],
            "processed_event_ids": unique_ids,
            "pending_count": pending,
            "wake_active": pending > 0,
        }

    def prepare_draft(
        self,
        route_id: str,
        kind: str,
        payload: dict[str, Any],
        expires_at: str,
        subscription_id: str = "",
    ) -> dict[str, Any]:
        _parse_datetime(expires_at)
        draft_id = str(uuid.uuid4())
        now = utc_now()
        content_hash = payload_sha256(payload)
        with self._transaction() as connection:
            route = connection.execute("SELECT state FROM routes WHERE route_id=?", (route_id,)).fetchone()
            if route is None:
                raise LedgerError("ROUTE_NOT_FOUND", f"route 不存在：{route_id}")
            if route["state"] != "active":
                raise LedgerError("ROUTE_NOT_ACTIVE", f"route 未处于 active：{route_id}")
            if kind.startswith("wechat_"):
                if not subscription_id:
                    raise LedgerError("SUBSCRIPTION_REQUIRED", "微信 outbound 必须显式指定 subscription_id")
                subscription = connection.execute(
                    "SELECT * FROM subscriptions WHERE subscription_id=?",
                    (subscription_id,),
                ).fetchone()
                if subscription is None or subscription["route_id"] != route_id:
                    raise LedgerError("SUBSCRIPTION_ROUTE_MISMATCH", "subscription 不属于目标 route")
                if subscription["state"] != "active" or not subscription["send_capability"]:
                    raise LedgerError("SUBSCRIPTION_SEND_DISABLED", "subscription 未启用发送能力")
                if not (subscription["policy_ref"] or "").strip():
                    raise LedgerError("SUBSCRIPTION_POLICY_MISSING", "subscription 缺少本机发送策略引用")
            connection.execute(
                """
                INSERT INTO outbound_drafts(
                  draft_id,subscription_id,route_id,kind,payload_json,content_sha256,expires_at,state,
                  created_at,updated_at
                ) VALUES(?,?,?,?,?,?,?,'PREPARED',?,?)
                """,
                (
                    draft_id,
                    subscription_id or None,
                    route_id,
                    kind,
                    canonical_json(payload),
                    content_hash,
                    expires_at,
                    now,
                    now,
                ),
            )
        return {"draft_id": draft_id, "content_sha256": content_hash, "state": "PREPARED"}

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
        if not dedupe_key.strip():
            raise LedgerError("DEDUPE_KEY_REQUIRED", "dedupe_key 不能为空")
        call_time = _parse_datetime(called_at or utc_now())
        for reference in owner_authorization_refs:
            required = {"conversation_id", "turn_id", "message_item_id", "role", "authorized_at"}
            if not required.issubset(reference) or reference["role"] != "user":
                raise LedgerError("OWNER_AUTH_INVALID", "授权引用字段不完整或角色不是 user")
            if _parse_datetime(str(reference["authorized_at"])) >= call_time:
                raise LedgerError("OWNER_AUTH_FUTURE", "授权时间必须早于调用时间")
        now = utc_now()
        try:
            with self._transaction() as connection:
                draft = connection.execute(
                    "SELECT * FROM outbound_drafts WHERE draft_id=?", (draft_id,)
                ).fetchone()
                if draft is None:
                    raise LedgerError("DRAFT_NOT_FOUND", "draft 不存在")
                if draft["state"] != "PREPARED":
                    raise LedgerError("DRAFT_STATE_INVALID", f"draft 当前状态为 {draft['state']}")
                if _parse_datetime(draft["expires_at"]) <= call_time:
                    raise LedgerError("DRAFT_EXPIRED", "draft 已过期")
                if payload_sha256(payload) != draft["content_sha256"]:
                    raise LedgerError("DRAFT_CHANGED", "正文、目标或附件发生变化，旧批准失效")
                connection.execute(
                    """
                    UPDATE outbound_drafts
                    SET state='APPROVED',owner_authorization_refs_json=?,dedupe_key=?,updated_at=?
                    WHERE draft_id=?
                    """,
                    (canonical_json(list(owner_authorization_refs)), dedupe_key, now, draft_id),
                )
        except sqlite3.IntegrityError as error:
            raise LedgerError("DEDUPE_KEY_CONFLICT", "dedupe_key 已被使用") from error
        return {"draft_id": draft_id, "state": "APPROVED", "dedupe_key": dedupe_key}

    def get_draft(self, draft_id: str) -> dict[str, Any]:
        connection = self._connect()
        try:
            row = connection.execute(
                "SELECT * FROM outbound_drafts WHERE draft_id=?", (draft_id,)
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise LedgerError("DRAFT_NOT_FOUND", "draft 不存在")
        result = dict(row)
        result["payload"] = json.loads(result.pop("payload_json"))
        authorization_json = result.pop("owner_authorization_refs_json")
        result["owner_authorization_refs"] = json.loads(authorization_json) if authorization_json else []
        result_json = result.pop("result_json")
        result["result"] = json.loads(result_json) if result_json else None
        return result

    def require_approved_draft(
        self,
        draft_id: str,
        payload: dict[str, Any],
        dedupe_key: str,
        called_at: str | None = None,
    ) -> dict[str, Any]:
        draft = self.get_draft(draft_id)
        if draft["state"] != "APPROVED":
            raise LedgerError("DRAFT_NOT_APPROVED", f"draft 当前状态为 {draft['state']}")
        if draft["dedupe_key"] != dedupe_key:
            raise LedgerError("DEDUPE_KEY_MISMATCH", "dedupe_key 与批准记录不一致")
        if payload_sha256(payload) != draft["content_sha256"]:
            raise LedgerError("DRAFT_CHANGED", "执行参数与批准草稿不一致")
        if not draft["owner_authorization_refs"]:
            raise LedgerError("OWNER_AUTH_REQUIRED", "批准记录缺少 owner_authorization_refs")
        if _parse_datetime(draft["expires_at"]) <= _parse_datetime(called_at or utc_now()):
            raise LedgerError("DRAFT_EXPIRED", "draft 已过期")
        return draft

    def acquire_draft_execution(
        self,
        draft_id: str,
        payload: dict[str, Any],
        dedupe_key: str,
        execution_id: str,
        lease_expires_at: str,
        *,
        lease_scope: str = "wechat-visible-ui",
    ) -> dict[str, Any]:
        call_time = _parse_datetime(utc_now())
        lease_expiration = _parse_datetime(lease_expires_at)
        if lease_expiration <= call_time:
            raise LedgerError("INVALID_EXECUTION_LEASE", "执行租约必须晚于当前时间")
        try:
            with self._transaction() as connection:
                draft = connection.execute(
                    "SELECT * FROM outbound_drafts WHERE draft_id=?", (draft_id,)
                ).fetchone()
                if draft is None:
                    raise LedgerError("DRAFT_NOT_FOUND", "draft 不存在")
                if draft["state"] != "APPROVED":
                    raise LedgerError("DRAFT_NOT_EXECUTABLE", f"draft 当前状态为 {draft['state']}")
                if draft["dedupe_key"] != dedupe_key:
                    raise LedgerError("DEDUPE_KEY_MISMATCH", "dedupe_key 与批准记录不一致")
                if payload_sha256(payload) != draft["content_sha256"]:
                    raise LedgerError("DRAFT_CHANGED", "执行参数与批准草稿不一致")
                if not draft["owner_authorization_refs_json"]:
                    raise LedgerError("OWNER_AUTH_REQUIRED", "批准记录缺少 owner_authorization_refs")
                if _parse_datetime(draft["expires_at"]) <= call_time:
                    raise LedgerError("DRAFT_EXPIRED", "draft 已过期")
                route = connection.execute(
                    "SELECT state FROM routes WHERE route_id=?", (draft["route_id"],)
                ).fetchone()
                if route is None or route["state"] != "active":
                    raise LedgerError("ROUTE_NOT_ACTIVE", "草稿目标 route 已停用或进入隔离")
                if str(draft["kind"]).startswith("wechat_"):
                    subscription = connection.execute(
                        "SELECT * FROM subscriptions WHERE subscription_id=?",
                        (draft["subscription_id"],),
                    ).fetchone()
                    if subscription is None or subscription["route_id"] != draft["route_id"]:
                        raise LedgerError(
                            "SUBSCRIPTION_ROUTE_MISMATCH", "草稿 subscription 不再属于目标 route"
                        )
                    if subscription["state"] != "active" or not subscription["send_capability"]:
                        raise LedgerError(
                            "SUBSCRIPTION_SEND_DISABLED", "执行前 subscription 已暂停、关闭或撤销发送能力"
                        )
                    if not (subscription["policy_ref"] or "").strip():
                        raise LedgerError(
                            "SUBSCRIPTION_POLICY_MISSING", "执行前 subscription 缺少本机发送策略引用"
                        )
                connection.execute(
                    """
                    UPDATE outbound_drafts
                    SET state='EXECUTING',approval_consumed_at=?,execution_id=?,
                        lease_scope=?,lease_expires_at=?,updated_at=?
                    WHERE draft_id=? AND state='APPROVED'
                    """,
                    (utc_now(), execution_id, lease_scope, lease_expires_at, utc_now(), draft_id),
                )
        except sqlite3.IntegrityError as error:
            raise LedgerError("SEND_LEASE_BUSY", "已有微信发送正在执行") from error
        return self.get_draft(draft_id)

    def finish_draft_execution(
        self,
        draft_id: str,
        execution_id: str,
        next_state: str,
        result: dict[str, Any] | None = None,
        error_code: str | None = None,
    ) -> dict[str, Any]:
        if next_state not in {"SEND_ATTEMPTED", "FAILED", "UNKNOWN"}:
            raise LedgerError("DRAFT_STATE_INVALID", "执行完成状态无效")
        with self._transaction() as connection:
            changed = connection.execute(
                """
                UPDATE outbound_drafts
                SET state=?,result_json=?,error_code=?,lease_scope=NULL,lease_expires_at=NULL,updated_at=?
                WHERE draft_id=? AND execution_id=? AND state='EXECUTING'
                """,
                (
                    next_state,
                    canonical_json(result) if result is not None else None,
                    error_code,
                    utc_now(),
                    draft_id,
                    execution_id,
                ),
            ).rowcount
            if changed != 1:
                raise LedgerError("DRAFT_STATE_CONFLICT", "draft 执行租约不存在或已结束")
        return self.get_draft(draft_id)

    def recover_expired_executions(self, called_at: str | None = None) -> list[str]:
        now = _parse_datetime(called_at or utc_now()).astimezone(timezone.utc)
        now_iso = now.isoformat()
        with self._transaction() as connection:
            rows = connection.execute(
                """
                SELECT draft_id,lease_expires_at FROM outbound_drafts
                WHERE state='EXECUTING' AND lease_expires_at IS NOT NULL
                """
            ).fetchall()
            draft_ids = [
                row["draft_id"]
                for row in rows
                if _parse_datetime(row["lease_expires_at"]).astimezone(timezone.utc) <= now
            ]
            if draft_ids:
                placeholders = ",".join("?" for _ in draft_ids)
                connection.execute(
                    f"""
                    UPDATE outbound_drafts
                    SET state='UNKNOWN',lease_scope=NULL,lease_expires_at=NULL,
                        error_code='EXECUTION_LEASE_EXPIRED',updated_at=?
                    WHERE draft_id IN ({placeholders}) AND state='EXECUTING'
                    """,
                    (now_iso, *draft_ids),
                )
        return draft_ids

    def verify_draft(self, draft_id: str, observed_event_id: str) -> dict[str, Any]:
        with self._transaction() as connection:
            event = connection.execute(
                "SELECT route_id,event_type,payload_json,observed_at FROM events WHERE event_id=?",
                (observed_event_id,),
            ).fetchone()
            draft = connection.execute(
                "SELECT * FROM outbound_drafts WHERE draft_id=?", (draft_id,)
            ).fetchone()
            if draft is None:
                raise LedgerError("DRAFT_NOT_FOUND", "draft 不存在")
            if event is None or event["route_id"] != draft["route_id"]:
                raise LedgerError("OUTBOUND_OBSERVATION_MISMATCH", "观察事件与草稿 route 不匹配")
            if draft["state"] not in {"SEND_ATTEMPTED", "UNKNOWN"}:
                raise LedgerError("DRAFT_STATE_INVALID", f"draft 当前状态为 {draft['state']}")
            if draft["kind"] != "wechat_text" or event["event_type"] != "text":
                raise LedgerError("OUTBOUND_VERIFICATION_UNSUPPORTED", "当前只支持文字草稿的数据库确认")
            event_payload = json.loads(event["payload_json"])
            draft_payload = json.loads(draft["payload_json"])
            if event_payload.get("direction") != "outbound":
                raise LedgerError("OUTBOUND_DIRECTION_UNVERIFIED", "事件未被可信解析层确认为 outbound")
            if event_payload.get("visible_text") != draft_payload.get("text"):
                raise LedgerError("OUTBOUND_CONTENT_MISMATCH", "数据库事件正文与批准草稿不一致")
            if not draft["approval_consumed_at"] or _parse_datetime(event["observed_at"]) < _parse_datetime(
                draft["approval_consumed_at"]
            ):
                raise LedgerError("OUTBOUND_EVENT_TOO_OLD", "数据库事件早于本次发送执行")
            try:
                connection.execute(
                    "INSERT INTO outbound_verifications(observed_event_id,draft_id,verified_at) VALUES(?,?,?)",
                    (observed_event_id, draft_id, utc_now()),
                )
            except sqlite3.IntegrityError as error:
                raise LedgerError(
                    "OUTBOUND_OBSERVATION_ALREADY_USED",
                    "同一数据库出站事件不能验证多个草稿",
                ) from error
            result = json.loads(draft["result_json"]) if draft["result_json"] else {}
            result["observed_event_id"] = observed_event_id
            connection.execute(
                "UPDATE outbound_drafts SET state='VERIFIED',result_json=?,error_code=NULL,updated_at=? WHERE draft_id=?",
                (canonical_json(result), utc_now(), draft_id),
            )
        return self.get_draft(draft_id)

    def mark_draft_state(self, draft_id: str, expected: str, next_state: str) -> dict[str, Any]:
        if expected not in OUTBOUND_STATES or next_state not in OUTBOUND_STATES:
            raise LedgerError("DRAFT_STATE_INVALID", "draft 状态不在允许集合中")
        with self._transaction() as connection:
            changed = connection.execute(
                "UPDATE outbound_drafts SET state=?,updated_at=? WHERE draft_id=? AND state=?",
                (next_state, utc_now(), draft_id, expected),
            ).rowcount
            if changed != 1:
                raise LedgerError("DRAFT_STATE_CONFLICT", f"draft 不是预期状态 {expected}")
        return self.get_draft(draft_id)
