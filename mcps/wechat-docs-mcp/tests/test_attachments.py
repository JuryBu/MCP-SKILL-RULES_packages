from __future__ import annotations

import hashlib
import tempfile
from pathlib import Path

import pytest

from wechat_docs_mcp.attachments import AttachmentRegistry
from wechat_docs_mcp.ledger import EventLedger, LedgerError


@pytest.fixture()
def registry(tmp_path: Path) -> tuple[AttachmentRegistry, EventLedger, str]:
    ledger = EventLedger(tmp_path / "events.sqlite3")
    ledger.register_route(
        "route-a",
        profile="test",
        identity={"chat_name": "sanitized", "chat_type": "group", "username": "room"},
        state="active",
    )
    ledger.register_subscription(
        "route-a",
        "conversation-a",
        1,
        subscription_id="subscription-a",
        send_capability=True,
        policy_ref="test-policy",
    )
    subscription_id = "subscription-a"
    intake = tmp_path / "intake"
    upload = tmp_path / "upload"
    intake.mkdir()
    upload.mkdir()
    return AttachmentRegistry(ledger, intake, upload), ledger, subscription_id


def test_download_records_source_size_and_hash(
    registry: tuple[AttachmentRegistry, EventLedger, str],
) -> None:
    attachment_registry, ledger, subscription_id = registry
    event = ledger.ingest_event(
        "route-a",
        "file-1",
        "file",
        {"attachment_name": "sample.bin", "attachment_size": 4},
    )
    transfer = attachment_registry.prepare_download(
        subscription_id,
        event["event_id"],
        "sample.bin",
        "download-1",
    )
    materialized = attachment_registry.intake_root / "sample.bin"
    materialized.write_bytes(b"data")
    verified = attachment_registry.record_downloaded(transfer["transfer_id"], materialized)
    assert verified["source_event_id"] == event["event_id"]
    assert verified["byte_count"] == 4
    assert verified["sha256"] == hashlib.sha256(b"data").hexdigest()
    assert verified["state"] == "VERIFIED"


def test_download_rejects_event_not_delivered_to_subscription(
    registry: tuple[AttachmentRegistry, EventLedger, str],
) -> None:
    attachment_registry, ledger, _ = registry
    event = ledger.ingest_event("route-a", "file-2", "file", {"attachment_size": 1})
    with pytest.raises(LedgerError) as raised:
        attachment_registry.prepare_download("missing-sub", event["event_id"], "a.bin", "download-2")
    assert raised.value.code == "ATTACHMENT_EVENT_NOT_DELIVERED"


def test_download_rejects_path_outside_intake(
    registry: tuple[AttachmentRegistry, EventLedger, str], tmp_path: Path
) -> None:
    attachment_registry, ledger, subscription_id = registry
    event = ledger.ingest_event("route-a", "file-3", "file", {"attachment_size": 1})
    transfer = attachment_registry.prepare_download(
        subscription_id, event["event_id"], "a.bin", "download-3"
    )
    outside = tmp_path.parent / "outside.bin"
    outside.write_bytes(b"x")
    try:
        with pytest.raises(LedgerError) as raised:
            attachment_registry.record_downloaded(transfer["transfer_id"], outside)
        assert raised.value.code == "INTAKE_PATH_NOT_ALLOWED"
    finally:
        outside.unlink(missing_ok=True)


def test_upload_manifest_is_verified_and_deduplicated(
    registry: tuple[AttachmentRegistry, EventLedger, str]
) -> None:
    attachment_registry, _, subscription_id = registry
    source = attachment_registry.upload_root / "upload.txt"
    source.write_text("safe", encoding="utf-8")
    transfer = attachment_registry.prepare_upload(subscription_id, "route-a", source, "upload-1")
    assert transfer["state"] == "VERIFIED"
    assert transfer["byte_count"] == 4
    with pytest.raises(LedgerError) as raised:
        attachment_registry.prepare_upload(subscription_id, "route-a", source, "upload-1")
    assert raised.value.code == "DEDUPE_KEY_CONFLICT"
