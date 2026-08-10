from __future__ import annotations

import hashlib
import sqlite3
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .db_observer import DbObserver
from .ledger import LedgerError
from .route_verifier import VerifiedRoute


class AttachmentDatabaseVerificationError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class WechatAttachmentDatabaseVerifier:
    def __init__(
        self,
        decrypted_dir: str | Path,
        refresh_decrypted: Callable[[], None],
        *,
        timeout_seconds: float = 20.0,
        poll_interval_seconds: float = 1.0,
    ) -> None:
        self.decrypted_dir = Path(decrypted_dir)
        self.refresh_decrypted = refresh_decrypted
        self.timeout_seconds = timeout_seconds
        self.poll_interval_seconds = poll_interval_seconds

    def _database(self) -> Path:
        return self.decrypted_dir / "message" / "message_0.db"

    def baseline(self, route: VerifiedRoute) -> int:
        try:
            self.refresh_decrypted()
        except Exception as error:
            raise AttachmentDatabaseVerificationError(
                "ATTACHMENT_DATABASE_REFRESH_FAILED",
                "无法在附件发送前刷新微信数据库 baseline",
            ) from error
        database = self._database()
        connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
        try:
            row = connection.execute(
                f"SELECT COALESCE(MAX(local_id),0) FROM [{DbObserver._msg_table_name(route.username)}]"
            ).fetchone()
        except sqlite3.OperationalError as error:
            raise AttachmentDatabaseVerificationError(
                "ATTACHMENT_OUTBOUND_MESSAGE_TABLE",
                "目标 route 的消息表不可用",
            ) from error
        finally:
            connection.close()
        return int(row[0])

    @staticmethod
    def _message_xml(content: str) -> ET.Element | None:
        normalized = content.strip()
        if not normalized.startswith("<") and ":\n<" in normalized:
            normalized = normalized.split("\n", 1)[1]
        if not normalized.startswith("<"):
            return None
        try:
            return ET.fromstring(normalized)
        except ET.ParseError:
            return None

    @staticmethod
    def _matches_file(root: ET.Element, payload: Mapping[str, Any]) -> bool:
        title = (root.findtext(".//appmsg/title") or "").strip()
        size = (root.findtext(".//appmsg/appattach/totallen") or "").strip()
        content_md5 = (root.findtext(".//appmsg/md5") or "").strip().lower()
        return (
            title == payload.get("file_name")
            and size == str(payload.get("byte_count"))
            and content_md5 == str(payload.get("content_md5") or "").lower()
        )

    @staticmethod
    def _matches_image(root: ET.Element, payload: Mapping[str, Any]) -> bool:
        image = root.find(".//img")
        if image is None:
            return False
        expected_size = str(payload.get("byte_count"))
        expected_md5 = str(payload.get("content_md5") or "").lower()
        pairs = (
            ((image.get("md5") or "").strip().lower(), (image.get("length") or "").strip()),
            (
                (image.get("originsourcemd5") or "").strip().lower(),
                (image.get("hdlength") or "").strip(),
            ),
        )
        return any(content_md5 == expected_md5 and size == expected_size for content_md5, size in pairs)

    def _matching_rows(
        self,
        route: VerifiedRoute,
        kind: str,
        payload: Mapping[str, Any],
        baseline_local_id: int,
    ) -> list[dict[str, Any]]:
        database = self._database()
        connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            rows = connection.execute(
                f"""
                SELECT local_id,server_id,create_time,status,origin_source,
                       message_content,WCDB_CT_message_content
                FROM [{DbObserver._msg_table_name(route.username)}]
                WHERE local_id>? AND status=2 AND origin_source=1
                ORDER BY local_id
                """,
                (baseline_local_id,),
            ).fetchall()
        finally:
            connection.close()
        matches: list[dict[str, Any]] = []
        for row in rows:
            content = DbObserver._decompress_field(
                row["message_content"], row["WCDB_CT_message_content"]
            )
            root = self._message_xml(content)
            if root is None:
                continue
            matched = (
                self._matches_file(root, payload)
                if kind == "wechat_file"
                else self._matches_image(root, payload)
            )
            if not matched or not row["server_id"]:
                continue
            matches.append(
                {
                    "route_id": route.route_id,
                    "local_id": int(row["local_id"]),
                    "server_id": str(row["server_id"]),
                    "observed_at": datetime.fromtimestamp(
                        int(row["create_time"]), timezone.utc
                    ).isoformat(),
                    "source_kind": "wechat_message_database",
                }
            )
        return matches

    def verify(
        self,
        route: VerifiedRoute,
        kind: str,
        payload: Mapping[str, Any],
        baseline_local_id: int,
    ) -> dict[str, Any]:
        if kind not in {"wechat_file", "wechat_image"}:
            raise AttachmentDatabaseVerificationError(
                "ATTACHMENT_OUTBOUND_KIND_UNSUPPORTED",
                "数据库确认仅支持文件或图片",
            )
        deadline = time.monotonic() + self.timeout_seconds
        while True:
            try:
                self.refresh_decrypted()
            except Exception as error:
                raise AttachmentDatabaseVerificationError(
                    "ATTACHMENT_DATABASE_REFRESH_FAILED",
                    "无法刷新微信数据库确认附件发送结果",
                ) from error
            matches = self._matching_rows(route, kind, payload, baseline_local_id)
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                raise AttachmentDatabaseVerificationError(
                    "ATTACHMENT_DATABASE_CONFIRMATION_AMBIGUOUS",
                    "出现多条相同附件出站记录，无法唯一确认",
                )
            if time.monotonic() >= deadline:
                raise AttachmentDatabaseVerificationError(
                    "ATTACHMENT_DATABASE_CONFIRMATION_TIMEOUT",
                    "等待微信数据库确认附件发送超时",
                )
            time.sleep(self.poll_interval_seconds)


def content_md5(path: str | Path) -> str:
    digest = hashlib.md5()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
