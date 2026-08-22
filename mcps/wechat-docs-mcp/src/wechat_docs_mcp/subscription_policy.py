from __future__ import annotations

import hmac
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class SubscriptionPolicyStatus(StrEnum):
    VERIFIED = "VERIFIED"
    NOT_FOUND = "NOT_FOUND"
    AMBIGUOUS = "AMBIGUOUS"
    UNVERIFIED = "UNVERIFIED"


class SubscriptionPolicyError(RuntimeError):
    def __init__(self, status: SubscriptionPolicyStatus, reason: str) -> None:
        super().__init__(reason)
        self.code = status.value
        self.status = status


@dataclass(frozen=True)
class VerifiedSubscriptionPolicy:
    subscription_id: str
    route_id: str
    conversation_id: str
    generation: int
    policy_ref: str


class PrivateBindingSubscriptionPolicyVerifier:
    def __init__(self, binding: Mapping[str, Any]) -> None:
        self._binding = binding

    def verify_context(self, subscription: Mapping[str, Any]) -> VerifiedSubscriptionPolicy:
        if self._binding.get("schemaVersion") not in {1, 2}:
            raise SubscriptionPolicyError(
                SubscriptionPolicyStatus.UNVERIFIED,
                "private binding schemaVersion 不受支持",
            )
        subscription_id = self._required_exact_string(subscription, "subscription_id")
        route_id = self._required_exact_string(subscription, "route_id")
        conversation_id = self._required_exact_string(subscription, "conversation_id")
        policy_ref = self._required_exact_string(subscription, "policy_ref")
        try:
            generation = int(subscription.get("generation"))
        except (TypeError, ValueError) as error:
            raise SubscriptionPolicyError(
                SubscriptionPolicyStatus.UNVERIFIED,
                "subscription generation 无效",
            ) from error
        if generation < 1:
            raise SubscriptionPolicyError(
                SubscriptionPolicyStatus.UNVERIFIED,
                "subscription 私有策略身份或 policy_ref 不完整",
            )

        candidates = [
            candidate
            for candidate in self._subscriptions()
            if self._candidate_subscription_id_matches(candidate, subscription_id)
        ]
        if not candidates:
            raise SubscriptionPolicyError(
                SubscriptionPolicyStatus.NOT_FOUND,
                "subscription 不在 private binding allowlist 中",
            )
        if len(candidates) != 1:
            raise SubscriptionPolicyError(
                SubscriptionPolicyStatus.AMBIGUOUS,
                "private binding 中存在重复的 subscription_id",
            )

        candidate = candidates[0]
        if candidate.get("state") != "active" or candidate.get("context_read_capability") is not True:
            raise SubscriptionPolicyError(
                SubscriptionPolicyStatus.UNVERIFIED,
                "private subscription 未同时启用 active 和 context_read_capability",
            )
        try:
            configured_generation = int(candidate.get("generation"))
        except (TypeError, ValueError) as error:
            raise SubscriptionPolicyError(
                SubscriptionPolicyStatus.UNVERIFIED,
                "private subscription generation 无效",
            ) from error
        try:
            configured_route_id = self._required_exact_string(candidate, "route_id")
            configured_conversation_id = self._required_exact_string(
                candidate,
                "conversation_id",
            )
            configured_policy_ref = self._required_exact_string(candidate, "policy_ref")
        except SubscriptionPolicyError as error:
            raise SubscriptionPolicyError(
                SubscriptionPolicyStatus.UNVERIFIED,
                f"private subscription 字段无效：{error}",
            ) from error
        checks = (
            hmac.compare_digest(configured_route_id, route_id),
            hmac.compare_digest(configured_conversation_id, conversation_id),
            configured_generation == generation,
            hmac.compare_digest(configured_policy_ref, policy_ref),
        )
        if not all(checks):
            raise SubscriptionPolicyError(
                SubscriptionPolicyStatus.UNVERIFIED,
                "private subscription 的 route/conversation/generation/policy_ref 与账本不一致",
            )
        return VerifiedSubscriptionPolicy(
            subscription_id=subscription_id,
            route_id=route_id,
            conversation_id=conversation_id,
            generation=generation,
            policy_ref=policy_ref,
        )

    def _subscriptions(self) -> list[Mapping[str, Any]]:
        subscriptions = self._binding.get("subscriptions")
        if not isinstance(subscriptions, Sequence) or isinstance(
            subscriptions,
            (str, bytes, bytearray),
        ):
            return []
        return [item for item in subscriptions if isinstance(item, Mapping)]

    @staticmethod
    def _candidate_subscription_id_matches(
        candidate: Mapping[str, Any],
        subscription_id: str,
    ) -> bool:
        configured = candidate.get("subscription_id")
        return (
            isinstance(configured, str)
            and bool(configured)
            and configured == configured.strip()
            and hmac.compare_digest(configured, subscription_id)
        )

    @staticmethod
    def _required_exact_string(value: Mapping[str, Any], field: str) -> str:
        raw = value.get(field)
        if not isinstance(raw, str) or not raw or raw != raw.strip():
            raise SubscriptionPolicyError(
                SubscriptionPolicyStatus.UNVERIFIED,
                f"{field} 必须是无首尾空白的非空字符串",
            )
        return raw
