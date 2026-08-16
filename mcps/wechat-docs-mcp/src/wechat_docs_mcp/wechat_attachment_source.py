from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import struct
import time
import xml.etree.ElementTree as ET
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad

from .attachments import _safe_file_name
from .db_observer import DbObserver
from .image_key_manager import (
    ImageKeyManager,
    ImageKeyMaterial,
    ImageKeyScanner,
    OWNER_SCOPE_PATTERN,
    WindowsWeixinImageKeyScanner,
)
from .ledger import EventLedger, LedgerError
from .route_verifier import PrivateBindingRouteVerifier, RouteVerificationError


ATTACHMENT_CDN_HOSTS = {"vweixinf.tc.qq.com"}
MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
IMAGE_KEY_EVENT_SCAN_WINDOW_SECONDS = 120
IMAGE_KEY_SCAN_TIMEOUT_SECONDS = 15
IMAGE_INDEX_WAIT_SECONDS = 20.0
IMAGE_INDEX_POLL_INTERVAL_SECONDS = 1.0
IMAGE_INDEX_REFRESH_INTERVAL_SECONDS = 2.0


def _md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class WechatAttachmentSourceResolver:
    def __init__(
        self,
        ledger: EventLedger,
        binding: Mapping[str, Any],
        decrypted_dir: str | Path,
        account_root: str | Path,
        image_key_file: str | Path | None = None,
        image_key_root: str | Path | None = None,
        image_key_scanner: ImageKeyScanner | None = None,
        active_owner_account_key_sha256: str | None = None,
        refresh_decrypted: Callable[[], None] | None = None,
        image_index_wait_seconds: float = IMAGE_INDEX_WAIT_SECONDS,
        image_index_poll_interval_seconds: float = IMAGE_INDEX_POLL_INTERVAL_SECONDS,
        image_index_refresh_interval_seconds: float = IMAGE_INDEX_REFRESH_INTERVAL_SECONDS,
    ) -> None:
        self.ledger = ledger
        self.binding = binding
        self.decrypted_dir = Path(decrypted_dir)
        self.account_root = Path(account_root)
        self.image_key_file = Path(image_key_file) if image_key_file else None
        key_root = (
            Path(image_key_root)
            if image_key_root is not None
            else (
                self.image_key_file.parent / "wechat-image-v2"
                if self.image_key_file
                else Path.home() / ".wechat-image-v2"
            )
        )
        self.image_key_manager = ImageKeyManager(
            key_root,
            legacy_key_file=self.image_key_file,
            scanner=image_key_scanner or WindowsWeixinImageKeyScanner(),
        )
        active_owner_scope = (active_owner_account_key_sha256 or "").strip().casefold()
        if active_owner_scope and not OWNER_SCOPE_PATTERN.fullmatch(active_owner_scope):
            raise LedgerError(
                "ATTACHMENT_IMAGE_ACTIVE_ACCOUNT_INVALID",
                "当前微信账号作用域不是有效的 SHA-256",
            )
        self.active_owner_account_key_sha256 = active_owner_scope
        self.refresh_decrypted = refresh_decrypted
        self.image_index_wait_seconds = max(0.0, float(image_index_wait_seconds))
        self.image_index_poll_interval_seconds = max(
            0.01,
            float(image_index_poll_interval_seconds),
        )
        self.image_index_refresh_interval_seconds = max(
            0.01,
            float(image_index_refresh_interval_seconds),
        )

    @staticmethod
    def _message_xml(content: str) -> ET.Element:
        normalized = content.strip()
        if not normalized.startswith("<") and ":\n<" in normalized:
            normalized = normalized.split("\n", 1)[1]
        try:
            return ET.fromstring(normalized)
        except ET.ParseError as error:
            raise LedgerError("ATTACHMENT_MESSAGE_XML", "附件消息 XML 无法解析") from error

    def _verified_identity(self, attachment: Mapping[str, Any]) -> tuple[str, str]:
        route = self.ledger.get_route(str(attachment["route_id"]))
        try:
            verified = PrivateBindingRouteVerifier(self.binding).verify_identity(
                route["route_id"],
                route,
            )
        except RouteVerificationError as error:
            raise LedgerError("ATTACHMENT_ROUTE_UNVERIFIED", str(error)) from error
        expected_fingerprint = (
            f"{verified.username}:{attachment.get('local_id')}:{attachment.get('server_id')}"
        )
        if attachment.get("source_fingerprint") != expected_fingerprint:
            raise LedgerError("ATTACHMENT_ROUTE_UNVERIFIED", "事件消息身份与 private binding 不一致")
        return verified.username, verified.owner_account_key_sha256

    def _verified_username(self, attachment: Mapping[str, Any]) -> str:
        return self._verified_identity(attachment)[0]

    def _message_content(self, attachment: Mapping[str, Any]) -> tuple[ET.Element, int]:
        username = self._verified_username(attachment)
        if attachment.get("local_id") is None or not attachment.get("server_id"):
            raise LedgerError("ATTACHMENT_MESSAGE_IDENTITY", "附件缺少精确消息身份")
        table = DbObserver._msg_table_name(username)
        path = self.decrypted_dir / "message" / "message_0.db"
        connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            rows = connection.execute(
                f"""
                SELECT local_id,server_id,local_type,create_time,message_content,WCDB_CT_message_content
                FROM [{table}]
                WHERE local_id=? AND CAST(server_id AS TEXT)=?
                """,
                (attachment["local_id"], str(attachment["server_id"])),
            ).fetchall()
        except sqlite3.OperationalError as error:
            raise LedgerError("ATTACHMENT_MESSAGE_TABLE", "授权 route 的消息表不可用") from error
        finally:
            connection.close()
        if len(rows) != 1:
            raise LedgerError("ATTACHMENT_MESSAGE_AMBIGUOUS", "无法唯一定位附件消息")
        row = rows[0]
        content = DbObserver._decompress_field(
            row["message_content"],
            row["WCDB_CT_message_content"],
        )
        return self._message_xml(content), int(row["create_time"])

    @staticmethod
    def _validate_expected(attachment: Mapping[str, Any], *, size: int, content_md5: str) -> None:
        expected_size = attachment.get("byte_count")
        if expected_size is not None and int(expected_size) != size:
            raise LedgerError("ATTACHMENT_SIZE_MISMATCH", "附件来源字节数与事件元数据不一致")
        expected_md5 = str(attachment.get("content_md5") or "").lower()
        if expected_md5 and expected_md5 != content_md5.lower():
            raise LedgerError("ATTACHMENT_MD5_MISMATCH", "附件来源 MD5 与事件元数据不一致")

    def _resolve_file(self, attachment: Mapping[str, Any], root: ET.Element, create_time: int) -> Path:
        title = (root.findtext(".//appmsg/title") or "").strip()
        size_text = (root.findtext(".//appmsg/appattach/totallen") or "0").strip()
        content_md5 = (root.findtext(".//appmsg/md5") or "").strip().lower()
        if not title or not re.fullmatch(r"[0-9a-f]{32}", content_md5):
            raise LedgerError("ATTACHMENT_FILE_METADATA", "文件消息缺少名称或 MD5")
        safe_name = _safe_file_name(title)
        try:
            size = int(size_text)
        except ValueError as error:
            raise LedgerError("ATTACHMENT_FILE_METADATA", "文件消息字节数无效") from error
        self._validate_expected(attachment, size=size, content_md5=content_md5)

        hardlink_path = self.decrypted_dir / "hardlink" / "hardlink.db"
        hardlink = sqlite3.connect(f"{hardlink_path.resolve().as_uri()}?mode=ro", uri=True)
        try:
            rows = hardlink.execute(
                """
                SELECT file_name,file_size FROM file_hardlink_info_v4
                WHERE lower(md5)=? AND file_name=? AND file_size=?
                """,
                (content_md5, safe_name, size),
            ).fetchall()
        finally:
            hardlink.close()
        if len(rows) != 1:
            raise LedgerError("ATTACHMENT_FILE_INDEX", "微信文件索引无法唯一确认附件")

        month = datetime.fromtimestamp(create_time).strftime("%Y-%m")
        expected = self.account_root / "msg" / "file" / month / safe_name
        candidates = [expected] if expected.is_file() else []
        if not candidates:
            candidates = [
                path
                for path in (self.account_root / "msg" / "file").rglob(safe_name)
                if path.is_file() and path.stat().st_size == size
            ]
        verified = [path for path in candidates if _md5(path) == content_md5]
        if len(verified) != 1:
            raise LedgerError("ATTACHMENT_FILE_ENTITY", "微信文件实体不存在或不唯一")
        return verified[0]

    def _download_sticker(self, attachment: Mapping[str, Any], root: ET.Element, destination: Path) -> None:
        emoji = root.find(".//emoji")
        if emoji is None:
            raise LedgerError("ATTACHMENT_STICKER_METADATA", "表情消息缺少 emoji 元数据")
        content_md5 = (emoji.get("md5") or "").strip().lower()
        expected_size = int(emoji.get("len") or 0)
        if not re.fullmatch(r"[0-9a-f]{32}", content_md5) or expected_size <= 0:
            raise LedgerError("ATTACHMENT_STICKER_METADATA", "表情消息 MD5 或字节数无效")
        self._validate_expected(attachment, size=expected_size, content_md5=content_md5)

        database = self.decrypted_dir / "emoticon" / "emoticon.db"
        connection = sqlite3.connect(
            f"{database.resolve().as_uri()}?mode=ro", uri=True, timeout=0.1
        )
        try:
            rows = connection.execute(
                "SELECT cdn_url FROM kNonStoreEmoticonTable WHERE lower(md5)=?",
                (content_md5,),
            ).fetchall()
        finally:
            connection.close()
        if len(rows) != 1 or not rows[0][0]:
            raise LedgerError("ATTACHMENT_STICKER_SOURCE", "表情 CDN 来源不存在或不唯一")
        url = str(rows[0][0])
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or parsed.hostname not in ATTACHMENT_CDN_HOSTS:
            raise LedgerError("ATTACHMENT_CDN_NOT_ALLOWED", "表情 CDN 主机不在允许范围")

        byte_count = 0
        digest = hashlib.md5()
        with httpx.Client(follow_redirects=False, timeout=15) as client:
            with client.stream("GET", url, headers={"User-Agent": "MicroMessenger Client"}) as response:
                if response.status_code != 200:
                    raise LedgerError("ATTACHMENT_CDN_HTTP", f"表情 CDN 返回 HTTP {response.status_code}")
                with destination.open("xb") as stream:
                    for chunk in response.iter_bytes():
                        byte_count += len(chunk)
                        if byte_count > min(MAX_ATTACHMENT_BYTES, expected_size + 1):
                            raise LedgerError("ATTACHMENT_TOO_LARGE", "表情 CDN 响应超过消息声明字节数")
                        digest.update(chunk)
                        stream.write(chunk)
                    stream.flush()
                    os.fsync(stream.fileno())
        if byte_count != expected_size or digest.hexdigest() != content_md5:
            raise LedgerError("ATTACHMENT_CDN_INTEGRITY", "表情 CDN 实体未通过大小或 MD5 校验")

    @staticmethod
    def _image_file_id(packed_info: bytes | None) -> str:
        if not packed_info:
            raise LedgerError("ATTACHMENT_IMAGE_INDEX", "图片资源索引缺少 packed_info")
        marker = b"\x12\x22\x0a\x20"
        index = packed_info.find(marker)
        if index >= 0:
            candidate = packed_info[index + len(marker) : index + len(marker) + 32]
            if re.fullmatch(rb"[0-9a-f]{32}", candidate):
                return candidate.decode("ascii")
        match = re.search(rb"(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])", packed_info)
        if match:
            return match.group().decode("ascii")
        raise LedgerError("ATTACHMENT_IMAGE_INDEX", "图片资源索引不含合法文件标识")

    def _image_index(self, attachment: Mapping[str, Any], username: str) -> list[tuple[str, str, int]]:
        path = self.decrypted_dir / "message" / "message_resource.db"
        connection: sqlite3.Connection | None = None
        try:
            connection = sqlite3.connect(
                f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=0.1
            )
            connection.row_factory = sqlite3.Row
            rows = connection.execute(
                """
                SELECT info.packed_info
                FROM MessageResourceInfo AS info
                JOIN ChatName2Id AS chat ON chat.rowid=info.chat_id
                WHERE chat.user_name=?
                  AND info.message_local_id=?
                  AND CAST(info.message_svr_id AS TEXT)=?
                  AND (info.message_local_type=3 OR info.message_local_type % 4294967296=3)
                """,
                (username, attachment["local_id"], str(attachment["server_id"])),
            ).fetchall()
        except sqlite3.OperationalError as error:
            raise LedgerError("ATTACHMENT_IMAGE_INDEX", "图片资源数据库不可用") from error
        finally:
            if connection is not None:
                connection.close()
        if len(rows) != 1:
            raise LedgerError("ATTACHMENT_IMAGE_INDEX", "无法唯一定位图片资源索引")
        file_id = self._image_file_id(rows[0]["packed_info"])

        database = self.decrypted_dir / "hardlink" / "hardlink.db"
        connection = None
        try:
            connection = sqlite3.connect(
                f"{database.resolve().as_uri()}?mode=ro", uri=True, timeout=0.1
            )
            connection.row_factory = sqlite3.Row
            indexed = connection.execute(
                """
                SELECT md5,file_name,file_size FROM image_hardlink_info_v4
                WHERE file_name IN (?,?,?)
                ORDER BY CASE
                  WHEN file_name=? THEN 0
                  WHEN file_name=? THEN 1
                  ELSE 2
                END
                """,
                (
                    f"{file_id}_h.dat",
                    f"{file_id}.dat",
                    f"{file_id}_t.dat",
                    f"{file_id}_h.dat",
                    f"{file_id}.dat",
                ),
            ).fetchall()
        except sqlite3.OperationalError as error:
            raise LedgerError("ATTACHMENT_IMAGE_HARDLINK", "图片硬链接索引不可用") from error
        finally:
            if connection is not None:
                connection.close()
        if not indexed:
            raise LedgerError("ATTACHMENT_IMAGE_HARDLINK", "图片硬链接索引不存在")
        rows = [
            (str(row["file_name"]), str(row["md5"]).lower(), int(row["file_size"]))
            for row in indexed
        ]
        if len({row[0] for row in rows}) != len(rows):
            raise LedgerError("ATTACHMENT_IMAGE_HARDLINK", "图片硬链接索引存在歧义")
        return rows

    @staticmethod
    def _image_index_pending(error: LedgerError) -> bool:
        detail = str(error)
        if error.code == "ATTACHMENT_IMAGE_HARDLINK":
            return "不存在" in detail or "不可用" in detail
        return error.code == "ATTACHMENT_IMAGE_INDEX" and "不可用" in detail

    def _image_index_with_wait(
        self,
        attachment: Mapping[str, Any],
        username: str,
    ) -> list[tuple[str, str, int]]:
        try:
            return self._image_index(attachment, username)
        except LedgerError as error:
            if not self._image_index_pending(error) or self.image_index_wait_seconds <= 0:
                raise
            last_error = error

        deadline = time.monotonic() + self.image_index_wait_seconds
        next_refresh = time.monotonic()
        refresh_failures = 0
        while True:
            now = time.monotonic()
            if (
                self.refresh_decrypted is not None
                and now >= next_refresh
                and now < deadline
            ):
                try:
                    self.refresh_decrypted()
                except Exception:
                    refresh_failures += 1
                next_refresh = (
                    time.monotonic() + self.image_index_refresh_interval_seconds
                )
            try:
                return self._image_index(attachment, username)
            except LedgerError as error:
                if not self._image_index_pending(error):
                    raise
                last_error = error
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(self.image_index_poll_interval_seconds, remaining))

        detail = "，本轮数据库刷新存在失败" if refresh_failures else ""
        raise LedgerError(
            "ATTACHMENT_IMAGE_WAITING",
            "微信图片原件在有界等待后仍未物化"
            f"{detail}；保留 attachment_ref 稍后重试，不应要求用户缩放或截图",
        ) from last_error

    @staticmethod
    def _decrypt_v2_image(data: bytes, aes_key: bytes, xor_key: int) -> bytes:
        if len(data) < 31 or data[:6] != b"\x07\x08V2\x08\x07":
            raise LedgerError("ATTACHMENT_IMAGE_FORMAT", "图片不是受支持的微信 V2 DAT 格式")
        aes_size, xor_size = struct.unpack_from("<LL", data, 6)
        aligned_size = aes_size + (16 - aes_size % 16 if aes_size % 16 else 16)
        cipher_start = 15
        cipher_end = cipher_start + aligned_size
        raw_end = len(data) - xor_size
        if aes_size <= 0 or cipher_end > raw_end or raw_end < cipher_start:
            raise LedgerError("ATTACHMENT_IMAGE_FORMAT", "微信 V2 DAT 头部长度无效")
        try:
            aes_plain = unpad(
                AES.new(aes_key, AES.MODE_ECB).decrypt(data[cipher_start:cipher_end]),
                AES.block_size,
            )
        except (ValueError, KeyError) as error:
            raise LedgerError("ATTACHMENT_IMAGE_DECRYPT", "微信 V2 图片 AES 校验失败") from error
        if len(aes_plain) != aes_size:
            raise LedgerError("ATTACHMENT_IMAGE_DECRYPT", "微信 V2 图片 AES 长度校验失败")
        result = (
            aes_plain
            + data[cipher_end:raw_end]
            + bytes(value ^ xor_key for value in data[raw_end:])
        )
        if not (
            result.startswith(b"\xff\xd8\xff")
            or result.startswith(b"\x89PNG\r\n\x1a\n")
            or result.startswith((b"GIF87a", b"GIF89a", b"RIFF", b"wxgf"))
        ):
            raise LedgerError("ATTACHMENT_IMAGE_DECRYPT", "微信 V2 图片解密后格式不可识别")
        if result.startswith(b"\xff\xd8\xff") and not result.endswith(b"\xff\xd9"):
            raise LedgerError("ATTACHMENT_IMAGE_DECRYPT", "微信 V2 JPEG 尾部校验失败")
        if result.startswith(b"\x89PNG") and b"IEND" not in result[-16:]:
            raise LedgerError("ATTACHMENT_IMAGE_DECRYPT", "微信 V2 PNG 尾部校验失败")
        return result

    def _image_source(self, username: str, create_time: int, file_name: str) -> Path:
        month = datetime.fromtimestamp(create_time).strftime("%Y-%m")
        return (
            self.account_root
            / "msg"
            / "attach"
            / hashlib.md5(username.encode("utf-8")).hexdigest()
            / month
            / "Img"
            / file_name
        )

    def _validated_material(
        self,
        material: ImageKeyMaterial,
        data: bytes,
        expected_size: int,
        content_md5: str,
    ) -> bool:
        try:
            decrypted = self._decrypt_v2_image(data, material.aes_key, material.xor_key)
        except LedgerError:
            return False
        return len(decrypted) == expected_size and hashlib.md5(decrypted).hexdigest() == content_md5

    def _resolve_scanned_aes(
        self,
        aes_key: bytes,
        owner_account_key_sha256: str,
        candidates: list[tuple[Path, int, str]],
    ) -> ImageKeyMaterial | None:
        for source, expected_size, content_md5 in candidates:
            try:
                data = source.read_bytes()
            except OSError:
                continue
            if len(data) < 31 or data[:6] != b"\x07\x08V2\x08\x07":
                continue
            try:
                first_block = AES.new(aes_key, AES.MODE_ECB).decrypt(data[15:31])
            except (ValueError, KeyError):
                continue
            if not first_block.startswith(
                (b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n", b"GIF87a", b"GIF89a", b"RIFF", b"wxgf")
            ):
                continue
            for xor_key in range(256):
                material = ImageKeyMaterial(
                    aes_key=aes_key,
                    xor_key=xor_key,
                    source="process_memory",
                    owner_account_key_sha256=owner_account_key_sha256,
                )
                if self._validated_material(material, data, expected_size, content_md5):
                    return material
        return None

    @staticmethod
    def _scan_allowed(observed_at: object) -> bool:
        if not isinstance(observed_at, str) or not observed_at:
            return False
        try:
            observed = datetime.fromisoformat(observed_at)
        except ValueError:
            return False
        if observed.tzinfo is None:
            return False
        age = (datetime.now(timezone.utc) - observed.astimezone(timezone.utc)).total_seconds()
        return 0 <= age <= IMAGE_KEY_EVENT_SCAN_WINDOW_SECONDS

    def _account_scan_allowed(
        self,
        owner_account_key_sha256: str,
        observed_at: object,
    ) -> bool:
        return (
            bool(self.active_owner_account_key_sha256)
            and self.active_owner_account_key_sha256 == owner_account_key_sha256
            and self._scan_allowed(observed_at)
        )

    def _materialize_image(
        self,
        attachment: Mapping[str, Any],
        root: ET.Element,
        create_time: int,
        destination: Path,
    ) -> str:
        username, owner_account_key_sha256 = self._verified_identity(attachment)
        indexed = self._image_index_with_wait(attachment, username)
        expected_event_size = attachment.get("byte_count")
        expected_event_md5 = str(attachment.get("content_md5") or "").casefold()
        available = [
            (file_name, content_md5, expected_size)
            for file_name, content_md5, expected_size in indexed
            if self._image_source(username, create_time, file_name).is_file()
        ]
        if not available:
            raise LedgerError("ATTACHMENT_IMAGE_ENTITY", "微信图片实体不存在")
        exact = [
            row
            for row in available
            if expected_event_size is not None
            and int(expected_event_size) == row[2]
            and expected_event_md5
            and expected_event_md5 == row[1]
        ]
        file_name, content_md5, expected_size = (exact or available)[0]
        source_kind = "wechat_v2_image_dat" if exact else "wechat_v2_image_preview"
        source = self._image_source(username, create_time, file_name)
        image = root.find(".//img")
        message_md5 = "" if image is None else (
            image.get("originsourcemd5") or image.get("md5") or ""
        ).strip().lower()
        if file_name.endswith("_h.dat") and message_md5 and message_md5 != content_md5:
            raise LedgerError("ATTACHMENT_IMAGE_INDEX", "图片消息与高清硬链接 MD5 不一致")
        data = source.read_bytes()
        if len(data) > MAX_ATTACHMENT_BYTES + 64:
            raise LedgerError("ATTACHMENT_TOO_LARGE", "微信图片实体超过允许上限")
        scan_candidates = [
            (candidate_source, size, candidate_md5)
            for candidate_name, candidate_md5, size in sorted(
                indexed,
                key=lambda row: (0 if row[0].endswith("_t.dat") else 1, row[2]),
            )
            if (candidate_source := self._image_source(username, create_time, candidate_name)).is_file()
        ]
        material = self.image_key_manager.resolve(
            owner_account_key_sha256,
            validate=lambda candidate: self._validated_material(
                candidate,
                data,
                expected_size,
                content_md5,
            ),
            resolve_scanned_aes=lambda aes_key: self._resolve_scanned_aes(
                aes_key,
                owner_account_key_sha256,
                scan_candidates,
            ),
            validated_content_md5=content_md5,
            allow_scan=self._account_scan_allowed(
                owner_account_key_sha256,
                attachment.get("observed_at"),
            ),
            scan_timeout_seconds=IMAGE_KEY_SCAN_TIMEOUT_SECONDS,
        )
        decrypted = self._decrypt_v2_image(data, material.aes_key, material.xor_key)
        if len(decrypted) != expected_size or hashlib.md5(decrypted).hexdigest() != content_md5:
            raise LedgerError("ATTACHMENT_IMAGE_INTEGRITY", "微信图片未通过硬链接大小或 MD5 校验")
        with destination.open("xb") as stream:
            stream.write(decrypted)
            stream.flush()
            os.fsync(stream.fileno())
        return source_kind

    def materialize(self, attachment: Mapping[str, Any], destination: Path) -> str:
        if destination.exists():
            raise LedgerError("ATTACHMENT_PARTIAL_EXISTS", "临时附件路径已存在")
        root, create_time = self._message_content(attachment)
        kind = str(attachment["kind"])
        if kind == "file":
            source = self._resolve_file(attachment, root, create_time)
            with source.open("rb") as input_stream, destination.open("xb") as output_stream:
                while chunk := input_stream.read(1024 * 1024):
                    output_stream.write(chunk)
                output_stream.flush()
                os.fsync(output_stream.fileno())
            return "wechat_local_file"
        if kind == "sticker":
            self._download_sticker(attachment, root, destination)
            return "wechat_sticker_cdn"
        if kind == "image":
            return self._materialize_image(attachment, root, create_time, destination)
        raise LedgerError("ATTACHMENT_KIND_UNSUPPORTED", f"不支持的附件类型：{kind}")
