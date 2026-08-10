from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Sequence

import httpx

from .document_policy import PrivateBindingDocumentMonitorVerifier
from .ledger import EventLedger, LedgerError, canonical_json, payload_sha256, utc_now
from .tencent_docs import TencentDocsMcpClient, classify_tool


ACTIVE_WAKE_STATES = ("prepared", "submitted", "unknown")


def _time(value: str | datetime | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise LedgerError("TIMEZONE_REQUIRED", "document monitor 时间必须包含时区")
    return parsed.astimezone(timezone.utc)


def _safe_monitor(row: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in row.items()
        if key not in {"poll_arguments_json", "baseline_summary_json"}
    }


class DocumentMonitorStore:
    def __init__(
        self,
        ledger: EventLedger,
        *,
        quiet_window: timedelta = timedelta(minutes=5),
        max_batch: timedelta = timedelta(minutes=15),
    ) -> None:
        if quiet_window.total_seconds() <= 0 or max_batch < quiet_window:
            raise ValueError("max_batch must be greater than or equal to quiet_window")
        self.ledger = ledger
        self.quiet_window = quiet_window
        self.max_batch = max_batch

    def register_monitor(
        self,
        resource_kind: str,
        resource_key: str,
        poll_tool: str,
        poll_arguments: dict[str, Any],
        baseline_fingerprint: str,
        baseline_summary: dict[str, Any],
        *,
        policy_ref: str,
        monitor_id: str | None = None,
        observed_at: str | datetime | None = None,
    ) -> dict[str, Any]:
        if not resource_kind.strip() or not resource_key.strip():
            raise LedgerError("DOCUMENT_RESOURCE_REQUIRED", "resource_kind 和 resource_key 不能为空")
        if not poll_tool.strip() or not isinstance(poll_arguments, dict):
            raise LedgerError("DOCUMENT_POLL_CONTRACT_REQUIRED", "poll_tool 和 poll_arguments 必须有效")
        if not policy_ref.strip():
            raise LedgerError("DOCUMENT_POLICY_REF_REQUIRED", "登记私有文档监视必须提供 policy_ref")
        if not baseline_fingerprint.strip():
            raise LedgerError("DOCUMENT_BASELINE_REQUIRED", "首次登记必须保存成功读取的 baseline")
        monitor_id = monitor_id or str(uuid.uuid4())
        observed = _time(observed_at).isoformat()
        try:
            with self.ledger._transaction() as connection:
                connection.execute(
                    """
                    INSERT INTO tdocs_monitors(
                      monitor_id,provider,resource_kind,resource_key_sha256,poll_tool,
                      poll_arguments_json,state,baseline_fingerprint,baseline_summary_json,
                      baseline_observed_at,last_success_at,last_error_code,consecutive_failures,
                      policy_ref,created_at,updated_at
                    ) VALUES(?,?,?,?,?,?,'active',?,?,?,?,NULL,0,?,?,?)
                    """,
                    (
                        monitor_id,
                        "tencent_docs_official_mcp",
                        resource_kind.strip().casefold(),
                        payload_sha256(resource_key.strip()),
                        poll_tool,
                        canonical_json(poll_arguments),
                        baseline_fingerprint,
                        canonical_json(baseline_summary),
                        observed,
                        observed,
                        policy_ref,
                        observed,
                        observed,
                    ),
                )
        except Exception as error:
            if getattr(error, "sqlite_errorname", "").startswith("SQLITE_CONSTRAINT"):
                raise LedgerError(
                    "DOCUMENT_MONITOR_CONFLICT",
                    "monitor_id 或文档资源已登记",
                ) from error
            raise
        return self.get_monitor(monitor_id)

    def get_monitor(self, monitor_id: str, *, private: bool = False) -> dict[str, Any]:
        connection = self.ledger._connect()
        try:
            row = connection.execute(
                "SELECT * FROM tdocs_monitors WHERE monitor_id=?",
                (monitor_id,),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise LedgerError("DOCUMENT_MONITOR_NOT_FOUND", f"monitor 不存在：{monitor_id}")
        result = dict(row)
        if private:
            result["poll_arguments"] = json.loads(result.pop("poll_arguments_json"))
            result["baseline_summary"] = json.loads(result.pop("baseline_summary_json") or "{}")
            return result
        return _safe_monitor(result)

    def list_monitors(self, state: str = "") -> list[dict[str, Any]]:
        connection = self.ledger._connect()
        try:
            if state:
                rows = connection.execute(
                    "SELECT * FROM tdocs_monitors WHERE state=? ORDER BY created_at,monitor_id",
                    (state,),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM tdocs_monitors ORDER BY created_at,monitor_id"
                ).fetchall()
        finally:
            connection.close()
        return [_safe_monitor(dict(row)) for row in rows]

    def set_monitor_state(self, monitor_id: str, state: str) -> dict[str, Any]:
        if state not in {"active", "paused", "closed"}:
            raise LedgerError("INVALID_DOCUMENT_MONITOR_STATE", "monitor state 无效")
        with self.ledger._transaction() as connection:
            row = connection.execute(
                "SELECT state FROM tdocs_monitors WHERE monitor_id=?", (monitor_id,)
            ).fetchone()
            if row is None:
                raise LedgerError("DOCUMENT_MONITOR_NOT_FOUND", f"monitor 不存在：{monitor_id}")
            if row["state"] == "closed" and state != "closed":
                raise LedgerError("DOCUMENT_MONITOR_CLOSED", "closed monitor 不能重新启用")
            if state == "closed":
                active = connection.execute(
                    "SELECT COUNT(*) FROM tdocs_monitor_subscriptions WHERE monitor_id=? AND state<>'closed'",
                    (monitor_id,),
                ).fetchone()[0]
                if active:
                    raise LedgerError(
                        "DOCUMENT_MONITOR_HAS_SUBSCRIPTIONS",
                        "关闭 monitor 前必须先关闭所有 subscription",
                    )
            connection.execute(
                "UPDATE tdocs_monitors SET state=?,updated_at=? WHERE monitor_id=?",
                (state, utc_now(), monitor_id),
            )
        return self.get_monitor(monitor_id)

    def register_subscription(
        self,
        monitor_id: str,
        conversation_id: str,
        generation: int,
        *,
        subscription_id: str | None = None,
        listen_capability: bool = True,
        policy_ref: str | None = None,
    ) -> dict[str, Any]:
        if not conversation_id.strip():
            raise LedgerError("CONVERSATION_REQUIRED", "conversation_id 不能为空")
        if generation < 1:
            raise LedgerError("INVALID_GENERATION", "generation 必须大于等于 1")
        subscription_id = subscription_id or str(uuid.uuid4())
        now = utc_now()
        try:
            with self.ledger._transaction() as connection:
                monitor = connection.execute(
                    "SELECT state FROM tdocs_monitors WHERE monitor_id=?", (monitor_id,)
                ).fetchone()
                if monitor is None:
                    raise LedgerError("DOCUMENT_MONITOR_NOT_FOUND", f"monitor 不存在：{monitor_id}")
                if monitor["state"] != "active":
                    raise LedgerError("DOCUMENT_MONITOR_NOT_ACTIVE", "只能订阅 active monitor")
                baseline = connection.execute(
                    "SELECT COALESCE(MAX(batch_seq),0) FROM tdocs_monitor_batches"
                ).fetchone()[0]
                connection.execute(
                    """
                    INSERT INTO tdocs_monitor_subscriptions(
                      subscription_id,monitor_id,conversation_id,generation,state,
                      baseline_batch_seq,cursor_batch_seq,listen_capability,policy_ref,
                      created_at,updated_at
                    ) VALUES(?,?,?,?,'active',?,?,?,?,?,?)
                    """,
                    (
                        subscription_id,
                        monitor_id,
                        conversation_id,
                        generation,
                        baseline,
                        baseline,
                        int(listen_capability),
                        policy_ref,
                        now,
                        now,
                    ),
                )
        except Exception as error:
            if getattr(error, "sqlite_errorname", "").startswith("SQLITE_CONSTRAINT"):
                raise LedgerError(
                    "DOCUMENT_SUBSCRIPTION_CONFLICT",
                    "subscription_id 或 (monitor_id,conversation_id,generation) 已存在",
                ) from error
            raise
        return self.get_subscription(subscription_id)

    def get_subscription(self, subscription_id: str) -> dict[str, Any]:
        connection = self.ledger._connect()
        try:
            row = connection.execute(
                "SELECT * FROM tdocs_monitor_subscriptions WHERE subscription_id=?",
                (subscription_id,),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise LedgerError(
                "DOCUMENT_SUBSCRIPTION_NOT_FOUND", f"document subscription 不存在：{subscription_id}"
            )
        return dict(row)

    def list_subscriptions(
        self,
        *,
        monitor_id: str = "",
        conversation_id: str = "",
        state: str = "",
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        parameters: list[Any] = []
        for column, value in (
            ("monitor_id", monitor_id),
            ("conversation_id", conversation_id),
            ("state", state),
        ):
            if value:
                clauses.append(f"{column}=?")
                parameters.append(value)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        connection = self.ledger._connect()
        try:
            rows = connection.execute(
                f"SELECT * FROM tdocs_monitor_subscriptions{where} ORDER BY created_at,subscription_id",
                parameters,
            ).fetchall()
        finally:
            connection.close()
        return [dict(row) for row in rows]

    def set_subscription_state(
        self, subscription_id: str, generation: int, state: str
    ) -> dict[str, Any]:
        if state not in {"active", "paused", "closed"}:
            raise LedgerError("INVALID_DOCUMENT_SUBSCRIPTION_STATE", "subscription state 无效")
        with self.ledger._transaction() as connection:
            subscription = connection.execute(
                "SELECT * FROM tdocs_monitor_subscriptions WHERE subscription_id=?",
                (subscription_id,),
            ).fetchone()
            if subscription is None:
                raise LedgerError(
                    "DOCUMENT_SUBSCRIPTION_NOT_FOUND", f"document subscription 不存在：{subscription_id}"
                )
            if subscription["generation"] != generation:
                raise LedgerError("GENERATION_MISMATCH", "document subscription generation 不匹配")
            if subscription["state"] == "closed" and state != "closed":
                raise LedgerError("DOCUMENT_SUBSCRIPTION_CLOSED", "closed subscription 不能重新启用")
            if state == "closed":
                pending = connection.execute(
                    "SELECT COUNT(*) FROM tdocs_batch_deliveries WHERE subscription_id=? AND state='PENDING'",
                    (subscription_id,),
                ).fetchone()[0]
                wake = connection.execute(
                    "SELECT 1 FROM tdocs_subscription_wakes WHERE subscription_id=? AND state IN ('prepared','submitted','unknown')",
                    (subscription_id,),
                ).fetchone()
                if pending or wake is not None:
                    raise LedgerError(
                        "DOCUMENT_SUBSCRIPTION_PENDING",
                        "关闭 document subscription 前必须精确 ACK 全部 pending batch",
                    )
            connection.execute(
                "UPDATE tdocs_monitor_subscriptions SET state=?,updated_at=? WHERE subscription_id=?",
                (state, utc_now(), subscription_id),
            )
        return self.get_subscription(subscription_id)

    def record_poll_failure(self, monitor_id: str, error_code: str) -> dict[str, Any]:
        with self.ledger._transaction() as connection:
            changed = connection.execute(
                """
                UPDATE tdocs_monitors
                SET last_error_code=?,consecutive_failures=consecutive_failures+1,updated_at=?
                WHERE monitor_id=?
                """,
                (error_code, utc_now(), monitor_id),
            ).rowcount
            if changed != 1:
                raise LedgerError("DOCUMENT_MONITOR_NOT_FOUND", f"monitor 不存在：{monitor_id}")
        return self.get_monitor(monitor_id)

    def record_poll_success(
        self,
        monitor_id: str,
        fingerprint: str,
        summary: dict[str, Any],
        observed_at: str | datetime | None = None,
    ) -> dict[str, Any]:
        observed = _time(observed_at)
        observed_iso = observed.isoformat()
        with self.ledger._transaction() as connection:
            monitor = connection.execute(
                "SELECT * FROM tdocs_monitors WHERE monitor_id=?", (monitor_id,)
            ).fetchone()
            if monitor is None:
                raise LedgerError("DOCUMENT_MONITOR_NOT_FOUND", f"monitor 不存在：{monitor_id}")
            previous = monitor["baseline_fingerprint"]
            inserted = False
            batch_id: str | None = None
            promoted = self._promote_due(connection, observed)
            if previous is not None and previous != fingerprint:
                batch_id, inserted = self._observe_change(
                    connection, monitor_id, fingerprint, summary, observed
                )
            connection.execute(
                """
                UPDATE tdocs_monitors
                SET baseline_fingerprint=?,baseline_summary_json=?,baseline_observed_at=?,
                    last_success_at=?,last_error_code=NULL,consecutive_failures=0,updated_at=?
                WHERE monitor_id=?
                """,
                (
                    fingerprint,
                    canonical_json(summary),
                    observed_iso,
                    observed_iso,
                    observed_iso,
                    monitor_id,
                ),
            )
        return {
            "monitor_id": monitor_id,
            "baseline_established": previous is None,
            "changed": previous is not None and previous != fingerprint,
            "change_inserted": inserted,
            "batch_id": batch_id,
            "promoted_batch_ids": promoted,
        }

    def _observe_change(
        self,
        connection: Any,
        monitor_id: str,
        change_fingerprint: str,
        summary: dict[str, Any],
        observed: datetime,
    ) -> tuple[str, bool]:
        duplicate = connection.execute(
            "SELECT batch_id FROM tdocs_monitor_changes WHERE monitor_id=? AND change_fingerprint=?",
            (monitor_id, change_fingerprint),
        ).fetchone()
        if duplicate is not None:
            return duplicate["batch_id"], False
        batch = connection.execute(
            "SELECT * FROM tdocs_monitor_batches WHERE monitor_id=? AND state='OPEN'",
            (monitor_id,),
        ).fetchone()
        observed_iso = observed.isoformat()
        if batch is None:
            batch_id = str(uuid.uuid4())
            batch_seq = connection.execute(
                "SELECT COALESCE(MAX(batch_seq),0)+1 FROM tdocs_monitor_batches"
            ).fetchone()[0]
            emit_after = min(observed + self.quiet_window, observed + self.max_batch)
            connection.execute(
                """
                INSERT INTO tdocs_monitor_batches(
                  batch_id,batch_seq,monitor_id,state,first_observed_at,last_observed_at,
                  emit_after,change_count,summary_json,created_at,updated_at
                ) VALUES(?,?,?,'OPEN',?,?,?,0,?,?,?)
                """,
                (
                    batch_id,
                    batch_seq,
                    monitor_id,
                    observed_iso,
                    observed_iso,
                    emit_after.isoformat(),
                    canonical_json({}),
                    observed_iso,
                    observed_iso,
                ),
            )
            batch = connection.execute(
                "SELECT * FROM tdocs_monitor_batches WHERE batch_id=?", (batch_id,)
            ).fetchone()
        connection.execute(
            "INSERT INTO tdocs_monitor_changes VALUES(?,?,?,?,?)",
            (monitor_id, change_fingerprint, batch["batch_id"], observed_iso, canonical_json(summary)),
        )
        first = _time(batch["first_observed_at"])
        emit_after = min(first + self.max_batch, observed + self.quiet_window)
        aggregate = {
            "resource_shape": summary,
            "change_count": int(batch["change_count"]) + 1,
        }
        connection.execute(
            """
            UPDATE tdocs_monitor_batches
            SET last_observed_at=?,emit_after=?,change_count=change_count+1,
                summary_json=?,updated_at=? WHERE batch_id=?
            """,
            (
                observed_iso,
                emit_after.isoformat(),
                canonical_json(aggregate),
                observed_iso,
                batch["batch_id"],
            ),
        )
        return batch["batch_id"], True

    def promote_ready(self, now: str | datetime | None = None) -> list[str]:
        with self.ledger._transaction() as connection:
            return self._promote_due(connection, _time(now))

    def _promote_due(self, connection: Any, current: datetime) -> list[str]:
        rows = connection.execute(
            "SELECT * FROM tdocs_monitor_batches WHERE state='OPEN' AND emit_after<=? ORDER BY batch_seq",
            (current.isoformat(),),
        ).fetchall()
        promoted: list[str] = []
        for batch in rows:
            connection.execute(
                "UPDATE tdocs_monitor_batches SET state='READY',updated_at=? WHERE batch_id=?",
                (current.isoformat(), batch["batch_id"]),
            )
            self._fanout_batch(connection, batch, current.isoformat())
            promoted.append(batch["batch_id"])
        return promoted

    def _fanout_batch(self, connection: Any, batch: Any, delivered_at: str) -> None:
        subscriptions = connection.execute(
            """
            SELECT * FROM tdocs_monitor_subscriptions
            WHERE monitor_id=? AND state='active' AND listen_capability=1
              AND baseline_batch_seq<?
            ORDER BY created_at,subscription_id
            """,
            (batch["monitor_id"], batch["batch_seq"]),
        ).fetchall()
        for subscription in subscriptions:
            pending_before = connection.execute(
                "SELECT COUNT(*) FROM tdocs_batch_deliveries WHERE subscription_id=? AND state='PENDING'",
                (subscription["subscription_id"],),
            ).fetchone()[0]
            connection.execute(
                "INSERT OR IGNORE INTO tdocs_batch_deliveries VALUES(?,?,'PENDING',?,NULL)",
                (subscription["subscription_id"], batch["batch_id"], delivered_at),
            )
            connection.execute(
                "UPDATE tdocs_monitor_subscriptions SET cursor_batch_seq=?,updated_at=? WHERE subscription_id=?",
                (batch["batch_seq"], delivered_at, subscription["subscription_id"]),
            )
            active_wake = connection.execute(
                "SELECT 1 FROM tdocs_subscription_wakes WHERE subscription_id=? AND state IN ('prepared','submitted','unknown')",
                (subscription["subscription_id"],),
            ).fetchone()
            if pending_before == 0 and active_wake is None:
                connection.execute(
                    "INSERT INTO tdocs_subscription_wakes VALUES(?,?,?,?,?,'prepared')",
                    (
                        str(uuid.uuid4()),
                        subscription["subscription_id"],
                        subscription["generation"],
                        delivered_at,
                        str(uuid.uuid4()),
                    ),
                )

    def list_pending(self, subscription_id: str, limit: int = 50) -> list[dict[str, Any]]:
        if limit < 1 or limit > 500:
            raise LedgerError("INVALID_LIMIT", "limit 必须在 1 到 500 之间")
        connection = self.ledger._connect()
        try:
            rows = connection.execute(
                """
                SELECT b.batch_id,b.batch_seq,b.monitor_id,b.state,b.first_observed_at,
                       b.last_observed_at,b.emit_after,b.change_count,b.summary_json,
                       d.delivered_at
                FROM tdocs_batch_deliveries d
                JOIN tdocs_monitor_batches b USING(batch_id)
                WHERE d.subscription_id=? AND d.state='PENDING'
                ORDER BY b.batch_seq LIMIT ?
                """,
                (subscription_id, limit),
            ).fetchall()
        finally:
            connection.close()
        return [
            {**dict(row), "summary": json.loads(row["summary_json"])}
            for row in rows
        ]

    def get_active_wake(self, subscription_id: str) -> dict[str, Any] | None:
        connection = self.ledger._connect()
        try:
            row = connection.execute(
                """
                SELECT * FROM tdocs_subscription_wakes
                WHERE subscription_id=? AND state IN ('prepared','submitted','unknown')
                """,
                (subscription_id,),
            ).fetchone()
        finally:
            connection.close()
        return dict(row) if row is not None else None

    def ack(
        self,
        subscription_id: str,
        generation: int,
        wake_id: str,
        batch_ids: Sequence[str],
    ) -> dict[str, Any]:
        if not batch_ids:
            raise LedgerError("DOCUMENT_BATCH_IDS_REQUIRED", "batch_ids 不能为空")
        unique_ids = list(dict.fromkeys(batch_ids))
        with self.ledger._transaction() as connection:
            subscription = connection.execute(
                "SELECT * FROM tdocs_monitor_subscriptions WHERE subscription_id=?",
                (subscription_id,),
            ).fetchone()
            if subscription is None:
                raise LedgerError("DOCUMENT_SUBSCRIPTION_NOT_FOUND", "document subscription 不存在")
            if subscription["generation"] != generation:
                raise LedgerError("GENERATION_MISMATCH", "document subscription generation 不匹配")
            wake = connection.execute(
                "SELECT * FROM tdocs_subscription_wakes WHERE wake_id=? AND subscription_id=?",
                (wake_id, subscription_id),
            ).fetchone()
            if wake is None or wake["state"] not in ACTIVE_WAKE_STATES:
                raise LedgerError("DOCUMENT_WAKE_NOT_ACTIVE", "document wake 不存在或已关闭")
            placeholders = ",".join("?" for _ in unique_ids)
            rows = connection.execute(
                f"""
                SELECT batch_id FROM tdocs_batch_deliveries
                WHERE subscription_id=? AND state='PENDING' AND batch_id IN ({placeholders})
                """,
                (subscription_id, *unique_ids),
            ).fetchall()
            found = {row["batch_id"] for row in rows}
            missing = [batch_id for batch_id in unique_ids if batch_id not in found]
            if missing:
                raise LedgerError("DOCUMENT_BATCH_NOT_PENDING", "部分 batch 不属于该 subscription 的 pending")
            acked_at = utc_now()
            connection.execute(
                f"""
                UPDATE tdocs_batch_deliveries SET state='ACKED',acked_at=?
                WHERE subscription_id=? AND state='PENDING' AND batch_id IN ({placeholders})
                """,
                (acked_at, subscription_id, *unique_ids),
            )
            pending = connection.execute(
                "SELECT COUNT(*) FROM tdocs_batch_deliveries WHERE subscription_id=? AND state='PENDING'",
                (subscription_id,),
            ).fetchone()[0]
            if pending == 0:
                connection.execute(
                    "UPDATE tdocs_subscription_wakes SET state='closed' WHERE wake_id=?",
                    (wake_id,),
                )
        return {
            "subscription_id": subscription_id,
            "processed_batch_ids": unique_ids,
            "pending_count": pending,
            "wake_active": pending > 0,
        }

    def list_wakes_for_notification(self, limit: int = 100) -> list[dict[str, Any]]:
        connection = self.ledger._connect()
        try:
            rows = connection.execute(
                """
                SELECT w.*,s.monitor_id,s.conversation_id,s.policy_ref,
                       (SELECT COUNT(*) FROM tdocs_batch_deliveries d
                        WHERE d.subscription_id=w.subscription_id AND d.state='PENDING') AS pending_count
                FROM tdocs_subscription_wakes w
                JOIN tdocs_monitor_subscriptions s USING(subscription_id)
                JOIN tdocs_monitors m ON m.monitor_id=s.monitor_id
                WHERE w.state IN ('prepared','unknown')
                  AND s.state='active' AND s.listen_capability=1 AND m.state='active'
                  AND EXISTS(SELECT 1 FROM tdocs_batch_deliveries d
                             WHERE d.subscription_id=w.subscription_id AND d.state='PENDING')
                ORDER BY w.created_at,w.wake_id LIMIT ?
                """,
                (limit,),
            ).fetchall()
        finally:
            connection.close()
        return [dict(row) for row in rows]

    def mark_wake_state(
        self, wake_id: str, expected_states: Sequence[str], next_state: str
    ) -> dict[str, Any]:
        allowed = {"prepared", "submitted", "unknown", "closed", "failed"}
        expected = set(expected_states)
        if not expected or not expected.issubset(allowed) or next_state not in allowed:
            raise LedgerError("INVALID_DOCUMENT_WAKE_STATE", "document wake state 参数无效")
        with self.ledger._transaction() as connection:
            wake = connection.execute(
                "SELECT * FROM tdocs_subscription_wakes WHERE wake_id=?", (wake_id,)
            ).fetchone()
            if wake is None:
                raise LedgerError("DOCUMENT_WAKE_NOT_FOUND", f"document wake 不存在：{wake_id}")
            if wake["state"] not in expected:
                raise LedgerError("WAKE_STATE_CONFLICT", "document wake state 已变化")
            connection.execute(
                "UPDATE tdocs_subscription_wakes SET state=? WHERE wake_id=?",
                (next_state, wake_id),
            )
            updated = connection.execute(
                "SELECT * FROM tdocs_subscription_wakes WHERE wake_id=?", (wake_id,)
            ).fetchone()
        return dict(updated)

    def health(self) -> dict[str, Any]:
        connection = self.ledger._connect()
        try:
            counts = {
                "monitor_count": connection.execute("SELECT COUNT(*) FROM tdocs_monitors").fetchone()[0],
                "active_monitor_count": connection.execute(
                    "SELECT COUNT(*) FROM tdocs_monitors WHERE state='active'"
                ).fetchone()[0],
                "subscription_count": connection.execute(
                    "SELECT COUNT(*) FROM tdocs_monitor_subscriptions"
                ).fetchone()[0],
                "pending_batch_count": connection.execute(
                    "SELECT COUNT(*) FROM tdocs_batch_deliveries WHERE state='PENDING'"
                ).fetchone()[0],
                "active_wake_count": connection.execute(
                    "SELECT COUNT(*) FROM tdocs_subscription_wakes WHERE state IN ('prepared','submitted','unknown')"
                ).fetchone()[0],
                "failed_monitor_count": connection.execute(
                    "SELECT COUNT(*) FROM tdocs_monitors WHERE consecutive_failures>0"
                ).fetchone()[0],
            }
        finally:
            connection.close()
        return counts


class TencentDocsMonitorService:
    def __init__(
        self,
        store: DocumentMonitorStore,
        client: TencentDocsMcpClient,
        policy_verifier: PrivateBindingDocumentMonitorVerifier,
    ) -> None:
        self.store = store
        self.client = client
        self.policy_verifier = policy_verifier

    async def create_monitor(
        self,
        resource_kind: str,
        resource_key: str,
        poll_tool: str,
        poll_arguments: dict[str, Any],
        policy_ref: str,
        *,
        monitor_id: str | None = None,
    ) -> dict[str, Any]:
        self.policy_verifier.verify(
            resource_kind,
            resource_key,
            poll_tool,
            poll_arguments,
            policy_ref,
        )
        fingerprint, summary = await self._snapshot(poll_tool, poll_arguments)
        return self.store.register_monitor(
            resource_kind,
            resource_key,
            poll_tool,
            poll_arguments,
            fingerprint,
            summary,
            policy_ref=policy_ref,
            monitor_id=monitor_id,
        )

    async def poll_one(self, monitor_id: str) -> dict[str, Any]:
        monitor = self.store.get_monitor(monitor_id, private=True)
        if monitor["state"] != "active":
            return {"monitor_id": monitor_id, "status": "skipped", "reason": "MONITOR_NOT_ACTIVE"}
        try:
            self.policy_verifier.verify_stored(monitor)
            fingerprint, summary = await self._snapshot(
                monitor["poll_tool"], monitor["poll_arguments"]
            )
        except Exception as error:
            if hasattr(error, "code"):
                code = str(error.code)
            elif isinstance(error, httpx.HTTPError):
                code = "OFFICIAL_TRANSPORT_ERROR"
            else:
                code = "DOCUMENT_MONITOR_POLL_FAILED"
            self.store.record_poll_failure(monitor_id, str(code))
            promoted = self.store.promote_ready()
            return {
                "monitor_id": monitor_id,
                "status": "failed",
                "error_code": str(code),
                "error_type": type(error).__name__,
                "baseline_advanced": False,
                "promoted_batch_ids": promoted,
            }
        result = self.store.record_poll_success(monitor_id, fingerprint, summary)
        return {"status": "ok", "baseline_advanced": True, **result}

    async def poll_all(self) -> dict[str, Any]:
        results = []
        for monitor in self.store.list_monitors("active"):
            results.append(await self.poll_one(monitor["monitor_id"]))
        promoted = list(
            dict.fromkeys(
                batch_id
                for result in results
                for batch_id in result.get("promoted_batch_ids", [])
            )
        )
        promoted.extend(
            batch_id
            for batch_id in self.store.promote_ready()
            if batch_id not in promoted
        )
        return {
            "monitor_count": len(results),
            "succeeded": sum(result["status"] == "ok" for result in results),
            "failed": sum(result["status"] == "failed" for result in results),
            "promoted_batch_ids": promoted,
            "results": results,
        }

    async def _snapshot(
        self, poll_tool: str, poll_arguments: dict[str, Any]
    ) -> tuple[str, dict[str, Any]]:
        catalog = await self.client.tool_catalog()
        tool = next((item for item in catalog if item.get("name") == poll_tool), None)
        if tool is None:
            raise LedgerError("OFFICIAL_TOOL_NOT_FOUND", f"官方工具不存在：{poll_tool}")
        if classify_tool(tool) != "read_only":
            raise LedgerError(
                "DOCUMENT_POLL_TOOL_NOT_READ_ONLY",
                f"监视只允许当前官方目录中的只读工具：{poll_tool}",
            )
        schema = tool.get("inputSchema") or {}
        missing = [
            name
            for name in schema.get("required", [])
            if name not in poll_arguments
        ]
        if missing:
            raise LedgerError(
                "DOCUMENT_POLL_ARGUMENTS_MISSING",
                f"官方工具缺少参数：{','.join(missing)}",
            )
        response = await self.client.call_tool(poll_tool, poll_arguments)
        if response.get("error"):
            raise LedgerError("OFFICIAL_JSONRPC_ERROR", "官方 MCP 返回 JSON-RPC error")
        result = response.get("result")
        if not isinstance(result, dict):
            raise LedgerError("OFFICIAL_RESULT_INCOMPLETE", "官方 MCP 缺少结构化 result")
        if result.get("isError") is True:
            raise LedgerError("OFFICIAL_TOOL_IS_ERROR", "官方工具返回 isError=true")
        payload = _extract_payload(result)
        if _is_incomplete(payload):
            raise LedgerError(
                "OFFICIAL_RESULT_INCOMPLETE",
                "官方工具返回分页未完成标记，baseline 未推进",
            )
        normalized = _without_transport_metadata(payload)
        return payload_sha256(normalized), _snapshot_summary(normalized)


def _extract_payload(result: dict[str, Any]) -> Any:
    if "structuredContent" in result:
        return result["structuredContent"]
    extracted: list[Any] = []
    for block in result.get("content") or []:
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        text = block.get("text")
        if not isinstance(text, str):
            continue
        try:
            extracted.append(json.loads(text))
        except json.JSONDecodeError:
            extracted.append(text)
    if not extracted:
        raise LedgerError("OFFICIAL_RESULT_INCOMPLETE", "官方工具结果没有可读取内容")
    return extracted[0] if len(extracted) == 1 else extracted


def _without_transport_metadata(value: Any) -> Any:
    volatile = {"trace_id", "traceid", "request_id", "requestid"}
    if isinstance(value, dict):
        return {
            key: _without_transport_metadata(item)
            for key, item in value.items()
            if key.casefold() not in volatile
        }
    if isinstance(value, list):
        return [_without_transport_metadata(item) for item in value]
    return value


def _is_incomplete(value: Any) -> bool:
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = key.replace("_", "").casefold()
            if normalized in {"hasnext", "hasmore"} and item is True:
                return True
            if normalized in {"nextpagetoken", "nextcursor"} and item not in {None, ""}:
                return True
            if _is_incomplete(item):
                return True
    elif isinstance(value, list):
        return any(_is_incomplete(item) for item in value)
    return False


def _snapshot_summary(value: Any) -> dict[str, Any]:
    object_count = 0
    array_count = 0
    array_items = 0

    def walk(item: Any) -> None:
        nonlocal object_count, array_count, array_items
        if isinstance(item, dict):
            object_count += 1
            for child in item.values():
                walk(child)
        elif isinstance(item, list):
            array_count += 1
            array_items += len(item)
            for child in item:
                walk(child)

    walk(value)
    return {
        "payload_type": type(value).__name__,
        "top_level_keys": sorted(value.keys())[:50] if isinstance(value, dict) else [],
        "object_count": object_count,
        "array_count": array_count,
        "array_items": array_items,
    }
