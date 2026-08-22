from __future__ import annotations

import hashlib
import json
import sqlite3
import struct
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

from wechat_docs_mcp.ledger import EventLedger, LedgerError
from wechat_docs_mcp.wechat_attachment_source import WechatAttachmentSourceResolver


OWNER_KEY = "synthetic-owner"
USERNAME = "synthetic-room@chatroom"
FILE_BYTES = b"synthetic attachment"
STICKER_BYTES = b"synthetic sticker"


def _message_table(username: str) -> str:
    digest = hashlib.md5(username.encode("utf-8")).hexdigest()
    return f"Msg_{digest}"


def _binding() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "ownerAccountKey": OWNER_KEY,
        "routes": [
            {
                "route_id": "route-a",
                "exact_title": "Synthetic Room",
                "chat_type": "group",
                "username": USERNAME,
                "state": "active",
            }
        ],
    }


def _write_message_database(
    root: Path,
    content: str,
    *,
    local_id: int,
    server_id: int,
    local_type: int = 49,
) -> None:
    database = root / "message" / "message_0.db"
    database.parent.mkdir(parents=True)
    connection = sqlite3.connect(database)
    try:
        connection.execute(
            f"""
            CREATE TABLE [{_message_table(USERNAME)}](
              local_id INTEGER,
              server_id INTEGER,
              local_type INTEGER,
              create_time INTEGER,
              message_content TEXT,
              WCDB_CT_message_content INTEGER
            )
            """
        )
        connection.execute(
            f"INSERT INTO [{_message_table(USERNAME)}] VALUES(?,?,?,?,?,?)",
            (local_id, server_id, local_type, 1_723_680_000, content, 0),
        )
        connection.commit()
    finally:
        connection.close()


def _write_hardlink_database(root: Path, *, file_name: str, size: int, content_md5: str) -> None:
    database = root / "hardlink" / "hardlink.db"
    database.parent.mkdir(parents=True)
    connection = sqlite3.connect(database)
    try:
        connection.execute(
            "CREATE TABLE file_hardlink_info_v4(md5 TEXT,file_name TEXT,file_size INTEGER)"
        )
        connection.execute(
            "INSERT INTO file_hardlink_info_v4 VALUES(?,?,?)",
            (content_md5, file_name, size),
        )
        connection.commit()
    finally:
        connection.close()


def _write_emoticon_database(root: Path, *, content_md5: str, url: str) -> None:
    database = root / "emoticon" / "emoticon.db"
    database.parent.mkdir(parents=True)
    connection = sqlite3.connect(database)
    try:
        connection.execute("CREATE TABLE kNonStoreEmoticonTable(md5 TEXT,cdn_url TEXT)")
        connection.execute("INSERT INTO kNonStoreEmoticonTable VALUES(?,?)", (content_md5, url))
        connection.commit()
    finally:
        connection.close()


def _write_image_databases(
    root: Path,
    *,
    local_id: int,
    server_id: int,
    file_id: str,
    content_md5: str,
    size: int,
    variant: str = "_h",
) -> None:
    resource = root / "message" / "message_resource.db"
    resource.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(resource)
    try:
        connection.executescript(
            """
            CREATE TABLE ChatName2Id(user_name TEXT);
            CREATE TABLE MessageResourceInfo(
              chat_id INTEGER,message_local_id INTEGER,message_svr_id INTEGER,
              message_local_type INTEGER,packed_info BLOB
            );
            """
        )
        connection.execute("INSERT INTO ChatName2Id(rowid,user_name) VALUES(1,?)", (USERNAME,))
        packed_info = b"\x12\x22\x0a\x20" + file_id.encode("ascii")
        connection.execute(
            "INSERT INTO MessageResourceInfo VALUES(?,?,?,?,?)",
            (1, local_id, server_id, 3, packed_info),
        )
        connection.commit()
    finally:
        connection.close()

    hardlink = root / "hardlink" / "hardlink.db"
    hardlink.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(hardlink)
    try:
        connection.execute(
            "CREATE TABLE image_hardlink_info_v4(md5 TEXT,file_name TEXT,file_size INTEGER)"
        )
        connection.execute(
            "INSERT INTO image_hardlink_info_v4 VALUES(?,?,?)",
            (content_md5, f"{file_id}{variant}.dat", size),
        )
        connection.commit()
    finally:
        connection.close()


