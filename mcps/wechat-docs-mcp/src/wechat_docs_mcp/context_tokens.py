from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import math
import re
import time
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Union

from .ledger import LedgerError


_TOKEN_VERSION = 1
_BASE64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_HEX_SECRET_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_TOKEN_PREFIXES = {
    "message_ref": "msgctx_",
    "attachment_ref": "attctx_",
    "cursor": "ctxcur_",
}

NowValue = Union[Callable[[], object], datetime, int, float]


class ContextTokenCodec:
    def __init__(self, secret: bytes, now: NowValue | None = None) -> None:
        self._secret = self._validate_secret(secret)
        self._now = now

    @classmethod
    def from_file(cls, path: str | Path, now: NowValue | None = None) -> ContextTokenCodec:
        try:
            raw_secret = Path(path).read_bytes()
        except (OSError, TypeError, ValueError):
            raise LedgerError("KEY_NOT_READY", "上下文令牌密钥不可用") from None

        return cls(cls._secret_from_file_bytes(raw_secret), now=now)

    def encode_message_ref(self, payload: Mapping[str, Any]) -> str:
        return self._encode(payload, "message_ref")

    def decode_message_ref(self, token: str) -> dict[str, Any]:
        return self._decode(token, "message_ref", requires_expiry=False)

    def encode_attachment_ref(
        self, payload: Mapping[str, Any], ttl_seconds: int = 86400
    ) -> str:
        return self._encode(payload, "attachment_ref", ttl_seconds=ttl_seconds)

    def decode_attachment_ref(self, token: str) -> dict[str, Any]:
        return self._decode(token, "attachment_ref", requires_expiry=True)

    def encode_cursor(self, payload: Mapping[str, Any], ttl_seconds: int = 900) -> str:
        return self._encode(payload, "cursor", ttl_seconds=ttl_seconds)

    def decode_cursor(self, token: str) -> dict[str, Any]:
        return self._decode(token, "cursor", requires_expiry=True)

    @staticmethod
    def _validate_secret(secret: bytes) -> bytes:
        if not isinstance(secret, bytes) or len(secret) < 32:
            raise LedgerError("KEY_NOT_READY", "上下文令牌密钥不可用")
        return secret

    @classmethod
    def _secret_from_file_bytes(cls, raw_secret: bytes) -> bytes:
        candidate = raw_secret.strip(b" \t\r\n")
        try:
            text_candidate = candidate.decode("ascii")
        except UnicodeDecodeError:
            text_candidate = None

        if text_candidate is not None and len(text_candidate) == 64:
            if not _HEX_SECRET_RE.fullmatch(text_candidate):
                raise LedgerError("KEY_NOT_READY", "上下文令牌密钥不可用")
            return bytes.fromhex(text_candidate)

        return cls._validate_secret(raw_secret)

    def _encode(
        self,
        payload: Mapping[str, Any],
        token_type: str,
        ttl_seconds: int | None = None,
    ) -> str:
        claims = self._base_claims(payload, token_type)
        if ttl_seconds is not None:
            ttl = self._validate_ttl(ttl_seconds)
            issued_at = self._current_timestamp()
            claims["iat"] = issued_at
            claims["exp"] = issued_at + ttl

        serialized = self._canonical_json_bytes(claims)
        signature = hmac.new(self._secret, serialized, hashlib.sha256).digest()
        return (
            f"{_TOKEN_PREFIXES[token_type]}{self._base64url_encode(serialized)}."
            f"{self._base64url_encode(signature)}"
        )

    def _decode(
        self, token: str, expected_type: str, requires_expiry: bool
    ) -> dict[str, Any]:
        prefix = _TOKEN_PREFIXES[expected_type]
        if not isinstance(token, str):
            raise LedgerError("TOKEN_INVALID", "上下文令牌无效")

        observed_prefix = next(
            (known_prefix for known_prefix in _TOKEN_PREFIXES.values() if token.startswith(known_prefix)),
            None,
        )
        if observed_prefix is not None and observed_prefix != prefix:
            raise LedgerError("TOKEN_TYPE_MISMATCH", "上下文令牌类型不匹配")
        if observed_prefix != prefix:
            raise LedgerError("TOKEN_INVALID", "上下文令牌无效")

        body = token[len(prefix) :]
        if body.count(".") != 1:
            raise LedgerError("TOKEN_INVALID", "上下文令牌无效")
        encoded_payload, encoded_signature = body.split(".")
        payload_bytes = self._base64url_decode(encoded_payload)
        signature = self._base64url_decode(encoded_signature)
        expected_signature = hmac.new(self._secret, payload_bytes, hashlib.sha256).digest()
        if len(signature) != hashlib.sha256().digest_size or not hmac.compare_digest(
            signature, expected_signature
        ):
            raise LedgerError("TOKEN_INVALID", "上下文令牌无效")

        payload = self._json_object(payload_bytes)
        if self._canonical_json_bytes(payload) != payload_bytes:
            raise LedgerError("TOKEN_INVALID", "上下文令牌无效")
        self._validate_claims(payload, expected_type)

        if requires_expiry:
            self._validate_expiry(payload)
        return payload

    @staticmethod
    def _base_claims(payload: Mapping[str, Any], token_type: str) -> dict[str, Any]:
        if not isinstance(payload, Mapping):
            raise LedgerError("TOKEN_INVALID", "上下文令牌载荷必须是对象")
        try:
            claims = dict(payload)
        except (TypeError, ValueError):
            raise LedgerError("TOKEN_INVALID", "上下文令牌载荷必须是对象") from None
        if not all(isinstance(key, str) for key in claims):
            raise LedgerError("TOKEN_INVALID", "上下文令牌载荷必须使用字符串键")
        claims["v"] = _TOKEN_VERSION
        claims["type"] = token_type
        return claims

    @staticmethod
    def _validate_ttl(ttl_seconds: int) -> int:
        if type(ttl_seconds) is not int or ttl_seconds <= 0:
            raise LedgerError("TOKEN_TTL_INVALID", "上下文令牌有效期无效")
        return ttl_seconds

    def _current_timestamp(self) -> int:
        try:
            source = self._now
            value = time.time() if source is None else source() if callable(source) else source
            if isinstance(value, datetime):
                if value.tzinfo is None:
                    raise LedgerError("TOKEN_INVALID", "上下文令牌当前时间无效")
                timestamp = value.astimezone(timezone.utc).timestamp()
            else:
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise LedgerError("TOKEN_INVALID", "上下文令牌当前时间无效")
                timestamp = float(value)
            if not math.isfinite(timestamp):
                raise LedgerError("TOKEN_INVALID", "上下文令牌当前时间无效")
            return math.floor(timestamp)
        except LedgerError:
            raise
        except Exception:
            raise LedgerError("TOKEN_INVALID", "上下文令牌当前时间无效") from None

    @staticmethod
    def _canonical_json_bytes(value: object) -> bytes:
        try:
            return json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError, OverflowError):
            raise LedgerError("TOKEN_INVALID", "上下文令牌载荷无效") from None

    @classmethod
    def _base64url_encode(cls, value: bytes) -> str:
        return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")

    @classmethod
    def _base64url_decode(cls, value: str) -> bytes:
        if not isinstance(value, str) or not value or not _BASE64URL_RE.fullmatch(value):
            raise LedgerError("TOKEN_INVALID", "上下文令牌无效")
        try:
            decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        except (ValueError, binascii.Error):
            raise LedgerError("TOKEN_INVALID", "上下文令牌无效") from None
        if cls._base64url_encode(decoded) != value:
            raise LedgerError("TOKEN_INVALID", "上下文令牌无效")
        return decoded

    @classmethod
    def _json_object(cls, payload_bytes: bytes) -> dict[str, Any]:
        try:
            decoded = payload_bytes.decode("utf-8")
            payload = json.loads(decoded, object_pairs_hook=cls._unique_object)
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
            raise LedgerError("TOKEN_INVALID", "上下文令牌无效") from None
        if not isinstance(payload, dict):
            raise LedgerError("TOKEN_INVALID", "上下文令牌无效")
        return payload

    @staticmethod
    def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    @staticmethod
    def _validate_claims(payload: dict[str, Any], expected_type: str) -> None:
        if type(payload.get("v")) is not int or payload["v"] != _TOKEN_VERSION:
            raise LedgerError("TOKEN_INVALID", "上下文令牌无效")
        token_type = payload.get("type")
        if not isinstance(token_type, str):
            raise LedgerError("TOKEN_INVALID", "上下文令牌无效")
        if token_type != expected_type:
            raise LedgerError("TOKEN_TYPE_MISMATCH", "上下文令牌类型不匹配")

    def _validate_expiry(self, payload: dict[str, Any]) -> None:
        issued_at = payload.get("iat")
        expires_at = payload.get("exp")
        if type(issued_at) is not int or type(expires_at) is not int or expires_at <= issued_at:
            raise LedgerError("TOKEN_INVALID", "上下文令牌无效")
        if self._current_timestamp() >= expires_at:
            raise LedgerError("TOKEN_EXPIRED", "上下文令牌已过期")
