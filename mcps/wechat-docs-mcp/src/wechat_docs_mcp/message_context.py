from __future__ import annotations

import hashlib
import hmac
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .context_tokens import ContextTokenCodec
from .db_observer import DbObserver, Observation, RouteBinding
from .ledger import EventLedger, LedgerError
from .route_verifier import PrivateBindingRouteVerifier, RouteVerificationError, VerifiedRoute


MAX_CONTEXT_MESSAGES = 200
MAX_CONTEXT_CHARACTERS = 100_000
MAX_CONTEXT_SOURCE_ROWS = 20_000
MAX_CONTEXT_NEIGHBOURS = 100
INITIAL_CONTEXT_SCAN_ROWS = 32
DEFAULT_ATTACHMENT_REF_TTL_SECONDS = 24 * 60 * 60
_ATTACHMENT_KINDS = {"file", "image", "sticker"}
_DIRECTIONS = {"inbound", "outbound", "unknown"}
_KINDS = {
    "app",
    "file",
    "image",
    "link",
    "location",
    "mini_program",
    "revoke",
    "sticker",
    "system",
    "text",
    "unknown",
    "unknown_app",
    "video",
    "voice",
}
_MD5_PATTERN = re.compile(r"[0-9a-f]{32}")


@dataclass(frozen=True)
class MessageIdentity:
    local_id: int
    server_id: str


@dataclass(frozen=True)
class ContextRouteScope:
    subscription: dict[str, Any]
    ledger_route: dict[str, Any]
    verified_route: VerifiedRoute
    binding: RouteBinding
    observer: DbObserver