def _encrypt_v2_image(payload: bytes, aes_key: bytes, xor_key: int) -> bytes:
    aes_size = min(1024, len(payload))
    encrypted = AES.new(aes_key, AES.MODE_ECB).encrypt(pad(payload[:aes_size], 16))
    tail = bytes(value ^ xor_key for value in payload[aes_size:])
    return b"\x07\x08V2\x08\x07" + struct.pack("<LLB", aes_size, len(tail), 1) + encrypted + tail


def _resolver(tmp_path: Path) -> tuple[WechatAttachmentSourceResolver, EventLedger, Path, Path]:
    decrypted = tmp_path / "decrypted"
    account = tmp_path / "account"
    ledger = EventLedger(tmp_path / "events.sqlite3")
    ledger.register_route(
        "route-a",
        profile="test",
        identity={"chat_name": "Synthetic Room", "chat_type": "group", "username": USERNAME},
        state="active",
        owner_account_key=OWNER_KEY,
        username=USERNAME,
        chat_type="group",
        display_title="Synthetic Room",
    )
    return WechatAttachmentSourceResolver(ledger, _binding(), decrypted, account), ledger, decrypted, account


def _attachment(*, kind: str, local_id: int, server_id: int, size: int, content_md5: str) -> dict[str, object]:
    return {
        "route_id": "route-a",
        "kind": kind,
        "local_id": local_id,
        "server_id": str(server_id),
        "byte_count": size,
        "content_md5": content_md5,
        "source_fingerprint": f"{USERNAME}:{local_id}:{server_id}",
    }


def test_file_materialization_requires_exact_message_index_and_entity(tmp_path: Path) -> None:
    resolver, _, decrypted, account = _resolver(tmp_path)
    file_name = "sample.pdf"
    content_md5 = hashlib.md5(FILE_BYTES).hexdigest()
    content = (
        "<msg><appmsg><title>sample.pdf</title><md5>"
        f"{content_md5}</md5><appattach><totallen>{len(FILE_BYTES)}</totallen>"
        "</appattach></appmsg></msg>"
    )
    _write_message_database(decrypted, content, local_id=7, server_id=99)
    _write_hardlink_database(
        decrypted,
        file_name=file_name,
        size=len(FILE_BYTES),
        content_md5=content_md5,
    )
    source = account / "msg" / "file" / "2024-08" / file_name
    source.parent.mkdir(parents=True)
    source.write_bytes(FILE_BYTES)

    destination = tmp_path / "materialized.pdf"
    source_kind = resolver.materialize(
        _attachment(
            kind="file",
            local_id=7,
            server_id=99,
            size=len(FILE_BYTES),
            content_md5=content_md5,
        ),
        destination,
    )

    assert source_kind == "wechat_local_file"
    assert destination.read_bytes() == FILE_BYTES


def test_v1_route_fingerprint_mismatch_is_rejected_before_database_read(tmp_path: Path) -> None:
    resolver, _, _, _ = _resolver(tmp_path)
    attachment = _attachment(
        kind="file",
        local_id=7,
        server_id=99,
        size=len(FILE_BYTES),
        content_md5=hashlib.md5(FILE_BYTES).hexdigest(),
    )
    attachment["source_fingerprint"] = "other-room@chatroom:7:99"

    with pytest.raises(LedgerError) as raised:
        resolver.materialize(attachment, tmp_path / "materialized.pdf")
    assert raised.value.code == "ATTACHMENT_ROUTE_UNVERIFIED"


