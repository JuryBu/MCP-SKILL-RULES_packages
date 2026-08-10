from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import uuid
from pathlib import Path
from typing import Any

from .ledger import EventLedger, LedgerError, utc_now


def _safe_file_name(value: str) -> str:
    name = Path(value).name.strip()
    if not name or name in {".", ".."} or name != value.strip():
        raise LedgerError("INVALID_FILE_NAME", "file_name 必须是单个文件名")
    return name


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


class AttachmentRegistry:
    def __init__(self, ledger: EventLedger, intake_root: str | Path, upload_root: str | Path) -> None:
        self.ledger = ledger
        self.intake_root = Path(intake_root)
        self.upload_root = Path(upload_root)

    def prepare_download(
        self,
        subscription_id: str,
        event_id: str,
        file_name: str,
        dedupe_key: str,
    ) -> dict[str, Any]:
        if not dedupe_key.strip():
            raise LedgerError("DEDUPE_KEY_REQUIRED", "dedupe_key 不能为空")
        safe_name = _safe_file_name(file_name)
        transfer_id = str(uuid.uuid4())
        now = utc_now()
        try:
            with self.ledger._transaction() as connection:
                row = connection.execute(
                    """
                    SELECT events.route_id,events.event_type,events.payload_json
                    FROM event_deliveries
                    JOIN events USING(event_id)
                    WHERE event_deliveries.subscription_id=? AND events.event_id=?
                    """,
                    (subscription_id, event_id),
                ).fetchone()
                if row is None:
                    raise LedgerError("ATTACHMENT_EVENT_NOT_DELIVERED", "事件未投递给当前 subscription")
                if row["event_type"] not in {"file", "image", "sticker"}:
                    raise LedgerError("ATTACHMENT_EVENT_TYPE", "事件不是可按需下载的附件类型")
                payload = json.loads(row["payload_json"])
                expected_name = payload.get("attachment_name")
                if isinstance(expected_name, str) and expected_name.strip():
                    if _safe_file_name(expected_name) != safe_name:
                        raise LedgerError("ATTACHMENT_NAME_MISMATCH", "请求文件名与消息元数据不一致")
                expected_size = payload.get("attachment_size")
                connection.execute(
                    """
                    INSERT INTO attachment_transfers(
                      transfer_id,direction,route_id,source_event_id,file_name,byte_count,
                      state,dedupe_key,created_at,updated_at
                    ) VALUES(?,'download',?,?,?,?, 'PREPARED',?,?,?)
                    """,
                    (
                        transfer_id,
                        row["route_id"],
                        event_id,
                        safe_name,
                        expected_size if isinstance(expected_size, int) and expected_size >= 0 else None,
                        dedupe_key,
                        now,
                        now,
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
                      state,dedupe_key,created_at,updated_at
                    ) VALUES(?,'upload',?,?,?,?,?,'VERIFIED',?,?,?)
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
                    ),
                )
        except sqlite3.IntegrityError as error:
            raise LedgerError("DEDUPE_KEY_CONFLICT", "dedupe_key 已被使用") from error
        return self.get(transfer_id)

    def record_downloaded(self, transfer_id: str, path: str | Path) -> dict[str, Any]:
        materialized = Path(path).resolve()
        if not materialized.is_file() or not _inside(materialized, self.intake_root):
            raise LedgerError("INTAKE_PATH_NOT_ALLOWED", "下载文件必须位于任务 intake root 内")
        size = materialized.stat().st_size
        digest = _sha256(materialized)
        with self.ledger._transaction() as connection:
            transfer = connection.execute(
                "SELECT * FROM attachment_transfers WHERE transfer_id=?", (transfer_id,)
            ).fetchone()
            if transfer is None:
                raise LedgerError("ATTACHMENT_TRANSFER_NOT_FOUND", "attachment transfer 不存在")
            if transfer["direction"] != "download" or transfer["state"] != "PREPARED":
                raise LedgerError("ATTACHMENT_TRANSFER_STATE", "attachment transfer 状态不允许落盘确认")
            if transfer["byte_count"] is not None and transfer["byte_count"] != size:
                connection.execute(
                    "UPDATE attachment_transfers SET state='FAILED',updated_at=? WHERE transfer_id=?",
                    (utc_now(), transfer_id),
                )
                raise LedgerError("ATTACHMENT_SIZE_MISMATCH", "下载文件字节数与消息元数据不一致")
            connection.execute(
                """
                UPDATE attachment_transfers
                SET byte_count=?,sha256=?,local_path=?,state='VERIFIED',updated_at=?
                WHERE transfer_id=?
                """,
                (size, digest, str(materialized), utc_now(), transfer_id),
            )
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
    }
