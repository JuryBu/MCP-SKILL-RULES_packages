from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from wechat_docs_mcp.document_changes import DocumentChangeCoalescer
from wechat_docs_mcp.ledger import EventLedger


def test_quiet_window_is_extended_but_max_batch_caps_it(tmp_path: Path) -> None:
    ledger = EventLedger(tmp_path / "events.sqlite3")
    coalescer = DocumentChangeCoalescer(ledger)
    start = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
    first = coalescer.observe("doc-private", "doc", "c1", {"fields": 1}, start)
    second = coalescer.observe("doc-private", "doc", "c2", {"fields": 2}, start + timedelta(minutes=4))
    coalescer.observe("doc-private", "doc", "c3", {"fields": 3}, start + timedelta(minutes=8))
    coalescer.observe("doc-private", "doc", "c4", {"fields": 4}, start + timedelta(minutes=12))
    third = coalescer.observe("doc-private", "doc", "c5", {"fields": 5}, start + timedelta(minutes=14))
    assert first["change_count"] == 1
    assert second["emit_after"] == (start + timedelta(minutes=9)).isoformat()
    assert third["emit_after"] == (start + timedelta(minutes=15)).isoformat()
    assert coalescer.ready(start + timedelta(minutes=14, seconds=59)) == []
    ready = coalescer.ready(start + timedelta(minutes=15))
    assert len(ready) == 1
    assert ready[0]["change_count"] == 5
    assert [item["change_fingerprint"] for item in ready[0]["changes"]] == ["c1", "c2", "c3", "c4", "c5"]


def test_duplicate_change_does_not_extend_batch(tmp_path: Path) -> None:
    ledger = EventLedger(tmp_path / "events.sqlite3")
    coalescer = DocumentChangeCoalescer(ledger)
    start = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
    first = coalescer.observe("sheet-private", "sheet", "same", {"cell_count": 1}, start)
    duplicate = coalescer.observe(
        "sheet-private",
        "sheet",
        "same",
        {"cell_count": 1},
        start + timedelta(minutes=4),
    )
    assert duplicate["inserted"] is False
    assert duplicate["change_count"] == 1
    assert duplicate["emit_after"] == first["emit_after"]


def test_change_after_due_starts_new_batch(tmp_path: Path) -> None:
    ledger = EventLedger(tmp_path / "events.sqlite3")
    coalescer = DocumentChangeCoalescer(ledger)
    start = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
    first = coalescer.observe("form-private", "form", "c1", {}, start)
    second = coalescer.observe("form-private", "form", "c2", {}, start + timedelta(minutes=6))
    ready = coalescer.ready(start + timedelta(minutes=6))
    assert ready[0]["batch_id"] == first["batch_id"]
    assert second["batch_id"] != first["batch_id"]
    emitted = coalescer.mark_emitted(first["batch_id"])
    assert emitted["state"] == "EMITTED"