def test_sticker_download_rejects_redirect_and_accepts_integrity_checked_body(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    resolver, _, decrypted, _ = _resolver(tmp_path)
    content_md5 = hashlib.md5(STICKER_BYTES).hexdigest()
    content = (
        "<msg><emoji md5=\""
        f"{content_md5}\" len=\"{len(STICKER_BYTES)}\" width=\"1\" height=\"1\"/>"
        "</msg>"
    )
    _write_message_database(decrypted, content, local_id=8, server_id=100)
    _write_emoticon_database(
        decrypted,
        content_md5=content_md5,
        url="https://vweixinf.tc.qq.com/synthetic",
    )
    attachment = _attachment(
        kind="sticker",
        local_id=8,
        server_id=100,
        size=len(STICKER_BYTES),
        content_md5=content_md5,
    )
    real_client = httpx.Client

    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **_: real_client(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(302, headers={"Location": "https://example.invalid"})
            ),
            follow_redirects=False,
        ),
    )
    with pytest.raises(LedgerError) as raised:
        resolver.materialize(attachment, tmp_path / "redirect.partial")
    assert raised.value.code == "ATTACHMENT_CDN_HTTP"

    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **_: real_client(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, content=STICKER_BYTES)),
            follow_redirects=False,
        ),
    )
    destination = tmp_path / "sticker.partial"
    assert resolver.materialize(attachment, destination) == "wechat_sticker_cdn"
    assert destination.read_bytes() == STICKER_BYTES


def test_sticker_rejects_unapproved_cdn_host(tmp_path: Path) -> None:
    resolver, _, decrypted, _ = _resolver(tmp_path)
    content_md5 = hashlib.md5(STICKER_BYTES).hexdigest()
    content = (
        "<msg><emoji md5=\""
        f"{content_md5}\" len=\"{len(STICKER_BYTES)}\" width=\"1\" height=\"1\"/>"
        "</msg>"
    )
    _write_message_database(decrypted, content, local_id=9, server_id=101)
    _write_emoticon_database(
        decrypted,
        content_md5=content_md5,
        url="https://example.invalid/synthetic",
    )

    with pytest.raises(LedgerError) as raised:
        resolver.materialize(
            _attachment(
                kind="sticker",
                local_id=9,
                server_id=101,
                size=len(STICKER_BYTES),
                content_md5=content_md5,
            ),
            tmp_path / "sticker.partial",
        )
    assert raised.value.code == "ATTACHMENT_CDN_NOT_ALLOWED"


def test_v2_image_requires_exact_resource_index_private_key_and_hardlink_integrity(
    tmp_path: Path,
) -> None:
    _, ledger, decrypted, account = _resolver(tmp_path)
    local_id = 10
    server_id = 102
    file_id = "a" * 32
    aes_key = b"syntheticAESkey1"
    xor_key = 0xD4
    payload = b"\xff\xd8\xff\xe0" + (b"synthetic-image" * 140) + b"\xff\xd9"
    content_md5 = hashlib.md5(payload).hexdigest()
    content = (
        "<msg><img originsourcemd5=\""
        f"{content_md5}\" md5=\"{content_md5}\" hdlength=\"{len(payload)}\"/></msg>"
    )
    _write_message_database(
        decrypted,
        content,
        local_id=local_id,
        server_id=server_id,
        local_type=3,
    )
    _write_image_databases(
        decrypted,
        local_id=local_id,
        server_id=server_id,
        file_id=file_id,
        content_md5=content_md5,
        size=len(payload),
    )
    source = (
        account
        / "msg"
        / "attach"
        / hashlib.md5(USERNAME.encode("utf-8")).hexdigest()
        / "2024-08"
        / "Img"
        / f"{file_id}_h.dat"
    )
    source.parent.mkdir(parents=True)
    source.write_bytes(_encrypt_v2_image(payload, aes_key, xor_key))
    key_file = tmp_path / "private-image-key.json"
    key_file.write_text(
        json.dumps({"version": 1, "aes_key": aes_key.decode("ascii"), "xor_key": xor_key}),
        encoding="utf-8",
    )
    resolver = WechatAttachmentSourceResolver(
        ledger,
        _binding(),
        decrypted,
        account,
        key_file,
        tmp_path / "scoped-image-keys",
    )
    destination = tmp_path / "image.partial"

    source_kind = resolver.materialize(
        _attachment(
            kind="image",
            local_id=local_id,
            server_id=server_id,
            size=len(payload),
            content_md5=content_md5,
        ),
        destination,
    )

    assert source_kind == "wechat_v2_image_dat"
    assert destination.read_bytes() == payload
    assert (tmp_path / "scoped-image-keys" / f"{hashlib.sha256(OWNER_KEY.encode()).hexdigest()}.json").is_file()


