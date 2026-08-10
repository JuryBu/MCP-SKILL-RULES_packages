from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import pytest

from wechat_docs_mcp.route_verifier import VerifiedRoute
from wechat_docs_mcp.wechat_outbound_verifier import (
    AttachmentDatabaseVerificationError,
    WechatAttachmentDatabaseVerifier,
    WechatTextDatabaseVerifier,
)


USERNAME = "synthetic-room@chatroom"


def _route() -> VerifiedRoute:
    return VerifiedRoute(
        route_id="route-a",
        username=USERNAME,
        chat_type="group",
        display_title="Synthetic Room",
        identity_sha256="identity",
        owner_account_key_sha256="owner",
        username_sha256="username",
    )


def _database(root: Path, rows: list[tuple[object, ...]]) -> None:
    database = root / "message" / "message_0.db"
    database.parent.mkdir(parents=True)
    table = "Msg_" + hashlib.md5(USERNAME.encode("utf-8")).hexdigest()
    connection = sqlite3.connect(database)
    try:
        connection.execute(
            f"""
            CREATE TABLE [{table}](
              local_id INTEGER,server_id INTEGER,create_time INTEGER,status INTEGER,
              origin_source INTEGER,message_content TEXT,WCDB_CT_message_content INTEGER,
              real_sender_id INTEGER
            )
            """
        )
        connection.execute("CREATE TABLE Name2Id(user_name TEXT)")
        connection.execute("INSERT INTO Name2Id(rowid,user_name) VALUES(1,'synthetic-sender')")
        normalized_rows = [(*row, 1) if len(row) == 7 else row for row in rows]
        connection.executemany(f"INSERT INTO [{table}] VALUES(?,?,?,?,?,?,?,?)", normalized_rows)
        connection.commit()
    finally:
        connection.close()


def test_file_verification_requires_new_unique_outbound_row(tmp_path: Path) -> None:
    content_md5 = hashlib.md5(b"safe").hexdigest()
    xml = (
        "<msg><appmsg><title>sample.txt</title><md5>"
        f"{content_md5}</md5><appattach><totallen>4</totallen></appattach></appmsg></msg>"
    )
    _database(
        tmp_path,
        [
            (20, 100, 1_800_000_000, 2, 1, xml, 0),
            (21, 101, 1_800_000_001, 3, 2, xml, 0),
            (22, 102, 1_800_000_002, 2, 1, xml, 0),
        ],
    )
    verifier = WechatAttachmentDatabaseVerifier(
        tmp_path,
        lambda: None,
        timeout_seconds=0,
        poll_interval_seconds=0,
    )
    proof = verifier.verify(
        _route(),
        "wechat_file",
        {
            "file_name": "sample.txt",
            "byte_count": 4,
            "content_md5": content_md5,
        },
        21,
    )
    assert proof["local_id"] == 22
    assert proof["server_id"] == "102"
    assert proof["source_kind"] == "wechat_message_database"


def test_group_prefixed_file_xml_is_verified(tmp_path: Path) -> None:
    content_md5 = hashlib.md5(b"safe").hexdigest()
    xml = (
        "synthetic-sender:\n<msg><appmsg><title>sample.txt</title><md5>"
        f"{content_md5}</md5><appattach><totallen>4</totallen></appattach></appmsg></msg>"
    )
    _database(tmp_path, [(22, 102, 1_800_000_002, 2, 1, xml, 0)])
    verifier = WechatAttachmentDatabaseVerifier(
        tmp_path,
        lambda: None,
        timeout_seconds=0,
        poll_interval_seconds=0,
    )

    proof = verifier.verify(
        _route(),
        "wechat_file",
        {"file_name": "sample.txt", "byte_count": 4, "content_md5": content_md5},
        21,
    )

    assert proof["local_id"] == 22


def test_duplicate_outbound_rows_are_ambiguous(tmp_path: Path) -> None:
    content_md5 = hashlib.md5(b"safe").hexdigest()
    xml = (
        "<msg><appmsg><title>sample.txt</title><md5>"
        f"{content_md5}</md5><appattach><totallen>4</totallen></appattach></appmsg></msg>"
    )
    _database(
        tmp_path,
        [
            (22, 102, 1_800_000_002, 2, 1, xml, 0),
            (23, 103, 1_800_000_003, 2, 1, xml, 0),
        ],
    )
    verifier = WechatAttachmentDatabaseVerifier(
        tmp_path,
        lambda: None,
        timeout_seconds=0,
        poll_interval_seconds=0,
    )
    with pytest.raises(AttachmentDatabaseVerificationError) as raised:
        verifier.verify(
            _route(),
            "wechat_file",
            {"file_name": "sample.txt", "byte_count": 4, "content_md5": content_md5},
            21,
        )
    assert raised.value.code == "ATTACHMENT_DATABASE_CONFIRMATION_AMBIGUOUS"


def test_image_verification_matches_md5_and_size(tmp_path: Path) -> None:
    content_md5 = hashlib.md5(b"image").hexdigest()
    xml = f'<msg><img originsourcemd5="{content_md5}" hdlength="5" /></msg>'
    _database(tmp_path, [(7, 88, 1_800_000_010, 2, 1, xml, 0)])
    verifier = WechatAttachmentDatabaseVerifier(
        tmp_path,
        lambda: None,
        timeout_seconds=0,
        poll_interval_seconds=0,
    )
    proof = verifier.verify(
        _route(),
        "wechat_image",
        {"byte_count": 5, "content_md5": content_md5},
        6,
    )
    assert proof["local_id"] == 7


