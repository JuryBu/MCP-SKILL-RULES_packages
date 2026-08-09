"""WeChat database observer — read-only message discovery via decrypted SQLite.

This module reads the locally stored WeChat (WCDB/SQLCipher4) databases after
they have been decrypted by the key extraction tool.  It provides:

* ``DbObserver`` — polls decrypted message databases for new rows since a
  baseline, maps them to authorised routes, and yields ``Observation`` dicts
  ready for ingestion into the ``EventLedger``.

The observer is intentionally stateless across restarts: the baseline
(high-water mark per route) is persisted in the ledger's ``routes`` table
via the ``identity`` JSON column, so a fresh process picks up exactly where
the previous one left off without replaying old history.

Security boundaries:
* No injection, Hook, DLL load, or process memory access.
* No network calls.
* No writes to the WeChat data directory.
* Only reads from the private decrypted copy maintained by the key tool.
"""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Sequence

try:
    import zstandard as zstd
    _ZDCTX = zstd.ZstdDecompressor()
except ImportError:
    _ZDCTX = None

PAGE_SZ = 4096
SALT_SZ = 16
RESERVE_SZ = 80
IV_SZ = 16
HMAC_SZ = 64
SQLITE_HDR = b"SQLite format 3\x00"


@dataclass(frozen=True)
class RouteBinding:
    """A single authorised chat mapped to a route_id."""
    route_id: str
    exact_title: str
    chat_type: str  # "friend" or "group"
    username: str   # wxid_xxx or xxx@chatroom
    conversation_id: str = ""


@dataclass(frozen=True)
class Observation:
    """One observed message ready for ledger ingestion."""
    route_id: str
    source_fingerprint: str
    event_type: str
    payload: dict[str, Any]
    occurred_at: str
    sensitivity: str = "normal"


