from __future__ import annotations

import hashlib
import hmac
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

from .ledger import normalize_route_identity, route_identity_sha256


class RouteVerificationStatus(StrEnum):
    VERIFIED = "VERIFIED"
    NOT_FOUND = "NOT_FOUND"
    AMBIGUOUS = "AMBIGUOUS"
    UNVERIFIED = "UNVERIFIED"


class RouteVerificationError(RuntimeError):
    def __init__(self, status: RouteVerificationStatus, reason: str) -> None:
        super().__init__(reason)
        self.code = status.value
        self.status = status


@dataclass(frozen=True)
class VerifiedRoute:
    route_id: str
    username: str
    chat_type: str
    display_title: str
    identity_sha256: str
    owner_account_key_sha256: str
    username_sha256: str


@dataclass(frozen=True)
class RouteVerification:
    status: RouteVerificationStatus
    route: VerifiedRoute | None = None
    reason: str | None = None


class RouteVerifier(Protocol):
    def verify(
        self,
        route_id: str,
        ledger_route: Mapping[str, Any],
        capability: str = "text",
    ) -> VerifiedRoute: ...


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def precise_route_identity_sha256(owner_account_key: str, username: str, chat_type: str) -> str:
    return route_identity_sha256(owner_account_key, username, chat_type)


def _constant_equal(left: Any, right: str) -> bool:
    return isinstance(left, str) and hmac.compare_digest(left, right)