def test_v2_image_waits_for_one_bounded_database_refresh(tmp_path: Path) -> None:
    _, ledger, decrypted, account = _resolver(tmp_path)
    local_id = 13
    server_id = 105
    file_id = "d" * 32
    aes_key = b"syntheticAESkey1"
    xor_key = 0xD4
    payload = b"\xff\xd8\xff\xe0" + (b"delayed-image" * 120) + b"\xff\xd9"
    content_md5 = hashlib.md5(payload).hexdigest()
    _write_message_database(
        decrypted,
        f'<msg><img originsourcemd5="{content_md5}" hdlength="{len(payload)}"/></msg>',
        local_id=local_id,
        server_id=server_id,
        local_type=3,
    )
    _write_image_databases(
        decrypted,
        local_id=local_id,
        server_id=server_id,
        file_id=file_id,
        content_md5=content_md5,
        size=len(payload),
    )
    hardlink = decrypted / "hardlink" / "hardlink.db"
    delayed_database = hardlink.read_bytes()
    hardlink.unlink()
    source = (
        account
        / "msg"
        / "attach"
        / hashlib.md5(USERNAME.encode("utf-8")).hexdigest()
        / "2024-08"
        / "Img"
        / f"{file_id}_h.dat"
    )
    source.parent.mkdir(parents=True)
    source.write_bytes(_encrypt_v2_image(payload, aes_key, xor_key))
    key_file = tmp_path / "private-image-key.json"
    key_file.write_text(
        json.dumps({"version": 1, "aes_key": aes_key.decode("ascii"), "xor_key": xor_key}),
        encoding="utf-8",
    )
    refresh_calls: list[str] = []

    def refresh_decrypted() -> None:
        refresh_calls.append("refresh")
        if len(refresh_calls) == 2:
            hardlink.write_bytes(delayed_database)

    resolver = WechatAttachmentSourceResolver(
        ledger,
        _binding(),
        decrypted,
        account,
        key_file,
        tmp_path / "scoped-image-keys",
        refresh_decrypted=refresh_decrypted,
        image_index_wait_seconds=0.2,
        image_index_poll_interval_seconds=0.01,
        image_index_refresh_interval_seconds=0.01,
    )
    destination = tmp_path / "delayed-image.partial"

    source_kind = resolver.materialize(
        _attachment(
            kind="image",
            local_id=local_id,
            server_id=server_id,
            size=len(payload),
            content_md5=content_md5,
        ),
        destination,
    )

    assert refresh_calls == ["refresh", "refresh"]
    assert source_kind == "wechat_v2_image_dat"
    assert destination.read_bytes() == payload


def test_v2_image_reports_waiting_after_bounded_refresh(tmp_path: Path) -> None:
    _, ledger, decrypted, account = _resolver(tmp_path)
    local_id = 14
    server_id = 106
    file_id = "e" * 32
    content_md5 = hashlib.md5(b"not-materialized").hexdigest()
    _write_message_database(
        decrypted,
        f'<msg><img originsourcemd5="{content_md5}" hdlength="128"/></msg>',
        local_id=local_id,
        server_id=server_id,
        local_type=3,
    )
    _write_image_databases(
        decrypted,
        local_id=local_id,
        server_id=server_id,
        file_id=file_id,
        content_md5=content_md5,
        size=128,
    )
    connection = sqlite3.connect(decrypted / "hardlink" / "hardlink.db")
    try:
        connection.execute("DELETE FROM image_hardlink_info_v4")
        connection.commit()
    finally:
        connection.close()
    refresh_calls: list[str] = []
    resolver = WechatAttachmentSourceResolver(
        ledger,
        _binding(),
        decrypted,
        account,
        refresh_decrypted=lambda: refresh_calls.append("refresh"),
        image_index_wait_seconds=0.03,
        image_index_poll_interval_seconds=0.01,
    )
    destination = tmp_path / "missing-image.partial"

    with pytest.raises(LedgerError) as raised:
        resolver.materialize(
            _attachment(
                kind="image",
                local_id=local_id,
                server_id=server_id,
                size=128,
                content_md5=content_md5,
            ),
            destination,
        )

    assert refresh_calls == ["refresh"]
    assert raised.value.code == "ATTACHMENT_IMAGE_WAITING"
    assert not destination.exists()


