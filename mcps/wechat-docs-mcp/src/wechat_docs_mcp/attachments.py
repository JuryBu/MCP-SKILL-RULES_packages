from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import shutil
import time
import sqlite3
import struct
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

from .ledger import EventLedger, LedgerError, utc_now


ATTACHMENT_MATERIALIZATION_TTL_SECONDS = 24 * 60 * 60


def _safe_file_name(value: str) -> str:
    name = Path(value).name.strip()
    if not name or name in {".", ".."} or name != value.strip():
        raise LedgerError("INVALID_FILE_NAME", "file_name 必须是单个文件名")
    return name


def _digest(path: Path, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256(path: Path) -> str:
    return _digest(path, "sha256")


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _jpeg_dimensions(data: bytes) -> tuple[int | None, int | None]:
    offset = 2
    while offset + 9 <= len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        marker = data[offset + 1]
        offset += 2
        if marker in {0xD8, 0xD9}:
            continue
        if offset + 2 > len(data):
            break
        segment_length = int.from_bytes(data[offset : offset + 2], "big")
        if segment_length < 2 or offset + segment_length > len(data):
            break
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            height = int.from_bytes(data[offset + 3 : offset + 5], "big")
            width = int.from_bytes(data[offset + 5 : offset + 7], "big")
            return width, height
        offset += segment_length
    return None, None


def inspect_file(path: str | Path) -> dict[str, Any]:
    source = Path(path)
    with source.open("rb") as stream:
        head = stream.read(256 * 1024)
    mime_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
    width: int | None = None
    height: int | None = None
    suffix = source.suffix.lower()
    if head.startswith(b"%PDF-"):
        mime_type, suffix = "application/pdf", ".pdf"
    elif head.startswith(b"\x89PNG\r\n\x1a\n") and len(head) >= 24:
        mime_type, suffix = "image/png", ".png"
        width, height = struct.unpack(">II", head[16:24])
    elif (head.startswith(b"GIF87a") or head.startswith(b"GIF89a")) and len(head) >= 10:
        mime_type, suffix = "image/gif", ".gif"
        width, height = struct.unpack("<HH", head[6:10])
    elif head.startswith(b"\xff\xd8\xff"):
        mime_type, suffix = "image/jpeg", ".jpg"
        width, height = _jpeg_dimensions(head)
    elif head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        mime_type, suffix = "image/webp", ".webp"
        if head[12:16] == b"VP8X" and len(head) >= 30:
            width = 1 + int.from_bytes(head[24:27], "little")
            height = 1 + int.from_bytes(head[27:30], "little")
    return {
        "mime_type": mime_type,
        "width": width,
        "height": height,
        "suffix": suffix,
    }


class AttachmentMaterializer(Protocol):
    def materialize(self, attachment: Mapping[str, Any], destination: Path) -> str: ...


class AttachmentRegistry:
    def __init__(self, ledger: EventLedger, intake_root: str | Path, upload_root: str | Path) -> None:
        self.ledger = ledger
        self.intake_root = Path(intake_root).resolve()
        self.upload_root = Path(upload_root).resolve()

    def _attachment_for_delivery(
        self,
        subscription_id: str,
        event_id: str,
        attachment_ref: str = "",
    ) -> dict[str, Any]:
        connection = self.ledger._connect()
        try:
            rows = connection.execute(
                """
                SELECT attachments.*,events.event_type,events.payload_json,events.source_fingerprint,
                       events.observed_at,
                       event_deliveries.state AS delivery_state
                FROM event_deliveries
                JOIN events USING(event_id)
                JOIN attachments ON attachments.event_id=events.event_id
                WHERE event_deliveries.subscription_id=? AND events.event_id=?
                """,
                (subscription_id, event_id),
            ).fetchall()
        finally:
            connection.close()
        if not rows:
            raise LedgerError("ATTACHMENT_EVENT_NOT_DELIVERED", "附件事件未投递给当前 subscription")
        if attachment_ref:
            matches = [row for row in rows if row["attachment_ref"] == attachment_ref]
            if len(matches) != 1:
                raise LedgerError("ATTACHMENT_REF_MISMATCH", "attachment_ref 与事件不匹配")
            row = matches[0]
        else:
            if len(rows) != 1:
                raise LedgerError(
                    "ATTACHMENT_REF_REQUIRED",
                    "事件包含多个附件时必须显式指定 attachment_ref",
                )
            row = rows[0]
        return {**dict(row), "payload": json.loads(row["payload_json"])}

    def attachment_for_ref(self, subscription_id: str, attachment_ref: str) -> dict[str, Any]:
        if not attachment_ref.strip():
            raise LedgerError("ATTACHMENT_REF_REQUIRED", "attachment_ref 不能为空")
        connection = self.ledger._connect()
        try:
            rows = connection.execute(
                """
                SELECT attachments.*,events.event_type,events.payload_json,
                       events.source_fingerprint,events.observed_at,
                       event_deliveries.state AS delivery_state
                FROM event_deliveries
                JOIN events USING(event_id)
                JOIN attachments ON attachments.event_id=events.event_id
                WHERE event_deliveries.subscription_id=?
                  AND attachments.attachment_ref=?
                """,
                (subscription_id, attachment_ref),
            ).fetchall()
        finally:
            connection.close()
        if len(rows) != 1:
            raise LedgerError(
                "ATTACHMENT_REF_NOT_DELIVERED",
                "attachment_ref 未投递给当前 subscription 或无法唯一确认",
            )
        return {**dict(rows[0]), "payload": json.loads(rows[0]["payload_json"])}

    def _verified_download(self, subscription_id: str, attachment_ref: str) -> dict[str, Any] | None:
        connection = self.ledger._connect()
        try:
            rows = connection.execute(
                """
                SELECT * FROM attachment_transfers
                WHERE direction='download' AND state='VERIFIED'
                  AND subscription_id=? AND attachment_ref=?
                ORDER BY created_at DESC
                """,
                (subscription_id, attachment_ref),
            ).fetchall()
        finally:
            connection.close()
        for row in rows:
            transfer = dict(row)
            local_path = transfer.get("local_path")
            if not isinstance(local_path, str):
                continue
            path = Path(local_path).resolve()
            if not path.is_file() or not _inside(path, self.intake_root):
                continue
            if transfer.get("byte_count") != path.stat().st_size:
                continue
            if transfer.get("sha256") != _sha256(path):
                continue
            return transfer
        return None

    def cleanup_expired(
        self,
        max_age_seconds: int = ATTACHMENT_MATERIALIZATION_TTL_SECONDS,
    ) -> dict[str, int]:
        threshold = time.time() - max_age_seconds
        read_root = self.intake_root / "read"
        removed_files = 0
        removed_partials = 0
        if read_root.is_dir():
            for path in sorted(read_root.rglob("*"), reverse=True):
                if path.is_file() and path.stat().st_mtime < threshold:
                    is_partial = path.name.startswith(".") and path.name.endswith(".partial")
                    path.unlink()
                    removed_partials += int(is_partial)
                    removed_files += int(not is_partial)
                elif path.is_dir():
                    try:
                        path.rmdir()
                    except OSError:
                        pass
        return {"materialized_files": removed_files, "partial_files": removed_partials}

    def _next_read_dedupe_key(self, subscription_id: str, attachment_ref: str) -> str:
        base = f"read-attachment:v1:{subscription_id}:{attachment_ref}"
        connection = self.ledger._connect()
        try:
            rows = connection.execute(
                """
                SELECT dedupe_key FROM attachment_transfers
                WHERE direction='download' AND subscription_id=? AND attachment_ref=?
                  AND dedupe_key IS NOT NULL
                """,
                (subscription_id, attachment_ref),
            ).fetchall()
        finally:
            connection.close()
        used = {str(row["dedupe_key"]) for row in rows}
        if base not in used:
            return base
        attempt = 2
        while f"{base}:attempt:{attempt}" in used:
            attempt += 1
        return f"{base}:attempt:{attempt}"

    def ensure_downloaded(
        self,
        subscription_id: str,
        attachment_ref: str,
        materializer: AttachmentMaterializer,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        attachment = self.attachment_for_ref(subscription_id, attachment_ref)
        existing = self._verified_download(subscription_id, attachment_ref)
        if existing is not None:
            return attachment, existing
        destination = self.intake_root / "read" / hashlib.sha256(
            subscription_id.encode("utf-8")
        ).hexdigest()[:16]
        transfer = self.download(
            subscription_id,
            str(attachment["event_id"]),
            attachment_ref,
            str(destination),
            self._next_read_dedupe_key(subscription_id, attachment_ref),
            materializer,
        )
        return attachment, transfer

    def prepare_download(
        self,
        subscription_id: str,
        event_id: str,
        file_name: str,
        dedupe_key: str,
        attachment_ref: str = "",
    ) -> dict[str, Any]:
        if not dedupe_key.strip():
            raise LedgerError("DEDUPE_KEY_REQUIRED", "dedupe_key 不能为空")
        attachment = self._attachment_for_delivery(subscription_id, event_id, attachment_ref)
        expected_md5 = str(attachment.get("content_md5") or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{32}", expected_md5):
            raise LedgerError(
                "ATTACHMENT_INTEGRITY_METADATA_REQUIRED",
                "附件缺少可验证的 MD5，不能标记为原件",
            )
        requested_name = file_name.strip() or str(attachment.get("file_name") or "")
        safe_name = _safe_file_name(requested_name)
        expected_name = attachment.get("file_name")
        if isinstance(expected_name, str) and expected_name.strip():
            if _safe_file_name(expected_name) != safe_name:
                raise LedgerError("ATTACHMENT_NAME_MISMATCH", "请求文件名与消息元数据不一致")
        transfer_id = str(uuid.uuid4())
        now = utc_now()
        try:
            with self.ledger._transaction() as connection:
                connection.execute(
                    """
                    INSERT INTO attachment_transfers(
                      transfer_id,direction,route_id,source_event_id,file_name,byte_count,content_md5,
                      state,dedupe_key,created_at,updated_at,subscription_id,attachment_ref
                    ) VALUES(?,'download',?,?,?,?,?,'PREPARED',?,?,?,?,?)
                    """,
                    (
                        transfer_id,
                        attachment["route_id"],
                        event_id,
                        safe_name,
                        attachment.get("byte_count"),
                        expected_md5,
                        dedupe_key,
                        now,
                        now,
                        subscription_id,
                        attachment["attachment_ref"],
                    ),
                )
        except sqlite3.IntegrityError as error:
            raise LedgerError("DEDUPE_KEY_CONFLICT", "dedupe_key 已被使用") from error
        return self.get(transfer_id)

    def prepare_upload(
        self,
        subscription_id: str,
        route_id: str,
        path: str | Path,
        dedupe_key: str,
    ) -> dict[str, Any]:
        if not dedupe_key.strip():
            raise LedgerError("DEDUPE_KEY_REQUIRED", "dedupe_key 不能为空")
        source = Path(path).resolve()
        if not source.is_file() or not _inside(source, self.upload_root):
            raise LedgerError("UPLOAD_PATH_NOT_ALLOWED", "上传文件必须位于允许的 upload root 内")
        transfer_id = str(uuid.uuid4())
        now = utc_now()
        inspected = inspect_file(source)
        try:
            with self.ledger._transaction() as connection:
                route = connection.execute("SELECT state FROM routes WHERE route_id=?", (route_id,)).fetchone()
                if route is None or route["state"] != "active":
                    raise LedgerError("ROUTE_NOT_ACTIVE", "route 未处于 active")
                subscription = connection.execute(
                    "SELECT route_id,state,send_capability FROM subscriptions WHERE subscription_id=?",
                    (subscription_id,),
                ).fetchone()
                if subscription is None or subscription["route_id"] != route_id:
                    raise LedgerError("SUBSCRIPTION_ROUTE_MISMATCH", "subscription 不属于目标 route")
                if subscription["state"] != "active" or not subscription["send_capability"]:
                    raise LedgerError("SUBSCRIPTION_SEND_DISABLED", "subscription 未启用发送能力")
                connection.execute(
                    """
                    INSERT INTO attachment_transfers(
                      transfer_id,direction,route_id,file_name,byte_count,sha256,local_path,
                      state,dedupe_key,created_at,updated_at,subscription_id,mime_type,width,height,
                      content_md5
                    ) VALUES(?,'upload',?,?,?,?,?,'PREPARED',?,?,?,?,?,?,?,?)
                    """,
                    (
                        transfer_id,
                        route_id,
                        source.name,
                        source.stat().st_size,
                        _sha256(source),
                        str(source),
                        dedupe_key,
                        now,
                        now,
                        subscription_id,
                        inspected["mime_type"],
                        inspected["width"],
                        inspected["height"],
                        _digest(source, "md5"),
                    ),
                )
        except sqlite3.IntegrityError as error:
            raise LedgerError("DEDUPE_KEY_CONFLICT", "dedupe_key 已被使用") from error
        return self.get(transfer_id)

    def prepare_upload_draft(
        self,
        subscription_id: str,
        route_id: str,
        path: str | Path,
        dedupe_key: str,
        capability: str,
        expires_at: str,
    ) -> dict[str, Any]:
        if capability not in {"file", "image"}:
            raise LedgerError("ATTACHMENT_CAPABILITY_INVALID", "附件 capability 必须是 file 或 image")
        if not dedupe_key.strip():
            raise LedgerError("DEDUPE_KEY_REQUIRED", "dedupe_key 不能为空")
        source = Path(path).resolve()
        if not source.is_file() or not _inside(source, self.upload_root):
            raise LedgerError("UPLOAD_PATH_NOT_ALLOWED", "上传文件必须位于允许的 upload root 内")
        inspected = inspect_file(source)
        transfer = {
            "transfer_id": str(uuid.uuid4()),
            "file_name": source.name,
            "byte_count": source.stat().st_size,
            "sha256": _sha256(source),
            "content_md5": _digest(source, "md5"),
            "local_path": str(source),
            "mime_type": inspected["mime_type"],
            "width": inspected["width"],
            "height": inspected["height"],
        }
        payload = {
            "transfer_id": transfer["transfer_id"],
            "file_name": transfer["file_name"],
            "byte_count": transfer["byte_count"],
            "sha256": transfer["sha256"],
            "content_md5": transfer["content_md5"],
            "local_path": transfer["local_path"],
            "mime_type": transfer["mime_type"],
            "width": transfer["width"],
            "height": transfer["height"],
        }
        draft = self.ledger.prepare_attachment_upload_draft(
            subscription_id,
            route_id,
            f"wechat_{capability}",
            payload,
            expires_at,
            transfer,
            dedupe_key,
        )
        return {
            "transfer": self.get(transfer["transfer_id"]),
            "draft": {**draft, "payload": payload},
        }

    def _destination_directory(self, value: str | Path | None) -> Path:
        destination = Path(value).resolve() if value else self.intake_root / "downloads"
        if not _inside(destination, self.intake_root):
            raise LedgerError("INTAKE_PATH_NOT_ALLOWED", "目标目录必须位于任务 intake root 内")
        destination.mkdir(parents=True, exist_ok=True)
        return destination

    @staticmethod
    def _copy_without_overwrite(source: Path, directory: Path, file_name: str) -> Path:
        base = Path(_safe_file_name(file_name))
        for index in range(1000):
            candidate = directory / (
                base.name if index == 0 else f"{base.stem} ({index}){base.suffix}"
            )
            try:
                with candidate.open("xb") as target, source.open("rb") as stream:
                    shutil.copyfileobj(stream, target, 1024 * 1024)
                    target.flush()
                    os.fsync(target.fileno())
                return candidate
            except FileExistsError:
                continue
            except Exception:
                candidate.unlink(missing_ok=True)
                raise
        raise LedgerError("ATTACHMENT_NAME_EXHAUSTED", "目标目录存在过多同名文件")

    def download(
        self,
        subscription_id: str,
        event_id: str,
        attachment_ref: str,
        destination_dir: str,
        dedupe_key: str,
        materializer: AttachmentMaterializer,
    ) -> dict[str, Any]:
        attachment = self._attachment_for_delivery(subscription_id, event_id, attachment_ref)
        prepared = self.prepare_download(
            subscription_id,
            event_id,
            str(attachment.get("file_name") or f"{attachment['kind']}-{event_id[:8]}"),
            dedupe_key,
            attachment_ref,
        )
        directory = self._destination_directory(destination_dir or None)
        partial = directory / f".{prepared['transfer_id']}.partial"
        try:
            source_kind = materializer.materialize(attachment, partial)
            if not partial.is_file():
                raise LedgerError("ATTACHMENT_NOT_MATERIALIZED", "底层适配器没有产生附件实体")
            actual_size = partial.stat().st_size
            is_preview = source_kind == "wechat_v2_image_preview"
            expected_size = attachment.get("byte_count")
            if not is_preview and expected_size is not None and int(expected_size) != actual_size:
                raise LedgerError("ATTACHMENT_SIZE_MISMATCH", "附件字节数与消息元数据不一致")
            expected_md5 = str(attachment.get("content_md5") or "").lower()
            if not is_preview and expected_md5 and _digest(partial, "md5") != expected_md5:
                raise LedgerError("ATTACHMENT_MD5_MISMATCH", "附件 MD5 与消息元数据不一致")
            inspected = inspect_file(partial)
            name = str(attachment.get("file_name") or prepared["file_name"])
            if not Path(name).suffix and inspected["suffix"]:
                name += inspected["suffix"]
            final_path = self._copy_without_overwrite(partial, directory, name)
            return self.record_downloaded(
                prepared["transfer_id"],
                final_path,
                source_kind=source_kind,
            )
        except Exception as error:
            with self.ledger._transaction() as connection:
                connection.execute(
                    """
                    UPDATE attachment_transfers
                    SET state='FAILED',result_json=?,updated_at=?
                    WHERE transfer_id=? AND state='PREPARED'
                    """,
                    (
                        json.dumps({"error_code": getattr(error, "code", type(error).__name__)}, sort_keys=True),
                        utc_now(),
                        prepared["transfer_id"],
                    ),
                )
            raise
        finally:
            partial.unlink(missing_ok=True)

    def record_downloaded(
        self,
        transfer_id: str,
        path: str | Path,
        *,
        source_kind: str = "external_adapter",
    ) -> dict[str, Any]:
        materialized = Path(path).resolve()
        if not materialized.is_file() or not _inside(materialized, self.intake_root):
            raise LedgerError("INTAKE_PATH_NOT_ALLOWED", "下载文件必须位于任务 intake root 内")
        size = materialized.stat().st_size
        digest = _sha256(materialized)
        inspected = inspect_file(materialized)
        is_preview = source_kind == "wechat_v2_image_preview"
        failure: LedgerError | None = None
        with self.ledger._transaction() as connection:
            transfer = connection.execute(
                "SELECT * FROM attachment_transfers WHERE transfer_id=?", (transfer_id,)
            ).fetchone()
            if transfer is None:
                raise LedgerError("ATTACHMENT_TRANSFER_NOT_FOUND", "attachment transfer 不存在")
            if transfer["direction"] != "download" or transfer["state"] != "PREPARED":
                raise LedgerError("ATTACHMENT_TRANSFER_STATE", "attachment transfer 状态不允许落盘确认")
            expected_md5 = str(transfer["content_md5"] or "").strip().lower()
            if not is_preview and not re.fullmatch(r"[0-9a-f]{32}", expected_md5):
                connection.execute(
                    """
                    UPDATE attachment_transfers SET state='FAILED',result_json=?,updated_at=?
                    WHERE transfer_id=?
                    """,
                    (
                        json.dumps({"error_code": "ATTACHMENT_INTEGRITY_METADATA_REQUIRED"}),
                        utc_now(),
                        transfer_id,
                    ),
                )
                failure = LedgerError(
                    "ATTACHMENT_INTEGRITY_METADATA_REQUIRED",
                    "附件缺少可验证的 MD5，不能标记为原件",
                )
            elif not is_preview and transfer["byte_count"] is not None and transfer["byte_count"] != size:
                connection.execute(
                    """
                    UPDATE attachment_transfers SET state='FAILED',result_json=?,updated_at=?
                    WHERE transfer_id=?
                    """,
                    (json.dumps({"error_code": "ATTACHMENT_SIZE_MISMATCH"}), utc_now(), transfer_id),
                )
                failure = LedgerError(
                    "ATTACHMENT_SIZE_MISMATCH",
                    "下载文件字节数与消息元数据不一致",
                )
            else:
                if not is_preview and _digest(materialized, "md5") != expected_md5:
                    connection.execute(
                        """
                        UPDATE attachment_transfers SET state='FAILED',result_json=?,updated_at=?
                        WHERE transfer_id=?
                        """,
                        (
                            json.dumps({"error_code": "ATTACHMENT_MD5_MISMATCH"}),
                            utc_now(),
                            transfer_id,
                        ),
                    )
                    failure = LedgerError(
                        "ATTACHMENT_MD5_MISMATCH",
                        "下载文件 MD5 与消息元数据不一致",
                    )
                else:
                    result = {
                        "materialized": True,
                        "mime_type": inspected["mime_type"],
                        "width": inspected["width"],
                        "height": inspected["height"],
                        "quality": "preview" if is_preview else "original",
                        "matches_event_original": not is_preview,
                    }
                    connection.execute(
                        """
                        UPDATE attachment_transfers
                        SET byte_count=?,sha256=?,local_path=?,state='VERIFIED',mime_type=?,
                            width=?,height=?,source_kind=?,result_json=?,updated_at=?
                        WHERE transfer_id=?
                        """,
                        (
                            size,
                            digest,
                            str(materialized),
                            inspected["mime_type"],
                            inspected["width"],
                            inspected["height"],
                            source_kind,
                            json.dumps(result, sort_keys=True),
                            utc_now(),
                            transfer_id,
                        ),
                    )
        if failure is not None:
            raise failure
        return self.get(transfer_id)

    def get(self, transfer_id: str) -> dict[str, Any]:
        connection = self.ledger._connect()
        try:
            row = connection.execute(
                "SELECT * FROM attachment_transfers WHERE transfer_id=?", (transfer_id,)
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise LedgerError("ATTACHMENT_TRANSFER_NOT_FOUND", "attachment transfer 不存在")
        return dict(row)


def file_manifest(path: str | Path) -> dict[str, Any]:
    source = Path(path)
    if not source.is_file():
        raise FileNotFoundError(source)
    return {
        "file_name": source.name,
        "byte_count": os.path.getsize(source),
        "sha256": _sha256(source),
        **{key: value for key, value in inspect_file(source).items() if key != "suffix"},
    }
