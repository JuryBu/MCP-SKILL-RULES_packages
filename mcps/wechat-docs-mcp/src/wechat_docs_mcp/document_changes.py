from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from .ledger import EventLedger, LedgerError, canonical_json, utc_now


def _time(value: str | datetime | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise LedgerError("TIMEZONE_REQUIRED", "document change 时间必须包含时区")
    return parsed.astimezone(timezone.utc)


class DocumentChangeCoalescer:
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

    @staticmethod
    def document_hash(document_id: str) -> str:
        if not document_id.strip():
            raise LedgerError("DOCUMENT_ID_REQUIRED", "document_id 不能为空")
        return hashlib.sha256(document_id.encode("utf-8")).hexdigest()

    def observe(
        self,
        document_id: str,
        document_kind: str,
        change_fingerprint: str,
        summary: dict[str, Any],
        observed_at: str | datetime | None = None,
    ) -> dict[str, Any]:
        observed = _time(observed_at)
        observed_iso = observed.isoformat()
        document_id_hash = self.document_hash(document_id)
        with self.ledger._transaction() as connection:
            batch = connection.execute(
                """
                SELECT * FROM document_change_batches
                WHERE document_id_hash=? AND document_kind=? AND state='OPEN'
                """,
                (document_id_hash, document_kind),
            ).fetchone()
            if batch is not None and observed >= _time(batch["emit_after"]):
                connection.execute(
                    "UPDATE document_change_batches SET state='READY',updated_at=? WHERE batch_id=?",
                    (observed_iso, batch["batch_id"]),
                )
                batch = None
            if batch is None:
                batch_id = str(uuid.uuid4())
                emit_after = min(observed + self.quiet_window, observed + self.max_batch)
                connection.execute(
                    """
                    INSERT INTO document_change_batches(
                      batch_id,document_id_hash,document_kind,state,first_observed_at,
                      last_observed_at,emit_after,change_count,created_at,updated_at
                    ) VALUES(?,?,?,'OPEN',?,?,?,?,?,?)
                    """,
                    (
                        batch_id,
                        document_id_hash,
                        document_kind,
                        observed_iso,
                        observed_iso,
                        emit_after.isoformat(),
                        0,
                        observed_iso,
                        observed_iso,
                    ),
                )
                batch = connection.execute(
                    "SELECT * FROM document_change_batches WHERE batch_id=?", (batch_id,)
                ).fetchone()
            inserted = connection.execute(
                """
                INSERT OR IGNORE INTO document_change_items(
                  batch_id,change_fingerprint,observed_at,summary_json
                ) VALUES(?,?,?,?)
                """,
                (batch["batch_id"], change_fingerprint, observed_iso, canonical_json(summary)),
            ).rowcount
            if inserted:
                first = _time(batch["first_observed_at"])
                emit_after = min(first + self.max_batch, observed + self.quiet_window)
                connection.execute(
                    """
                    UPDATE document_change_batches
                    SET last_observed_at=?,emit_after=?,change_count=change_count+1,updated_at=?
                    WHERE batch_id=?
                    """,
                    (observed_iso, emit_after.isoformat(), observed_iso, batch["batch_id"]),
                )
            updated = connection.execute(
                "SELECT * FROM document_change_batches WHERE batch_id=?", (batch["batch_id"],)
            ).fetchone()
        return {**dict(updated), "inserted": bool(inserted)}

    def ready(self, now: str | datetime | None = None) -> list[dict[str, Any]]:
        current = _time(now).isoformat()
        with self.ledger._transaction() as connection:
            connection.execute(
                """
                UPDATE document_change_batches SET state='READY',updated_at=?
                WHERE state='OPEN' AND emit_after<=?
                """,
                (current, current),
            )
            batches = connection.execute(
                "SELECT * FROM document_change_batches WHERE state='READY' ORDER BY first_observed_at,batch_id"
            ).fetchall()
            result: list[dict[str, Any]] = []
            for batch in batches:
                items = connection.execute(
                    "SELECT change_fingerprint,observed_at,summary_json FROM document_change_items WHERE batch_id=? ORDER BY observed_at,change_fingerprint",
                    (batch["batch_id"],),
                ).fetchall()
                result.append(
                    {
                        **dict(batch),
                        "changes": [
                            {
                                "change_fingerprint": item["change_fingerprint"],
                                "observed_at": item["observed_at"],
                                "summary": json.loads(item["summary_json"]),
                            }
                            for item in items
                        ],
                    }
                )
        return result

    def mark_emitted(self, batch_id: str) -> dict[str, Any]:
        with self.ledger._transaction() as connection:
            changed = connection.execute(
                "UPDATE document_change_batches SET state='EMITTED',updated_at=? WHERE batch_id=? AND state='READY'",
                (utc_now(), batch_id),
            ).rowcount
            if changed != 1:
                raise LedgerError("DOCUMENT_BATCH_STATE", "document batch 不处于 READY")
            row = connection.execute(
                "SELECT * FROM document_change_batches WHERE batch_id=?", (batch_id,)
            ).fetchone()
        return dict(row)