def test_v2_image_index_without_recent_entity_reports_waiting(tmp_path: Path) -> None:
    _, ledger, decrypted, account = _resolver(tmp_path)
    local_id = 15
    server_id = 107
    file_id = "f" * 32
    payload = b"not-yet-materialized"
    content_md5 = hashlib.md5(payload).hexdigest()
    _write_message_database(
        decrypted,
        f'<msg><img originsourcemd5="{content_md5}" hdlength="{len(payload)}"/></msg>',
        local_id=local_id,
        server_id=server_id,
        local_type=3,
    )
    _write_image_databases(
        decrypted,
        local_id=local_id,
        server_id=server_id,
        file_id=file_id,
        content_md5=content_md5,
        size=len(payload),
    )
    refresh_calls: list[str] = []
    resolver = WechatAttachmentSourceResolver(
        ledger,
        _binding(),
        decrypted,
        account,
        refresh_decrypted=lambda: refresh_calls.append("refresh"),
        image_index_wait_seconds=0.03,
        image_index_poll_interval_seconds=0.01,
    )
    attachment = _attachment(
        kind="image",
        local_id=local_id,
        server_id=server_id,
        size=len(payload),
        content_md5=content_md5,
    )
    attachment["observed_at"] = datetime.now(timezone.utc).isoformat()

    with pytest.raises(LedgerError) as raised:
        resolver.materialize(attachment, tmp_path / "recent-missing.partial")

    assert raised.value.code == "ATTACHMENT_IMAGE_WAITING"
    assert refresh_calls


def test_v2_historical_image_without_entity_reports_not_available(tmp_path: Path) -> None:
    _, ledger, decrypted, account = _resolver(tmp_path)
    local_id = 16
    server_id = 108
    file_id = "1" * 32
    payload = b"historical-missing"
    content_md5 = hashlib.md5(payload).hexdigest()
    _write_message_database(
        decrypted,
        f'<msg><img originsourcemd5="{content_md5}" hdlength="{len(payload)}"/></msg>',
        local_id=local_id,
        server_id=server_id,
        local_type=3,
    )
    _write_image_databases(
        decrypted,
        local_id=local_id,
        server_id=server_id,
        file_id=file_id,
        content_md5=content_md5,
        size=len(payload),
    )
    resolver = WechatAttachmentSourceResolver(
        ledger,
        _binding(),
        decrypted,
        account,
        image_index_wait_seconds=0.03,
        image_index_poll_interval_seconds=0.01,
    )
    attachment = _attachment(
        kind="image",
        local_id=local_id,
        server_id=server_id,
        size=len(payload),
        content_md5=content_md5,
    )
    attachment["observed_at"] = "2020-01-01T00:00:00+00:00"

    with pytest.raises(LedgerError) as raised:
        resolver.materialize(attachment, tmp_path / "historical-missing.partial")

    assert raised.value.code == "ATTACHMENT_IMAGE_NOT_AVAILABLE"


def test_image_index_temporarily_unavailable_is_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    resolver, _, _, _ = _resolver(tmp_path)
    resolver.image_index_wait_seconds = 0.1
    resolver.image_index_poll_interval_seconds = 0.01
    attempts: list[int] = []

    def image_index(_attachment: object, _username: str) -> list[tuple[str, str, int]]:
        attempts.append(len(attempts) + 1)
        if len(attempts) < 3:
            raise LedgerError("ATTACHMENT_IMAGE_HARDLINK", "图片硬链接索引不可用")
        return [("synthetic.dat", "a" * 32, 128)]

    monkeypatch.setattr(resolver, "_image_index", image_index)

    indexed = resolver._image_index_with_wait({}, USERNAME)

    assert indexed == [("synthetic.dat", "a" * 32, 128)]
    assert len(attempts) == 3


