from __future__ import annotations

import base64
import hashlib
from pathlib import Path

import pytest

from wechat_docs_mcp.attachments import AttachmentRegistry
from wechat_docs_mcp.ledger import EventLedger, LedgerError


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class BytesMaterializer:
    def __init__(self, data: bytes, source_kind: str = "synthetic") -> None:
        self.data = data
        self.source_kind = source_kind

    def materialize(self, attachment: dict[str, object], destination: Path) -> str:
        destination.write_bytes(self.data)
        return self.source_kind


class FailOnceMaterializer(BytesMaterializer):
    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.calls = 0

    def materialize(self, attachment: dict[str, object], destination: Path) -> str:
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("synthetic materialization failure")
        return super().materialize(attachment, destination)


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
        {
            "attachment_name": "sample.bin",
            "attachment_size": 4,
            "attachment_md5": hashlib.md5(b"data").hexdigest(),
        },
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


def test_two_step_download_rejects_same_size_wrong_md5(
    registry: tuple[AttachmentRegistry, EventLedger, str],
) -> None:
    attachment_registry, ledger, subscription_id = registry
    event = ledger.ingest_event(
        "route-a",
        "file-md5",
        "file",
        {
            "attachment_name": "sample.bin",
            "attachment_size": 4,
            "attachment_md5": hashlib.md5(b"good").hexdigest(),
        },
    )
    transfer = attachment_registry.prepare_download(
        subscription_id,
        event["event_id"],
        "sample.bin",
        "download-md5",
    )
    materialized = attachment_registry.intake_root / "wrong.bin"
    materialized.write_bytes(b"evil")

    with pytest.raises(LedgerError) as raised:
        attachment_registry.record_downloaded(transfer["transfer_id"], materialized)

    assert raised.value.code == "ATTACHMENT_MD5_MISMATCH"
    assert attachment_registry.get(transfer["transfer_id"])["state"] == "FAILED"


def test_automatic_download_retries_after_failed_materialization(
    registry: tuple[AttachmentRegistry, EventLedger, str],
) -> None:
    attachment_registry, ledger, subscription_id = registry
    payload = b"safe"
    event = ledger.ingest_event(
        "route-a",
        "file-retry",
        "file",
        {
            "attachment_name": "retry.bin",
            "attachment_size": len(payload),
            "attachment_md5": hashlib.md5(payload).hexdigest(),
        },
    )
    attachment_ref = ledger.list_pending(subscription_id)[-1]["payload"]["attachment_ref"]
    materializer = FailOnceMaterializer(payload)

    with pytest.raises(RuntimeError):
        attachment_registry.ensure_downloaded(subscription_id, attachment_ref, materializer)
    _, transfer = attachment_registry.ensure_downloaded(
        subscription_id,
        attachment_ref,
        materializer,
    )

    assert materializer.calls == 2
    assert transfer["state"] == "VERIFIED"
    assert transfer["dedupe_key"].endswith(":attempt:2")


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
    event = ledger.ingest_event(
        "route-a",
        "file-3",
        "file",
        {"attachment_size": 1, "attachment_md5": hashlib.md5(b"x").hexdigest()},
    )
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


def test_download_requires_integrity_metadata(
    registry: tuple[AttachmentRegistry, EventLedger, str],
) -> None:
    attachment_registry, ledger, subscription_id = registry
    event = ledger.ingest_event(
        "route-a",
        "file-no-integrity",
        "file",
        {"attachment_name": "unknown.bin", "attachment_size": 4},
    )

    with pytest.raises(LedgerError) as raised:
        attachment_registry.prepare_download(
            subscription_id,
            event["event_id"],
            "unknown.bin",
            "download-no-integrity",
        )

    assert raised.value.code == "ATTACHMENT_INTEGRITY_METADATA_REQUIRED"


def test_upload_manifest_is_verified_and_deduplicated(
    registry: tuple[AttachmentRegistry, EventLedger, str]
) -> None:
    attachment_registry, _, subscription_id = registry
    source = attachment_registry.upload_root / "upload.txt"
    source.write_text("safe", encoding="utf-8")
    transfer = attachment_registry.prepare_upload(subscription_id, "route-a", source, "upload-1")
    assert transfer["state"] == "PREPARED"
    assert transfer["byte_count"] == 4
    with pytest.raises(LedgerError) as raised:
        attachment_registry.prepare_upload(subscription_id, "route-a", source, "upload-1")
    assert raised.value.code == "DEDUPE_KEY_CONFLICT"


def test_event_gets_unforgeable_attachment_ref_and_downloads_without_overwrite(
    registry: tuple[AttachmentRegistry, EventLedger, str]
) -> None:
    attachment_registry, ledger, subscription_id = registry
    event = ledger.ingest_event(
        "route-a",
        "image-1",
        "image",
        {
            "local_id": 7,
            "server_id": 99,
            "attachment_name": "sample",
            "attachment_size": len(PNG_1X1),
            "attachment_md5": hashlib.md5(PNG_1X1).hexdigest(),
        },
    )
    pending = ledger.list_pending(subscription_id)
    attachment_ref = pending[0]["payload"]["attachment_ref"]
    assert attachment_ref.startswith("att_")

    destination = attachment_registry.intake_root / "task-a"
    destination.mkdir()
    (destination / "sample.png").write_bytes(b"existing")
    downloaded = attachment_registry.download(
        subscription_id,
        event["event_id"],
        attachment_ref,
        str(destination),
        "download-image-1",
        BytesMaterializer(PNG_1X1),
    )

    assert downloaded["state"] == "VERIFIED"
    assert downloaded["mime_type"] == "image/png"
    assert downloaded["width"] == 1
    assert downloaded["height"] == 1
    assert downloaded["sha256"] == hashlib.sha256(PNG_1X1).hexdigest()
    assert Path(downloaded["local_path"]).name == "sample (1).png"
    assert (destination / "sample.png").read_bytes() == b"existing"


def test_download_rejects_forged_attachment_ref_before_materialization(
    registry: tuple[AttachmentRegistry, EventLedger, str]
) -> None:
    attachment_registry, ledger, subscription_id = registry
    event = ledger.ingest_event(
        "route-a",
        "image-2",
        "image",
        {"local_id": 8, "server_id": 100, "attachment_name": "sample.png"},
    )
    with pytest.raises(LedgerError) as raised:
        attachment_registry.download(
            subscription_id,
            event["event_id"],
            "att_forged",
            "",
            "download-image-forged",
            BytesMaterializer(PNG_1X1),
        )
    assert raised.value.code == "ATTACHMENT_REF_MISMATCH"
