from __future__ import annotations

import hmac
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from .context_tokens import ContextTokenCodec
from .db_observer import RouteBinding
from .ledger import EventLedger, LedgerError
from .message_context import ContextRouteAuthorizer, ContextRouteScope


_MD5_PATTERN = re.compile(r"[0-9a-f]{32}")
_SUPPORTED_KINDS = {"file", "image", "sticker"}


class ContextAttachmentResolver:
    def __init__(
        self,
        ledger: EventLedger,
        binding_document: Mapping[str, Any],
        bindings: Sequence[RouteBinding],
        decrypted_dir: str | Path,
        token_codec: ContextTokenCodec,
        *,
        active_owner_account_key_sha256: str = "",
    ) -> None:
        self.token_codec = token_codec
        self.authorizer = ContextRouteAuthorizer(
            ledger,
            binding_document,
            bindings,
            decrypted_dir,
            active_owner_account_key_sha256=active_owner_account_key_sha256,
        )

    @staticmethod
    def _scope_values(scope: ContextRouteScope) -> dict[str, Any]:
        return {
            "subscription_id": str(scope.subscription["subscription_id"]),
            "route_id": str(scope.subscription["route_id"]),
            "generation": int(scope.subscription["generation"]),
            "route_identity_sha256": scope.verified_route.identity_sha256,
            "owner_account_key_sha256": scope.verified_route.owner_account_key_sha256,
            "username_sha256": scope.verified_route.username_sha256,
            "chat_type": scope.verified_route.chat_type,
        }

    @classmethod
    def _validate_scope(
        cls,
        scope: ContextRouteScope,
        payload: Mapping[str, Any],
    ) -> None:
        for key, expected in cls._scope_values(scope).items():
            actual = payload.get(key)
            matches = (
                isinstance(expected, str)
                and isinstance(actual, str)
                and hmac.compare_digest(actual, expected)
            ) or (isinstance(expected, int) and actual == expected)
            if not matches:
                raise LedgerError(
                    "ATTCTX_SCOPE_MISMATCH",
                    "历史附件引用不属于当前 subscription/route/account",
                )

    @staticmethod
    def _positive_integer(payload: Mapping[str, Any], key: str) -> int:
        try:
            value = int(payload[key])
        except (KeyError, TypeError, ValueError) as error:
            raise LedgerError("ATTCTX_TOKEN_INVALID", f"attctx 缺少有效 {key}") from error
        if value < 1:
            raise LedgerError("ATTCTX_TOKEN_INVALID", f"attctx {key} 必须大于零")
        return value

    def resolve(self, subscription_id: str, attachment_ref: str) -> dict[str, Any]:
        payload = self.token_codec.decode_attachment_ref(attachment_ref)
        scope = self.authorizer.resolve(subscription_id)
        self._validate_scope(scope, payload)
        local_id = self._positive_integer(payload, "local_id")
        byte_count = self._positive_integer(payload, "byte_count")
        cutoff_local_id = self._positive_integer(payload, "source_cutoff_local_id")
        server_id = str(payload.get("server_id") or "").strip()
        kind = str(payload.get("kind") or "").strip()
        content_md5 = str(payload.get("content_md5") or "").strip().casefold()
        if not server_id or kind not in _SUPPORTED_KINDS or not _MD5_PATTERN.fullmatch(content_md5):
            raise LedgerError("ATTCTX_TOKEN_INVALID", "attctx 消息身份或附件元数据无效")
        current_max_local_id = scope.observer.max_local_id(scope.binding)
        if current_max_local_id < cutoff_local_id:
            raise LedgerError(
                "ATTCTX_SOURCE_CUTOFF_DRIFT",
                "当前 route 源快照早于 attctx 签发时的 cutoff",
            )
        rows = scope.observer.read_route_messages(
            scope.binding,
            minimum_local_id=local_id,
            maximum_local_id=local_id,
        )
        matches = [
            row
            for row in rows
            if str(row.payload.get("server_id") or "") == server_id
        ]
        if len(matches) != 1:
            raise LedgerError(
                "ATTCTX_SOURCE_NOT_FOUND",
                "无法在授权 route 中唯一定位 attctx 源消息",
            )
        observation = matches[0]
        source_md5 = str(observation.payload.get("attachment_md5") or "").strip().casefold()
        try:
            source_size = int(observation.payload.get("attachment_size"))
        except (TypeError, ValueError):
            source_size = 0
        if (
            observation.event_type != kind
            or not hmac.compare_digest(source_md5, content_md5)
            or source_size != byte_count
        ):
            raise LedgerError(
                "ATTCTX_SOURCE_DRIFT",
                "attctx 源消息的 kind/MD5/size 已变化",
            )
        return {
            "attachment_ref": attachment_ref,
            "reference_kind": "context",
            "event_id": None,
            "route_id": scope.subscription["route_id"],
            "kind": kind,
            "local_id": local_id,
            "server_id": server_id,
            "file_name": observation.payload.get("attachment_name"),
            "byte_count": byte_count,
            "content_md5": content_md5,
            "mime_hint": observation.payload.get("attachment_mime"),
            "width": observation.payload.get("attachment_width"),
            "height": observation.payload.get("attachment_height"),
            "created_at": observation.occurred_at,
            "observed_at": None,
            "source_fingerprint": observation.source_fingerprint,
            "payload": dict(observation.payload),
            "message_ref": payload.get("message_ref"),
            "source_cutoff_local_id": cutoff_local_id,
        }
