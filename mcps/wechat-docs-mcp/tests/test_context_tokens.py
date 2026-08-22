from __future__ import annotations

from pathlib import Path

import pytest

from wechat_docs_mcp.context_tokens import ContextTokenCodec
from wechat_docs_mcp.ledger import LedgerError


def make_codec(path: Path, now: object = 1_700_000_000) -> ContextTokenCodec:
    return ContextTokenCodec.from_file(path, now=now)


def test_message_refs_are_stable_and_round_trip(tmp_path: Path) -> None:
    secret_path = tmp_path / "context.key"
    secret_path.write_bytes(bytes(range(32)))
    codec = make_codec(secret_path)

    first = codec.encode_message_ref(
        {"route_id": "route-a", "message_id": "message-1", "type": "ignored", "v": 99}
    )
    second = codec.encode_message_ref({"message_id": "message-1", "route_id": "route-a"})

    assert first.startswith("msgctx_")
    assert first == second
    assert codec.decode_message_ref(first) == {
        "message_id": "message-1",
        "route_id": "route-a",
        "type": "message_ref",
        "v": 1,
    }


def test_attachment_and_cursor_round_trip(tmp_path: Path) -> None:
    secret_path = tmp_path / "context.key"
    secret_path.write_bytes(bytes(range(32)))
    codec = make_codec(secret_path)

    attachment = codec.encode_attachment_ref({"attachment_id": "attachment-1"}, ttl_seconds=60)
    cursor = codec.encode_cursor({"offset": 5, "query": "recent"}, ttl_seconds=30)

    assert attachment.startswith("attctx_")
    assert codec.decode_attachment_ref(attachment) == {
        "attachment_id": "attachment-1",
        "exp": 1_700_000_060,
        "iat": 1_700_000_000,
        "type": "attachment_ref",
        "v": 1,
    }
    assert cursor.startswith("ctxcur_")
    assert codec.decode_cursor(cursor) == {
        "exp": 1_700_000_030,
        "iat": 1_700_000_000,
        "offset": 5,
        "query": "recent",
        "type": "cursor",
        "v": 1,
    }


def test_tampered_token_is_rejected(tmp_path: Path) -> None:
    secret_path = tmp_path / "context.key"
    secret_path.write_bytes(bytes(range(32)))
    codec = make_codec(secret_path)
    token = codec.encode_attachment_ref({"attachment_id": "attachment-1"})
    prefix, body = token[:7], token[7:]
    encoded_payload, encoded_signature = body.split(".")
    replacement = "A" if encoded_payload[0] != "A" else "B"
    tampered = f"{prefix}{replacement}{encoded_payload[1:]}.{encoded_signature}"

    with pytest.raises(LedgerError) as raised:
        codec.decode_attachment_ref(tampered)

    assert raised.value.code == "TOKEN_INVALID"


def test_cross_type_token_is_rejected(tmp_path: Path) -> None:
    secret_path = tmp_path / "context.key"
    secret_path.write_bytes(bytes(range(32)))
    codec = make_codec(secret_path)

    with pytest.raises(LedgerError) as raised:
        codec.decode_attachment_ref(codec.encode_message_ref({"message_id": "message-1"}))

    assert raised.value.code == "TOKEN_TYPE_MISMATCH"


def test_expiring_token_is_rejected_after_expiry(tmp_path: Path) -> None:
    secret_path = tmp_path / "context.key"
    secret_path.write_bytes(bytes(range(32)))
    clock = {"now": 100}
    codec = make_codec(secret_path, now=lambda: clock["now"])
    token = codec.encode_cursor({"offset": 1}, ttl_seconds=2)
    clock["now"] = 102

    with pytest.raises(LedgerError) as raised:
        codec.decode_cursor(token)

    assert raised.value.code == "TOKEN_EXPIRED"


@pytest.mark.parametrize("ttl_seconds", [0, -1, True, 1.5, "60"])
def test_invalid_ttl_is_rejected(tmp_path: Path, ttl_seconds: object) -> None:
    secret_path = tmp_path / "context.key"
    secret_path.write_bytes(bytes(range(32)))
    codec = make_codec(secret_path)

    with pytest.raises(LedgerError) as raised:
        codec.encode_attachment_ref({"attachment_id": "attachment-1"}, ttl_seconds=ttl_seconds)  # type: ignore[arg-type]

    assert raised.value.code == "TOKEN_TTL_INVALID"


def test_secret_file_forms_and_fail_closed(tmp_path: Path) -> None:
    raw_path = tmp_path / "raw.key"
    raw_path.write_bytes(bytes(range(32)))
    raw_codec = make_codec(raw_path)
    assert raw_codec.decode_message_ref(raw_codec.encode_message_ref({"id": "raw"}))["id"] == "raw"

    hex_path = tmp_path / "hex.key"
    hex_path.write_text(bytes(range(32)).hex() + "\n", encoding="utf-8")
    hex_codec = make_codec(hex_path)
    assert hex_codec.decode_message_ref(hex_codec.encode_message_ref({"id": "hex"}))["id"] == "hex"

    short_path = tmp_path / "short.key"
    short_path.write_bytes(b"x" * 31)
    invalid_hex_path = tmp_path / "invalid-hex.key"
    invalid_hex_path.write_text("z" * 64, encoding="utf-8")

    for path in (tmp_path / "missing.key", short_path, invalid_hex_path):
        with pytest.raises(LedgerError) as raised:
            ContextTokenCodec.from_file(path)
        assert raised.value.code == "KEY_NOT_READY"