class PrivateBindingRouteVerifier:
    def __init__(self, binding_v2: Mapping[str, Any]) -> None:
        self._binding = binding_v2

    def inspect(
        self,
        route_id: str,
        ledger_route: Mapping[str, Any],
        capability: str = "text",
    ) -> RouteVerification:
        schema_version = self._binding.get("schemaVersion")
        if schema_version not in {1, 2}:
            return RouteVerification(
                RouteVerificationStatus.UNVERIFIED,
                reason="private binding schemaVersion 不受支持",
            )

        routes = self._binding.get("routes")
        if not isinstance(routes, Sequence) or isinstance(routes, (str, bytes, bytearray)):
            return RouteVerification(
                RouteVerificationStatus.UNVERIFIED,
                reason="private binding 缺少 routes 数组",
            )

        candidates = [
            candidate
            for candidate in routes
            if isinstance(candidate, Mapping) and candidate.get("route_id") == route_id
        ]
        if not candidates:
            return RouteVerification(RouteVerificationStatus.NOT_FOUND, reason="route 不在 private binding 中")
        if len(candidates) != 1:
            return RouteVerification(
                RouteVerificationStatus.AMBIGUOUS,
                reason="private binding 中存在重复 route_id",
            )

        candidate = candidates[0]
        if candidate.get("state") != "active" and not (
            schema_version == 1 and not str(candidate.get("state") or "").strip()
        ):
            return RouteVerification(
                RouteVerificationStatus.UNVERIFIED,
                reason="private binding route 未处于 active",
            )

        root_owner_account_key = self._binding.get("ownerAccountKey")
        route_owner_account_key = candidate.get("ownerAccountKey")
        if route_owner_account_key is not None and root_owner_account_key is not None:
            if not all(isinstance(value, str) for value in (route_owner_account_key, root_owner_account_key)):
                return RouteVerification(
                    RouteVerificationStatus.UNVERIFIED,
                    reason="ownerAccountKey 类型无效",
                )
            normalized_route_owner = normalize_route_identity(route_owner_account_key, "", "")[0]
            normalized_root_owner = normalize_route_identity(root_owner_account_key, "", "")[0]
            if normalized_route_owner != normalized_root_owner:
                return RouteVerification(
                    RouteVerificationStatus.UNVERIFIED,
                    reason="ownerAccountKey 作用域冲突",
                )
        owner_account_key = route_owner_account_key or root_owner_account_key
        username = candidate.get("username")
        chat_type = candidate.get("chat_type")
        display_title = candidate.get("display_title", candidate.get("exact_title", ""))

        if not all(isinstance(value, str) and value for value in (owner_account_key, username, chat_type)):
            return RouteVerification(
                RouteVerificationStatus.UNVERIFIED,
                reason="精确 route 身份字段不完整",
            )
        owner_account_key, username, chat_type = normalize_route_identity(
            owner_account_key, username, chat_type
        )
        if not owner_account_key or not username:
            return RouteVerification(
                RouteVerificationStatus.UNVERIFIED,
                reason="规范化后的精确 route 身份字段为空",
            )
        if chat_type not in {"friend", "group"}:
            return RouteVerification(
                RouteVerificationStatus.UNVERIFIED,
                reason="chat_type 不受支持",
            )
        if (chat_type == "group") != username.endswith("@chatroom"):
            return RouteVerification(
                RouteVerificationStatus.UNVERIFIED,
                reason="username 与 chat_type 不一致",
            )
        if not isinstance(display_title, str):
            return RouteVerification(
                RouteVerificationStatus.UNVERIFIED,
                reason="display_title 类型无效",
            )

        identity_sha256 = precise_route_identity_sha256(owner_account_key, username, chat_type)
        owner_account_key_sha256 = _sha256_text(owner_account_key)
        username_sha256 = _sha256_text(username)

        if candidate.get("identity_sha256") is not None and not _constant_equal(
            candidate.get("identity_sha256"), identity_sha256
        ):
            return RouteVerification(
                RouteVerificationStatus.UNVERIFIED,
                reason="private binding identity_sha256 不一致",
            )

        checks = (
            ledger_route.get("route_id") == route_id,
            ledger_route.get("state") == "active",
            ledger_route.get("identity_version") == 2,
            _constant_equal(ledger_route.get("identity_sha256"), identity_sha256),
            _constant_equal(ledger_route.get("owner_account_key_sha256"), owner_account_key_sha256),
            _constant_equal(ledger_route.get("username_sha256"), username_sha256),
            ledger_route.get("chat_type") == chat_type,
        )
        if not all(checks):
            return RouteVerification(
                RouteVerificationStatus.UNVERIFIED,
                reason="账本 route 与 private binding 的精确身份不一致",
            )

        outbound = candidate.get("outbound")
        if not isinstance(outbound, Mapping) or outbound.get("enabled") is not True:
            return RouteVerification(
                RouteVerificationStatus.UNVERIFIED,
                reason="private binding 未启用该 route 的 outbound",
            )
        if outbound.get(capability) is not True:
            return RouteVerification(
                RouteVerificationStatus.UNVERIFIED,
                reason=f"private binding 未启用 outbound capability: {capability}",
            )

        route = VerifiedRoute(
            route_id=route_id,
            username=username,
            chat_type=chat_type,
            display_title=display_title,
            identity_sha256=identity_sha256,
            owner_account_key_sha256=owner_account_key_sha256,
            username_sha256=username_sha256,
        )
        return RouteVerification(RouteVerificationStatus.VERIFIED, route=route)

    def verify(
        self,
        route_id: str,
        ledger_route: Mapping[str, Any],
        capability: str = "text",
    ) -> VerifiedRoute:
        verification = self.inspect(route_id, ledger_route, capability)
        if verification.status is not RouteVerificationStatus.VERIFIED or verification.route is None:
            raise RouteVerificationError(
                verification.status,
                verification.reason or "route 未通过精确身份验证",
            )
        return verification.route

    def verify_identity(
        self,
        route_id: str,
        ledger_route: Mapping[str, Any],
    ) -> VerifiedRoute:
        routes = self._binding.get("routes")
        if not isinstance(routes, Sequence) or isinstance(routes, (str, bytes, bytearray)):
            raise RouteVerificationError(
                RouteVerificationStatus.UNVERIFIED,
                "private binding 缺少 routes 数组",
            )
        identity_capability = "__identity_only__"
        binding = dict(self._binding)
        binding["routes"] = [
            {
                **dict(candidate),
                "outbound": {"enabled": True, identity_capability: True},
            }
            if isinstance(candidate, Mapping) and candidate.get("route_id") == route_id
            else candidate
            for candidate in routes
        ]
        return PrivateBindingRouteVerifier(binding).verify(
            route_id,
            ledger_route,
            identity_capability,
        )