class DbObserver:
    """Read-only observer for decrypted WeChat message databases.

    Parameters
    ----------
    decrypted_dir
        Path to the directory containing decrypted .db files (same layout
        as the original ``db_storage`` tree).
    bindings
        Authorised route bindings — only messages from these chats are
        observed.
    """

    def __init__(self, decrypted_dir: str | Path, bindings: Sequence[RouteBinding]) -> None:
        self.decrypted_dir = Path(decrypted_dir)
        self._bindings = {b.username: b for b in bindings}
        self._sender_cache: dict[int, str] = {}
        self._contact_cache: dict[str, str] = {}
        self._load_sender_cache()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _msg_db_path(self) -> Path:
        return self.decrypted_dir / "message" / "message_0.db"

    def _contact_db_path(self) -> Path:
        return self.decrypted_dir / "contact" / "contact.db"

    def _session_db_path(self) -> Path:
        return self.decrypted_dir / "session" / "session.db"

    def _load_sender_cache(self) -> None:
        """Populate sender_id -> display_name cache from Name2Id."""
        path = self._msg_db_path()
        if not path.exists():
            return
        conn = sqlite3.connect(path)
        try:
            rows = conn.execute("SELECT rowid, user_name FROM Name2Id").fetchall()
            for rowid, user_name in rows:
                self._sender_cache[rowid] = user_name or "<system>"
        finally:
            conn.close()

    def _sender_name(self, sender_id: int) -> str:
        return self._sender_cache.get(sender_id, f"id={sender_id}")

    @staticmethod
    def _strip_group_sender_prefix(content: str, sender_username: str) -> str:
        prefix = f"{sender_username}:\n"
        return content[len(prefix):] if sender_username and content.startswith(prefix) else content

    def _contact_display_name(self, username: str) -> str:
        """Look up nick_name from contact.db for a username."""
        if username in self._contact_cache:
            return self._contact_cache[username]
        path = self._contact_db_path()
        if not path.exists():
            return username
        conn = sqlite3.connect(path)
        try:
            row = conn.execute(
                "SELECT nick_name FROM contact WHERE username = ?", (username,)
            ).fetchone()
            name = row[0] if row else username
        finally:
            conn.close()
        self._contact_cache[username] = name
        return name

    @staticmethod
    def _msg_table_name(username: str) -> str:
        """WCDB names per-conversation tables as Msg_<MD5(username)>."""
        return "Msg_" + hashlib.md5(username.encode("utf-8")).hexdigest()

    @staticmethod
    def _decompress_field(data: bytes | str | None, ct: int) -> str:
        """Decompress a WCDB field.  ct == 0 means raw, ct == 4 means zstd."""
        if data is None:
            return ""
        if isinstance(data, str):
            return data
        if ct == 0:
            return data.decode("utf-8", errors="replace")
        if ct == 4 and _ZDCTX is not None:
            try:
                return _ZDCTX.decompress(data).decode("utf-8", errors="replace")
            except Exception:
                try:
                    return _ZDCTX.decompress(data, max_output_size=len(data) * 30).decode(
                        "utf-8", errors="replace"
                    )
                except Exception:
                    return ""
        return data.decode("utf-8", errors="replace")

    @staticmethod
    def _classify_message(local_type: int, content: str) -> str:
        """Classify a message by its WeChat local_type and content XML.

        WeChat encodes message type in ``local_type``.  For ordinary messages
        the low byte is the primary type (1=text, 3=image, ...).  System and
        revoke messages use large values (10000, 10002) that do not fit in a
        single byte, so we check the full value first.
        """
        if local_type == 10000:
            return "system"
        if local_type == 10002:
            return "revoke"
        base_type = local_type & 0xFF
        if base_type == 1:
            return "text"
        if base_type == 3:
            return "image"
        if base_type == 34:
            return "voice"
        if base_type == 43:
            return "video"
        if base_type == 47:
            return "sticker"
        if base_type == 48:
            return "location"
        if base_type == 49:
            # App message — sub-classify by <type> in XML
            try:
                root = ET.fromstring(content)
                app_type = root.find(".//appmsg/type")
                if app_type is not None:
                    sub = int(app_type.text or 0)
                    if sub == 6:
                        return "file"
                    if sub == 5:
                        return "link"
                    if sub == 33 or sub == 36:
                        return "mini_program"
                    if sub == 51:
                        return "unknown_app"
            except ET.ParseError:
                pass
            return "app"
        return "unknown"

    @staticmethod
    def _extract_text(content: str, msg_type: str) -> str:
        """Extract visible text from message content."""
        if msg_type == "text":
            return content.strip()
        if msg_type == "system":
            return content.strip()
        if msg_type in ("image", "voice", "video", "sticker"):
            return ""
        if msg_type == "location":
            try:
                root = ET.fromstring(content)
                loc = root.find(".//location")
                if loc is not None:
                    label = loc.get("label", "")
                    poiname = loc.get("poiname", "")
                    return f"[位置] {poiname} {label}".strip()
            except ET.ParseError:
                pass
            return "[位置]"
        if msg_type in ("file", "link", "mini_program", "app", "unknown_app"):
            try:
                root = ET.fromstring(content)
                title_el = root.find(".//appmsg/title")
                if title_el is not None and title_el.text:
                    title = title_el.text.strip()
                    if msg_type == "file":
                        return f"[文件] {title}"
                    if msg_type == "link":
                        return f"[链接] {title}"
                    return f"[小程序] {title}" if msg_type == "mini_program" else title
            except ET.ParseError:
                pass
            return f"[{msg_type}]"
        return content[:200] if content else ""

    @staticmethod
    def _extract_attachment_info(content: str, msg_type: str) -> dict[str, Any]:
        """Extract attachment metadata (name, size) from app messages."""
        if msg_type not in ("file", "link", "mini_program", "app", "unknown_app"):
            return {}
        try:
            root = ET.fromstring(content)
            appmsg = root.find(".//appmsg")
            if appmsg is None:
                return {}
            info: dict[str, Any] = {}
            title_el = appmsg.find("title")
            if title_el is not None and title_el.text:
                info["attachment_name"] = title_el.text.strip()
            attach = appmsg.find("appattach")
            if attach is not None:
                total = attach.find("totallen")
                if total is not None and total.text:
                    size = int(total.text)
                    if size > 0:
                        info["attachment_size"] = size
                        if size >= 1024 * 1024:
                            info["attachment_size_display"] = f"{size / 1024 / 1024:.1f}MB"
                        else:
                            info["attachment_size_display"] = f"{size / 1024:.0f}KB"
            return info
        except ET.ParseError:
            return {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def establish_baseline(self) -> dict[str, int]:
        """Return the high-water mark (max local_id) per route.

        Call this once when activating a route to prevent old-history replay.
        The returned dict maps ``route_id`` to ``max_local_id``; persist it
        in the route's identity JSON and pass it to ``poll_new_messages``.
        """
        baselines: dict[str, int] = {}
        path = self._msg_db_path()
        if not path.exists():
            return baselines
        conn = sqlite3.connect(path)
        try:
            for binding in self._bindings.values():
                tname = self._msg_table_name(binding.username)
                try:
                    row = conn.execute(
                        f"SELECT MAX(local_id) FROM [{tname}]"
                    ).fetchone()
                    baselines[binding.route_id] = row[0] if row and row[0] else 0
                except sqlite3.OperationalError:
                    baselines[binding.route_id] = 0
        finally:
            conn.close()
        return baselines

    def poll_new_messages(
        self,
        baselines: dict[str, int],
    ) -> Iterator[Observation]:
        """Yield observations for messages newer than the baseline.

        Parameters
        ----------
        baselines
            Mapping of ``route_id`` to the last-processed ``local_id``.
            Messages with ``local_id <= baseline`` are skipped.

        Yields
        ------
        Observation
            One per new message, in chronological order within each route.
        """
        path = self._msg_db_path()
        if not path.exists():
            return
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        try:
            for binding in self._bindings.values():
                tname = self._msg_table_name(binding.username)
                baseline = baselines.get(binding.route_id, 0)
                try:
                    rows = conn.execute(
                        f"""
                        SELECT local_id, server_id, local_type, sort_seq,
                               real_sender_id, create_time, status,
                               source, message_content,
                               WCDB_CT_message_content, WCDB_CT_source
                        FROM [{tname}]
                        WHERE local_id > ?
                        ORDER BY local_id ASC
                        """,
                        (baseline,),
                    ).fetchall()
                except sqlite3.OperationalError:
                    continue

                for row in rows:
                    r = dict(row)
                    content = self._decompress_field(
                        r["message_content"], r["WCDB_CT_message_content"]
                    )
                    sender_username = self._sender_name(r["real_sender_id"])
                    if binding.chat_type == "group":
                        content = self._strip_group_sender_prefix(content, sender_username)
                    msg_type = self._classify_message(r["local_type"], content)
                    visible_text = self._extract_text(content, msg_type)
                    attachment_info = self._extract_attachment_info(content, msg_type)
                    sender_display = self._contact_display_name(sender_username)

                    # Build fingerprint for dedup
                    fp = f"{binding.username}:{r['local_id']}:{r['server_id']}"

                    # Build occurred_at ISO string
                    occurred_at = datetime.fromtimestamp(
                        r["create_time"], tz=timezone.utc
                    ).isoformat()

                    # Determine sensitivity
                    sensitivity = "normal"
                    if msg_type in ("image", "file", "sticker"):
                        sensitivity = "awaiting_owner_instruction"

                    payload: dict[str, Any] = {
                        "kind": msg_type,
                        "sender_display": sender_display,
                        "sender_username": sender_username,
                        "message_time_display": datetime.fromtimestamp(
                            r["create_time"], tz=timezone.utc
                        ).isoformat(),
                        "visible_text": visible_text,
                        "local_id": r["local_id"],
                        "server_id": r["server_id"],
                        "source_window_identity": binding.exact_title,
                    }
                    payload.update(attachment_info)

                    yield Observation(
                        route_id=binding.route_id,
                        source_fingerprint=fp,
                        event_type=msg_type,
                        payload=payload,
                        occurred_at=occurred_at,
                        sensitivity=sensitivity,
                    )
        finally:
            conn.close()

    def get_route_identity(self, binding: RouteBinding) -> dict[str, Any]:
        """Build an identity dict for route enrollment verification."""
        identity: dict[str, Any] = {
            "chat_name": binding.exact_title,
            "chat_type": binding.chat_type,
            "username": binding.username,
        }
        # For groups, try to get member count
        if binding.chat_type == "group":
            path = self._contact_db_path()
            if path.exists():
                conn = sqlite3.connect(path)
                try:
                    row = conn.execute(
                        "SELECT id FROM contact WHERE username = ?",
                        (binding.username,),
                    ).fetchone()
                    if row:
                        # Count chatroom members
                        count = conn.execute(
                            "SELECT COUNT(*) FROM chatroom_member WHERE chatroom_id = ?",
                            (row[0],),
                        ).fetchone()
                        if count:
                            identity["group_member_count"] = count[0]
                except sqlite3.OperationalError:
                    pass
                finally:
                    conn.close()
        return identity