def test_historical_context_image_does_not_wait_for_missing_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    resolver, _, _, _ = _resolver(tmp_path)
    resolver.image_index_wait_seconds = 0.1
    attempts: list[int] = []
    refreshes: list[int] = []

    def missing_index(_attachment: object, _username: str) -> list[tuple[str, str, int]]:
        attempts.append(1)
        raise LedgerError("ATTACHMENT_IMAGE_HARDLINK", "图片硬链接索引不存在")

    resolver.refresh_decrypted = lambda: refreshes.append(1)
    monkeypatch.setattr(resolver, "_image_index", missing_index)

    with pytest.raises(LedgerError) as raised:
        resolver._image_index_with_wait({"reference_kind": "context"}, USERNAME)

    assert raised.value.code == "ATTACHMENT_IMAGE_NOT_AVAILABLE"
    assert len(attempts) == 1
    assert refreshes == []


def test_recent_historical_context_image_never_scans_process_memory(tmp_path: Path) -> None:
    _, ledger, decrypted, account = _resolver(tmp_path)
    payload = b"\xff\xd8\xff" + b"context-image" * 100 + b"\xff\xd9"
    content_md5 = hashlib.md5(payload).hexdigest()
    file_id = "d" * 32
    aes_key = b"contextAESkey123"
    xor_key = 0x91
    _write_message_database(
        decrypted,
        f'<msg><img md5="{content_md5}" originsourcemd5="{content_md5}" '
        f'hdlength="{len(payload)}"/></msg>',
        local_id=13,
        server_id=105,
        local_type=3,
    )
    _write_image_databases(
        decrypted,
        local_id=13,
        server_id=105,
        file_id=file_id,
        content_md5=content_md5,
        size=len(payload),
    )
    source = (
        account
        / "msg"
        / "attach"
        / hashlib.md5(USERNAME.encode("utf-8")).hexdigest()
        / "2024-08"
        / "Img"
        / f"{file_id}_h.dat"
    )
    source.parent.mkdir(parents=True)
    source.write_bytes(_encrypt_v2_image(payload, aes_key, xor_key))

    class RecordingScanner:
        def __init__(self) -> None:
            self.calls = 0

        def scan(self, resolve_candidate: object, timeout_seconds: float) -> None:
            self.calls += 1
            return None

    scanner = RecordingScanner()
    resolver = WechatAttachmentSourceResolver(
        ledger,
        _binding(),
        decrypted,
        account,
        None,
        tmp_path / "scoped-image-keys",
        image_key_scanner=scanner,
        active_owner_account_key_sha256=hashlib.sha256(OWNER_KEY.encode()).hexdigest(),
    )
    attachment = _attachment(
        kind="image",
        local_id=13,
        server_id=105,
        size=len(payload),
        content_md5=content_md5,
    )
    attachment["reference_kind"] = "context"
    attachment["observed_at"] = datetime.now(timezone.utc).isoformat()

    with pytest.raises(LedgerError) as raised:
        resolver.materialize(attachment, tmp_path / "context-no-scan.partial")

    assert raised.value.code == "ATTACHMENT_IMAGE_KEY_WAITING"
    assert scanner.calls == 0