def test_image_verification_accepts_complete_original_pair(tmp_path: Path) -> None:
    original = b"original-image"
    thumbnail = b"thumb"
    original_md5 = hashlib.md5(original).hexdigest()
    thumbnail_md5 = hashlib.md5(thumbnail).hexdigest()
    xml = (
        f'<msg><img md5="{thumbnail_md5}" length="{len(thumbnail)}" '
        f'originsourcemd5="{original_md5}" hdlength="{len(original)}" /></msg>'
    )
    _database(tmp_path, [(7, 88, 1_800_000_010, 2, 1, xml, 0)])
    verifier = WechatAttachmentDatabaseVerifier(
        tmp_path,
        lambda: None,
        timeout_seconds=0,
        poll_interval_seconds=0,
    )

    proof = verifier.verify(
        _route(),
        "wechat_image",
        {"byte_count": len(original), "content_md5": original_md5},
        6,
    )

    assert proof["local_id"] == 7


def test_image_verification_rejects_md5_without_matching_size(tmp_path: Path) -> None:
    content_md5 = hashlib.md5(b"image").hexdigest()
    xml = f'<msg><img originsourcemd5="{content_md5}" hdlength="999" /></msg>'
    _database(tmp_path, [(7, 88, 1_800_000_010, 2, 1, xml, 0)])
    verifier = WechatAttachmentDatabaseVerifier(
        tmp_path,
        lambda: None,
        timeout_seconds=0,
        poll_interval_seconds=0,
    )

    with pytest.raises(AttachmentDatabaseVerificationError) as raised:
        verifier.verify(
            _route(),
            "wechat_image",
            {"byte_count": 5, "content_md5": content_md5},
            6,
        )

    assert raised.value.code == "ATTACHMENT_DATABASE_CONFIRMATION_TIMEOUT"


def test_baseline_refreshes_before_reading_max_local_id(tmp_path: Path) -> None:
    _database(tmp_path, [])
    calls: list[str] = []

    def refresh() -> None:
        calls.append("refresh")
        database = tmp_path / "message" / "message_0.db"
        table = "Msg_" + hashlib.md5(USERNAME.encode("utf-8")).hexdigest()
        connection = sqlite3.connect(database)
        try:
            connection.execute(
                f"INSERT INTO [{table}] VALUES(?,?,?,?,?,?,?,?)",
                (9, 90, 1_800_000_020, 2, 1, "<msg/>", 0, 1),
            )
            connection.commit()
        finally:
            connection.close()

    verifier = WechatAttachmentDatabaseVerifier(tmp_path, refresh, timeout_seconds=0)
    assert verifier.baseline(_route()) == 9
    assert calls == ["refresh"]


def test_refresh_failure_is_not_reported_as_success(tmp_path: Path) -> None:
    _database(tmp_path, [])

    def fail_refresh() -> None:
        raise RuntimeError("synthetic")

    verifier = WechatAttachmentDatabaseVerifier(tmp_path, fail_refresh, timeout_seconds=0)
    with pytest.raises(AttachmentDatabaseVerificationError) as raised:
        verifier.verify(
            _route(),
            "wechat_file",
            {"file_name": "sample.txt", "byte_count": 4, "content_md5": "0" * 32},
            0,
        )
    assert raised.value.code == "ATTACHMENT_DATABASE_REFRESH_FAILED"


def test_baseline_refresh_failure_is_not_reported_as_current(tmp_path: Path) -> None:
    _database(tmp_path, [])

    def fail_refresh() -> None:
        raise RuntimeError("synthetic")

    verifier = WechatAttachmentDatabaseVerifier(tmp_path, fail_refresh, timeout_seconds=0)
    with pytest.raises(AttachmentDatabaseVerificationError) as raised:
        verifier.baseline(_route())
    assert raised.value.code == "ATTACHMENT_DATABASE_REFRESH_FAILED"


def test_text_verification_requires_unique_exact_outbound_row(tmp_path: Path) -> None:
    _database(
        tmp_path,
        [
            (20, 100, 1_800_000_000, 3, 2, "marker", 0),
            (21, 101, 1_800_000_001, 2, 1, "other", 0),
            (22, 102, 1_800_000_002, 2, 1, "marker", 0),
        ],
    )
    verifier = WechatTextDatabaseVerifier(
        tmp_path,
        lambda: None,
        timeout_seconds=0,
        poll_interval_seconds=0,
    )

    proof = verifier.verify(_route(), "marker", 20)

    assert proof["local_id"] == 22
    assert proof["server_id"] == "102"
    assert proof["visible_text"] == "marker"
    assert proof["source_fingerprint"].endswith(":22:102")


def test_text_verification_rejects_duplicate_outbound_rows(tmp_path: Path) -> None:
    _database(
        tmp_path,
        [
            (22, 102, 1_800_000_002, 2, 1, "marker", 0),
            (23, 103, 1_800_000_003, 2, 1, "marker", 0),
        ],
    )
    verifier = WechatTextDatabaseVerifier(
        tmp_path,
        lambda: None,
        timeout_seconds=0,
        poll_interval_seconds=0,
    )

    with pytest.raises(AttachmentDatabaseVerificationError) as raised:
        verifier.verify(_route(), "marker", 20)

    assert raised.value.code == "TEXT_DATABASE_CONFIRMATION_AMBIGUOUS"


def test_text_verification_strips_exact_group_sender_prefix(tmp_path: Path) -> None:
    _database(
        tmp_path,
        [(22, 102, 1_800_000_002, 2, 1, "synthetic-sender:\nmarker", 0)],
    )
    verifier = WechatTextDatabaseVerifier(
        tmp_path,
        lambda: None,
        timeout_seconds=0,
        poll_interval_seconds=0,
    )

    proof = verifier.verify(_route(), "marker", 20)

    assert proof["visible_text"] == "marker"
    assert proof["local_id"] == 22