def _canonical_sha256(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class ContextRouteAuthorizer:
    def __init__(
        self,
        ledger: EventLedger,
        binding_document: Mapping[str, Any],
        bindings: Sequence[RouteBinding],
        decrypted_dir: str | Path,
        *,
        active_owner_account_key_sha256: str = "",
    ) -> None:
        self.ledger = ledger
        self.binding_document = binding_document
        self.bindings = tuple(bindings)
        self.decrypted_dir = Path(decrypted_dir)
        self.active_owner_account_key_sha256 = (
            active_owner_account_key_sha256.strip().casefold()
        )

    def resolve(self, subscription_id: str) -> ContextRouteScope:
        subscription = self.ledger.get_subscription(subscription_id)
        if subscription["state"] != "active":
            raise LedgerError(
                "CONTEXT_SUBSCRIPTION_NOT_ACTIVE",
                "context read 只允许 active subscription",
            )
        if not bool(subscription.get("context_read_capability")):
            raise LedgerError(
                "CONTEXT_CAPABILITY_DISABLED",
                "subscription 未启用独立 context_read_capability",
            )
        if not str(subscription.get("policy_ref") or "").strip():
            raise LedgerError(
                "CONTEXT_POLICY_REF_REQUIRED",
                "subscription 缺少 context read policy_ref，拒绝读取历史上下文",
            )
        ledger_route = self.ledger.get_route(str(subscription["route_id"]))
        try:
            verified = PrivateBindingRouteVerifier(self.binding_document).verify_identity(
                str(subscription["route_id"]),
                ledger_route,
            )
        except RouteVerificationError as error:
            raise LedgerError("CONTEXT_ROUTE_UNVERIFIED", str(error)) from error
        if not self.active_owner_account_key_sha256:
            raise LedgerError(
                "CONTEXT_ACTIVE_OWNER_NOT_CONFIGURED",
                "当前活动微信账号作用域未配置，拒绝读取历史上下文",
            )
        if not hmac.compare_digest(
            self.active_owner_account_key_sha256,
            verified.owner_account_key_sha256.casefold(),
        ):
            raise LedgerError(
                "CONTEXT_OWNER_ACCOUNT_MISMATCH",
                "当前微信账号与 subscription route 的 owner scope 不一致",
            )
        matches = [
            binding
            for binding in self.bindings
            if binding.route_id == subscription["route_id"]
            and binding.username == verified.username
            and binding.chat_type == verified.chat_type
        ]
        if len(matches) != 1:
            raise LedgerError(
                "CONTEXT_ROUTE_BINDING_AMBIGUOUS",
                "无法从 private binding 唯一解析 subscription route",
            )
        return ContextRouteScope(
            subscription=dict(subscription),
            ledger_route=dict(ledger_route),
            verified_route=verified,
            binding=matches[0],
            observer=DbObserver(self.decrypted_dir, [matches[0]]),
        )


class MessageContextReader:
    def __init__(
        self,
        ledger: EventLedger,
        binding_document: Mapping[str, Any],
        bindings: Sequence[RouteBinding],
        decrypted_dir: str | Path,
        token_codec: ContextTokenCodec,
        *,
        active_owner_account_key_sha256: str = "",
        attachment_ref_ttl_seconds: int = DEFAULT_ATTACHMENT_REF_TTL_SECONDS,
    ) -> None:
        self.ledger = ledger
        self.token_codec = token_codec
        self.authorizer = ContextRouteAuthorizer(
            ledger,
            binding_document,
            bindings,
            decrypted_dir,
            active_owner_account_key_sha256=active_owner_account_key_sha256,
        )
        self.attachment_ref_ttl_seconds = attachment_ref_ttl_seconds

    def _event_identity(self, scope: ContextRouteScope, event_id: str) -> MessageIdentity:
        connection = self.ledger._connect()
        try:
            row = connection.execute(
                """
                SELECT events.route_id,events.payload_json
                FROM events
                JOIN event_deliveries
                  ON event_deliveries.event_id=events.event_id
                WHERE events.event_id=?
                  AND event_deliveries.subscription_id=?
                """,
                (event_id, scope.subscription["subscription_id"]),
            ).fetchone()
        finally:
            connection.close()
        if row is None:
            raise LedgerError(
                "CONTEXT_ANCHOR_NOT_AUTHORIZED",
                "anchor event 未投递给当前 subscription",
            )
        if row["route_id"] != scope.subscription["route_id"]:
            raise LedgerError(
                "CONTEXT_ANCHOR_ROUTE_MISMATCH",
                "anchor event 不属于当前 subscription route",
            )
        payload = json.loads(row["payload_json"])
        return self._payload_identity(payload, "anchor event")

    @staticmethod
    def _payload_identity(payload: Mapping[str, Any], label: str) -> MessageIdentity:
        try:
            local_id = int(payload.get("local_id"))
        except (TypeError, ValueError) as error:
            raise LedgerError(
                "CONTEXT_ANCHOR_IDENTITY_MISSING",
                f"{label} 缺少有效 local_id",
            ) from error
        server_id = str(payload.get("server_id") or "").strip()
        if local_id < 1 or not server_id:
            raise LedgerError(
                "CONTEXT_ANCHOR_IDENTITY_MISSING",
                f"{label} 缺少精确消息身份",
            )
        return MessageIdentity(local_id=local_id, server_id=server_id)

    def _message_ref_identity(
        self,
        scope: ContextRouteScope,
        token: str,
    ) -> tuple[MessageIdentity, int, str]:
        payload = self.token_codec.decode_message_ref(token)
        self._validate_token_scope(scope, payload)
        try:
            cutoff_local_id = int(payload["source_cutoff_local_id"])
        except (KeyError, TypeError, ValueError) as error:
            raise LedgerError(
                "CONTEXT_TOKEN_INVALID",
                "message_ref 缺少有效 source cutoff",
            ) from error
        if cutoff_local_id < 1:
            raise LedgerError(
                "CONTEXT_TOKEN_INVALID",
                "message_ref source cutoff 必须大于零",
            )
        payload_sha256 = str(payload.get("payload_sha256") or "").strip().casefold()
        if len(payload_sha256) != 64 or any(
            character not in "0123456789abcdef" for character in payload_sha256
        ):
            raise LedgerError(
                "CONTEXT_TOKEN_INVALID",
                "message_ref 缺少有效 source payload hash",
            )
        return (
            self._payload_identity(payload, "message_ref"),
            cutoff_local_id,
            payload_sha256,
        )

    @staticmethod
    def _token_scope(scope: ContextRouteScope) -> dict[str, Any]:
        return {
            "subscription_id": str(scope.subscription["subscription_id"]),
            "route_id": str(scope.subscription["route_id"]),
            "generation": int(scope.subscription["generation"]),
            "route_identity_sha256": scope.verified_route.identity_sha256,
            "owner_account_key_sha256": scope.verified_route.owner_account_key_sha256,
            "username_sha256": scope.verified_route.username_sha256,
            "chat_type": scope.verified_route.chat_type,
        }

    def _validate_token_scope(
        self,
        scope: ContextRouteScope,
        payload: Mapping[str, Any],
    ) -> None:
        for key, expected in self._token_scope(scope).items():
            actual = payload.get(key)
            matches = (
                isinstance(expected, str)
                and isinstance(actual, str)
                and hmac.compare_digest(actual, expected)
            ) or (isinstance(expected, int) and actual == expected)
            if not matches:
                raise LedgerError(
                    "CONTEXT_TOKEN_SCOPE_MISMATCH",
                    "context token 不属于当前 subscription/route/account",
                )

    def _resolve_anchor(
        self,
        scope: ContextRouteScope,
        value: str,
    ) -> tuple[MessageIdentity, int | None]:
        expected_payload_sha256: str | None = None
        if value.startswith("msgctx_"):
            identity, cutoff_local_id, expected_payload_sha256 = self._message_ref_identity(
                scope, value
            )
        else:
            identity = self._event_identity(scope, value)
            cutoff_local_id = None
        observation = self._source_message(scope, identity)
        if expected_payload_sha256 is not None and not hmac.compare_digest(
            expected_payload_sha256,
            _canonical_sha256(observation.payload),
        ):
            raise LedgerError(
                "CONTEXT_SOURCE_DRIFT",
                "message_ref 对应的源消息内容已变化，拒绝沿用旧锚点",
            )
        return identity, cutoff_local_id

    def _single_anchor_slice(
        self,
        scope: ContextRouteScope,
        anchor: MessageIdentity,
        cutoff_local_id: int,
        before: int,
        after: int,
        directions: Sequence[str],
        kinds: Sequence[str],
    ) -> tuple[list[Observation], bool, bool]:
        rows_before = min(
            MAX_CONTEXT_SOURCE_ROWS,
            max(INITIAL_CONTEXT_SCAN_ROWS, before * 2),
        ) if before else 0
        rows_after = min(
            MAX_CONTEXT_SOURCE_ROWS,
            max(INITIAL_CONTEXT_SCAN_ROWS, after * 2),
        ) if after else 0
        while True:
            source_rows = scope.observer.read_route_message_window(
                scope.binding,
                anchor.local_id,
                maximum_local_id=cutoff_local_id,
                rows_before=rows_before,
                rows_after=rows_after,
            )
            matching_indexes = [
                index
                for index, row in enumerate(source_rows)
                if self._observation_identity(row) == anchor
            ]
            if len(matching_indexes) != 1:
                raise LedgerError(
                    "CONTEXT_ANCHOR_SOURCE_MISSING",
                    "无法在 source cutoff 内唯一定位 anchor",
                )
            anchor_index = matching_indexes[0]
            raw_before = source_rows[:anchor_index]
            raw_after = source_rows[anchor_index + 1 :]
            eligible_before = [
                row for row in raw_before if self._eligible(row, directions, kinds)
            ]
            eligible_after = [
                row for row in raw_after if self._eligible(row, directions, kinds)
            ]
            expand_before = (
                before > len(eligible_before)
                and rows_before < MAX_CONTEXT_SOURCE_ROWS
                and len(raw_before) >= rows_before
            )
            expand_after = (
                after > len(eligible_after)
                and rows_after < MAX_CONTEXT_SOURCE_ROWS
                and len(raw_after) >= rows_after
            )
            if not expand_before and not expand_after:
                anchor_row = source_rows[anchor_index]
                selected = [
                    *eligible_before[-before:],
                    *([anchor_row] if self._eligible(anchor_row, directions, kinds) else []),
                    *eligible_after[:after],
                ]
                before_limited = (
                    before > len(eligible_before)
                    and rows_before >= MAX_CONTEXT_SOURCE_ROWS
                    and len(raw_before) >= MAX_CONTEXT_SOURCE_ROWS
                )
                after_limited = (
                    after > len(eligible_after)
                    and rows_after >= MAX_CONTEXT_SOURCE_ROWS
                    and len(raw_after) >= MAX_CONTEXT_SOURCE_ROWS
                )
                return selected, before_limited, after_limited
            if expand_before:
                rows_before = min(MAX_CONTEXT_SOURCE_ROWS, rows_before * 2)
            if expand_after:
                rows_after = min(MAX_CONTEXT_SOURCE_ROWS, rows_after * 2)

    @staticmethod
    def _observation_identity(observation: Observation) -> MessageIdentity:
        return MessageIdentity(
            local_id=int(observation.payload["local_id"]),
            server_id=str(observation.payload["server_id"]),
        )

    def _source_message(
        self,
        scope: ContextRouteScope,
        identity: MessageIdentity,
    ) -> Observation:
        rows = scope.observer.read_route_messages(
            scope.binding,
            minimum_local_id=identity.local_id,
            maximum_local_id=identity.local_id,
        )
        matches = [
            row
            for row in rows
            if str(row.payload.get("server_id") or "") == identity.server_id
        ]
        if len(matches) != 1:
            raise LedgerError(
                "CONTEXT_ANCHOR_SOURCE_MISSING",
                "无法在授权 route 的只读源中唯一定位 anchor",
            )
        return matches[0]

    @staticmethod
    def _validate_filters(
        include_directions: Sequence[str] | None,
        include_kinds: Sequence[str] | None,
        *,
        text_only: bool,
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        directions = tuple(dict.fromkeys(include_directions or ("inbound", "outbound")))
        if not directions or any(direction not in _DIRECTIONS for direction in directions):
            raise LedgerError(
                "CONTEXT_DIRECTION_FILTER_INVALID",
                "include_directions 只能包含 inbound/outbound/unknown",
            )
        kinds = tuple(dict.fromkeys(str(kind).strip() for kind in include_kinds or () if str(kind).strip()))
        if any(kind not in _KINDS for kind in kinds):
            raise LedgerError(
                "CONTEXT_KIND_FILTER_INVALID",
                "include_kinds 包含不受支持的消息类型",
            )
        if text_only and kinds and kinds != ("text",):
            raise LedgerError(
                "CONTEXT_KIND_FILTER_CONFLICT",
                "text_only=true 时 include_kinds 只能为空或仅含 text",
            )
        return directions, (("text",) if text_only else kinds)

    @staticmethod
    def _eligible(
        observation: Observation,
        directions: Sequence[str],
        kinds: Sequence[str],
    ) -> bool:
        if observation.payload.get("direction") not in directions:
            return False
        return not kinds or observation.event_type in kinds

    def _ledger_metadata(
        self,
        scope: ContextRouteScope,
        observation: Observation,
    ) -> dict[str, Any]:
        connection = self.ledger._connect()
        try:
            row = connection.execute(
                """
                SELECT events.event_id,attachments.attachment_ref,
                       EXISTS(
                         SELECT 1 FROM event_deliveries
                         WHERE event_deliveries.subscription_id=?
                           AND event_deliveries.event_id=events.event_id
                       ) AS delivered
                FROM events
                LEFT JOIN attachments USING(event_id)
                WHERE events.route_id=? AND events.source_fingerprint=?
                """,
                (
                    scope.subscription["subscription_id"],
                    scope.subscription["route_id"],
                    observation.source_fingerprint,
                ),
            ).fetchone()
        finally:
            connection.close()
        return dict(row) if row is not None else {}

    def _message_ref(
        self,
        scope: ContextRouteScope,
        identity: MessageIdentity,
        cutoff_local_id: int,
        payload_sha256: str,
    ) -> str:
        return self.token_codec.encode_message_ref(
            {
                **self._token_scope(scope),
                "local_id": identity.local_id,
                "server_id": identity.server_id,
                "source_cutoff_local_id": cutoff_local_id,
                "payload_sha256": payload_sha256,
            }
        )

    def _attachment_summary(
        self,
        scope: ContextRouteScope,
        observation: Observation,
        identity: MessageIdentity,
        ledger_metadata: Mapping[str, Any],
        cutoff_local_id: int,
        message_ref: str,
    ) -> dict[str, Any] | None:
        if observation.event_type not in _ATTACHMENT_KINDS:
            return None
        payload = observation.payload
        content_md5 = str(payload.get("attachment_md5") or "").strip().casefold()
        try:
            byte_count = int(payload.get("attachment_size"))
        except (TypeError, ValueError):
            byte_count = 0
        summary: dict[str, Any] = {
            "kind": observation.event_type,
            "file_name": payload.get("attachment_name"),
            "byte_count": byte_count or None,
            "content_md5": content_md5 or None,
            "mime_hint": payload.get("attachment_mime"),
            "width": payload.get("attachment_width"),
            "height": payload.get("attachment_height"),
            "message_ref": message_ref,
        }
        if ledger_metadata.get("attachment_ref") and bool(ledger_metadata.get("delivered")):
            summary.update(
                {
                    "attachment_ref": ledger_metadata["attachment_ref"],
                    "attachment_ref_kind": "ledger",
                    "attachment_state": "reference_ready",
                }
            )
            return summary
        if not _MD5_PATTERN.fullmatch(content_md5) or byte_count < 1:
            summary.update(
                {
                    "attachment_ref": None,
                    "attachment_ref_kind": None,
                    "attachment_state": "metadata_incomplete",
                }
            )
            return summary
        summary.update(
            {
                "attachment_ref": self.token_codec.encode_attachment_ref(
                    {
                        **self._token_scope(scope),
                        "local_id": identity.local_id,
                        "server_id": identity.server_id,
                        "kind": observation.event_type,
                        "content_md5": content_md5,
                        "byte_count": byte_count,
                        "source_cutoff_local_id": cutoff_local_id,
                        "message_ref": message_ref,
                    },
                    ttl_seconds=self.attachment_ref_ttl_seconds,
                ),
                "attachment_ref_kind": "context",
                "attachment_state": "reference_ready_not_materialized",
            }
        )
        return summary

    def _message_item(
        self,
        scope: ContextRouteScope,
        observation: Observation,
        cutoff_local_id: int,
    ) -> dict[str, Any]:
        identity = self._observation_identity(observation)
        ledger_metadata = self._ledger_metadata(scope, observation)
        message_ref = self._message_ref(
            scope,
            identity,
            cutoff_local_id,
            _canonical_sha256(observation.payload),
        )
        attachment = self._attachment_summary(
            scope,
            observation,
            identity,
            ledger_metadata,
            cutoff_local_id,
            message_ref,
        )
        item = {
            "message_ref": message_ref,
            "event_id": (
                ledger_metadata.get("event_id")
                if bool(ledger_metadata.get("delivered"))
                else None
            ),
            "local_id": identity.local_id,
            "server_id": identity.server_id,
            "kind": observation.event_type,
            "direction": observation.payload.get("direction"),
            "direction_basis": observation.payload.get("direction_basis"),
            "sender_display": observation.payload.get("sender_display"),
            "occurred_at": observation.occurred_at,
            "visible_text": str(observation.payload.get("visible_text") or ""),
            "attachment": attachment,
        }
        return item

    def read(
        self,
        subscription_id: str,
        *,
        anchor_event_id: str = "",
        anchor_message_ref: str = "",
        before: int = 5,
        after: int = 2,
        start_anchor: str = "",
        end_anchor: str = "",
        include_directions: Sequence[str] | None = None,
        include_kinds: Sequence[str] | None = None,
        text_only: bool = False,
        max_messages: int = 50,
        max_chars: int = 20_000,
        continuation_cursor: str = "",
    ) -> dict[str, Any]:
        if not 0 <= before <= MAX_CONTEXT_NEIGHBOURS or not 0 <= after <= MAX_CONTEXT_NEIGHBOURS:
            raise LedgerError(
                "CONTEXT_NEIGHBOUR_LIMIT_INVALID",
                f"before/after 必须在 0..{MAX_CONTEXT_NEIGHBOURS} 范围内",
            )
        if not 1 <= max_messages <= MAX_CONTEXT_MESSAGES:
            raise LedgerError(
                "CONTEXT_MESSAGE_LIMIT_INVALID",
                f"max_messages 必须在 1..{MAX_CONTEXT_MESSAGES} 范围内",
            )
        if not 1 <= max_chars <= MAX_CONTEXT_CHARACTERS:
            raise LedgerError(
                "CONTEXT_CHARACTER_LIMIT_INVALID",
                f"max_chars 必须在 1..{MAX_CONTEXT_CHARACTERS} 范围内",
            )
        directions, kinds = self._validate_filters(
            include_directions,
            include_kinds,
            text_only=text_only,
        )
        single_values = [value for value in (anchor_event_id, anchor_message_ref) if value]
        range_values = [value for value in (start_anchor, end_anchor) if value]
        if range_values:
            if len(range_values) != 2 or single_values:
                raise LedgerError(
                    "CONTEXT_ANCHOR_MODE_INVALID",
                    "范围模式必须同时提供 start_anchor/end_anchor，且不能再提供单锚点",
                )
            mode = "range"
        else:
            if len(single_values) != 1:
                raise LedgerError(
                    "CONTEXT_ANCHOR_MODE_INVALID",
                    "单锚点模式必须且只能提供 anchor_event_id 或 anchor_message_ref",
                )
            mode = "single"

        scope = self.authorizer.resolve(subscription_id)
        current_max_local_id = scope.observer.max_local_id(scope.binding)
        cursor_payload: dict[str, Any] | None = None
        if continuation_cursor:
            cursor_payload = self.token_codec.decode_cursor(continuation_cursor)
            self._validate_token_scope(scope, cursor_payload)
            try:
                cutoff_local_id = int(cursor_payload["source_cutoff_local_id"])
            except (KeyError, TypeError, ValueError) as error:
                raise LedgerError("CONTEXT_CURSOR_INVALID", "cursor 缺少 source cutoff") from error
            if current_max_local_id < cutoff_local_id:
                raise LedgerError(
                    "CONTEXT_SOURCE_DRIFT",
                    "当前 route 源快照早于 continuation 的 source cutoff",
                )
        else:
            cutoff_local_id = current_max_local_id

        if mode == "single":
            anchor_value = anchor_event_id or anchor_message_ref
            anchor, anchor_cutoff = self._resolve_anchor(scope, anchor_value)
            start_identity = end_identity = anchor
            anchor_cutoffs = [anchor_cutoff] if anchor_cutoff is not None else []
        else:
            start_identity, start_cutoff = self._resolve_anchor(scope, start_anchor)
            end_identity, end_cutoff = self._resolve_anchor(scope, end_anchor)
            anchor_cutoffs = [
                value for value in (start_cutoff, end_cutoff) if value is not None
            ]
            if start_identity.local_id > end_identity.local_id:
                raise LedgerError(
                    "CONTEXT_ANCHOR_ORDER_INVALID",
                    "start_anchor 必须早于或等于 end_anchor",
                )
        if anchor_cutoffs:
            anchor_cutoff = min(anchor_cutoffs)
            if cursor_payload is not None and cutoff_local_id > anchor_cutoff:
                raise LedgerError(
                    "CONTEXT_CURSOR_MISMATCH",
                    "continuation 超出 message_ref 签发时的 source cutoff",
                )
            cutoff_local_id = min(cutoff_local_id, anchor_cutoff)
        if max(start_identity.local_id, end_identity.local_id) > cutoff_local_id:
            raise LedgerError(
                "CONTEXT_ANCHOR_AFTER_CUTOFF",
                "anchor 晚于 continuation 的 source cutoff",
            )

        if mode == "range":
            source_window_limit_reached_before = False
            source_window_limit_reached_after = False
            source_rows = scope.observer.read_route_messages(
                scope.binding,
                minimum_local_id=start_identity.local_id,
                maximum_local_id=end_identity.local_id,
                limit=MAX_CONTEXT_SOURCE_ROWS + 1,
            )
            if len(source_rows) > MAX_CONTEXT_SOURCE_ROWS:
                raise LedgerError(
                    "CONTEXT_RANGE_TOO_WIDE",
                    f"范围超过 {MAX_CONTEXT_SOURCE_ROWS} 条源消息，请缩小锚点",
                )
            selected = [row for row in source_rows if self._eligible(row, directions, kinds)]
        else:
            (
                selected,
                source_window_limit_reached_before,
                source_window_limit_reached_after,
            ) = self._single_anchor_slice(
                scope,
                start_identity,
                cutoff_local_id,
                before,
                after,
                directions,
                kinds,
            )

        selected_source_snapshot = [
            {
                "local_id": self._observation_identity(row).local_id,
                "server_id": self._observation_identity(row).server_id,
                "source_fingerprint": row.source_fingerprint,
                "payload_sha256": _canonical_sha256(row.payload),
            }
            for row in selected
        ]
        source_snapshot_sha256 = _canonical_sha256(
            {"selected": selected_source_snapshot}
        )
        query_identity = {
            "subscription_id": subscription_id,
            "route_id": scope.subscription["route_id"],
            "mode": mode,
            "start": {
                "local_id": start_identity.local_id,
                "server_id": start_identity.server_id,
            },
            "end": {
                "local_id": end_identity.local_id,
                "server_id": end_identity.server_id,
            },
            "before": before,
            "after": after,
            "directions": directions,
            "kinds": kinds,
            "text_only": text_only,
            "source_cutoff_local_id": cutoff_local_id,
            "selected": selected_source_snapshot,
        }
        query_fingerprint = _canonical_sha256(query_identity)
        offset = 0
        text_offset = 0
        if cursor_payload is not None:
            if not hmac.compare_digest(
                str(cursor_payload.get("source_snapshot_sha256") or ""),
                source_snapshot_sha256,
            ):
                raise LedgerError(
                    "CONTEXT_SOURCE_DRIFT",
                    "continuation 对应的源消息内容已变化",
                )
            if not hmac.compare_digest(
                str(cursor_payload.get("query_fingerprint") or ""),
                query_fingerprint,
            ):
                raise LedgerError(
                    "CONTEXT_CURSOR_MISMATCH",
                    "continuation cursor 与当前锚点、过滤条件或源快照不一致",
                )
            try:
                offset = int(cursor_payload["offset"])
            except (KeyError, TypeError, ValueError) as error:
                raise LedgerError("CONTEXT_CURSOR_INVALID", "cursor offset 无效") from error
            if not 0 <= offset <= len(selected):
                raise LedgerError("CONTEXT_CURSOR_INVALID", "cursor offset 越界")
            try:
                text_offset = int(cursor_payload.get("text_offset", 0))
            except (TypeError, ValueError) as error:
                raise LedgerError("CONTEXT_CURSOR_INVALID", "cursor text_offset 无效") from error
            if text_offset < 0 or (offset == len(selected) and text_offset):
                raise LedgerError("CONTEXT_CURSOR_INVALID", "cursor text_offset 越界")

        returned: list[dict[str, Any]] = []
        used_chars = 0
        next_offset = offset
        next_text_offset = text_offset
        for selected_index, observation in enumerate(selected[offset:], start=offset):
            if len(returned) >= max_messages:
                break
            item = self._message_item(scope, observation, cutoff_local_id)
            text = str(item["visible_text"])
            fragment_start = text_offset if selected_index == offset else 0
            if fragment_start > len(text):
                raise LedgerError(
                    "CONTEXT_SOURCE_DRIFT",
                    "continuation 指向的消息文本长度已变化",
                )
            remaining_chars = max_chars - used_chars
            if remaining_chars < 1 and returned:
                break
            fragment = text[fragment_start : fragment_start + remaining_chars]
            fragment_end = fragment_start + len(fragment)
            item["visible_text"] = fragment
            item["text_fragment_start"] = fragment_start
            item["text_fragment_end"] = fragment_end
            item["text_total_characters"] = len(text)
            item["text_truncated"] = fragment_start > 0 or fragment_end < len(text)
            used_chars += len(fragment)
            returned.append(item)
            if fragment_end < len(text):
                next_offset = selected_index
                next_text_offset = fragment_end
                break
            next_offset = selected_index + 1
            next_text_offset = 0
            if used_chars >= max_chars:
                break

        remaining_count = len(selected) - next_offset
        next_cursor = None
        if remaining_count:
            next_cursor = self.token_codec.encode_cursor(
                {
                    **self._token_scope(scope),
                    "query_fingerprint": query_fingerprint,
                    "source_snapshot_sha256": source_snapshot_sha256,
                    "source_cutoff_local_id": cutoff_local_id,
                    "offset": next_offset,
                    "text_offset": next_text_offset,
                }
            )
        local_ids = [self._observation_identity(row).local_id for row in selected]
        source_gap_count = sum(
            1 for previous, current in zip(local_ids, local_ids[1:]) if current > previous + 1
        )
        return {
            "subscription_id": subscription_id,
            "route_id": scope.subscription["route_id"],
            "mode": mode,
            "source_cutoff_local_id": cutoff_local_id,
            "source_order": "route_local_id_ascending",
            "messages": returned,
            "returned_count": len(returned),
            "selected_count": len(selected),
            "remaining_count": remaining_count,
            "continuation_cursor": next_cursor,
            "used_characters": used_chars,
            "unknown_direction_count": sum(
                1 for row in selected if row.payload.get("direction") == "unknown"
            ),
            "source_gap_count": source_gap_count,
            "source_window_limit_reached_before": source_window_limit_reached_before,
            "source_window_limit_reached_after": source_window_limit_reached_after,
            "read_only": True,
            "ledger_state_changed": False,
        }