def test_v2_image_returns_exact_hardlink_preview_without_claiming_original(tmp_path: Path) -> None:
    _, ledger, decrypted, account = _resolver(tmp_path)
    local_id = 12
    server_id = 104
    file_id = "c" * 32
    aes_key = b"syntheticAESkey1"
    xor_key = 0xD4
    preview = b"\xff\xd8\xff\xe0" + (b"preview-image" * 100) + b"\xff\xd9"
    preview_md5 = hashlib.md5(preview).hexdigest()
    original_md5 = hashlib.md5(b"unavailable-original").hexdigest()
    original_size = len(preview) + 5000
    _write_message_database(
        decrypted,
        f'<msg><img originsourcemd5="{original_md5}" hdlength="{original_size}"/></msg>',
        local_id=local_id,
        server_id=server_id,
        local_type=3,
    )
    _write_image_databases(
        decrypted,
        local_id=local_id,
        server_id=server_id,
        file_id=file_id,
        content_md5=preview_md5,
        size=len(preview),
        variant="",
    )
    source = (
        account
        / "msg"
        / "attach"
        / hashlib.md5(USERNAME.encode("utf-8")).hexdigest()
        / "2024-08"
        / "Img"
        / f"{file_id}.dat"
    )
    source.parent.mkdir(parents=True)
    source.write_bytes(_encrypt_v2_image(preview, aes_key, xor_key))
    key_file = tmp_path / "private-image-key.json"
    key_file.write_text(
        json.dumps({"version": 1, "aes_key": aes_key.decode("ascii"), "xor_key": xor_key}),
        encoding="utf-8",
    )
    resolver = WechatAttachmentSourceResolver(
        ledger,
        _binding(),
        decrypted,
        account,
        key_file,
        tmp_path / "scoped-image-keys",
    )
    destination = tmp_path / "preview.partial"

    source_kind = resolver.materialize(
        _attachment(
            kind="image",
            local_id=local_id,
            server_id=server_id,
            size=original_size,
            content_md5=original_md5,
        ),
        destination,
    )

    assert source_kind == "wechat_v2_image_preview"
    assert destination.read_bytes() == preview


def test_v2_image_does_not_accept_message_xml_cdn_key_as_local_key(tmp_path: Path) -> None:
    _, ledger, decrypted, account = _resolver(tmp_path)
    payload = b"\xff\xd8\xff" + b"x" * 1200 + b"\xff\xd9"
    content_md5 = hashlib.md5(payload).hexdigest()
    file_id = "b" * 32
    _write_message_database(
        decrypted,
        f'<msg><img aeskey="0123456789abcdef0123456789abcdef" md5="{content_md5}" '
        f'originsourcemd5="{content_md5}" hdlength="{len(payload)}"/></msg>',
        local_id=11,
        server_id=103,
        local_type=3,
    )
    _write_image_databases(
        decrypted,
        local_id=11,
        server_id=103,
        file_id=file_id,
        content_md5=content_md5,
        size=len(payload),
    )
    source = (
        account
        / "msg"
        / "attach"
        / hashlib.md5(USERNAME.encode("utf-8")).hexdigest()
        / "2024-08"
        / "Img"
        / f"{file_id}_h.dat"
    )
    source.parent.mkdir(parents=True)
    source.write_bytes(_encrypt_v2_image(payload, b"correctAESkey123", 0x88))
    wrong_key_file = tmp_path / "wrong-key.json"
    wrong_key_file.write_text(
        json.dumps({"version": 1, "aes_key": "0123456789abcdef", "xor_key": 0x88}),
        encoding="utf-8",
    )
    resolver = WechatAttachmentSourceResolver(
        ledger,
        _binding(),
        decrypted,
        account,
        wrong_key_file,
        tmp_path / "scoped-image-keys",
    )

    with pytest.raises(LedgerError) as raised:
        resolver.materialize(
            _attachment(
                kind="image",
                local_id=11,
                server_id=103,
                size=len(payload),
                content_md5=content_md5,
            ),
            tmp_path / "wrong.partial",
        )
    assert raised.value.code == "ATTACHMENT_IMAGE_KEY_WAITING"


def test_image_process_scan_requires_matching_active_owner_scope(tmp_path: Path) -> None:
    resolver, _, _, _ = _resolver(tmp_path)
    owner_scope = hashlib.sha256(OWNER_KEY.encode()).hexdigest()
    observed_at = datetime.now(timezone.utc).isoformat()

    assert not resolver._account_scan_allowed(owner_scope, observed_at)
    resolver.active_owner_account_key_sha256 = "0" * 64
    assert not resolver._account_scan_allowed(owner_scope, observed_at)
    resolver.active_owner_account_key_sha256 = owner_scope
    assert resolver._account_scan_allowed(owner_scope, observed_at)
