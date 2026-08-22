from __future__ import annotations

from copy import deepcopy

import pytest

from wechat_docs_mcp.subscription_policy import (
    PrivateBindingSubscriptionPolicyVerifier,
    SubscriptionPolicyError,
)


def _subscription() -> dict[str, object]:
    return {
        "subscription_id": "subscription-synthetic",
        "route_id": "route-synthetic",
        "conversation_id": "conversation-synthetic",
        "generation": 2,
        "state": "active",
        "context_read_capability": True,
        "policy_ref": "private-context-policy",
    }


def _binding() -> dict[str, object]:
    return {
        "schemaVersion": 2,
        "subscriptions": [_subscription()],
    }


def test_private_subscription_context_policy_exact_match() -> None:
    verified = PrivateBindingSubscriptionPolicyVerifier(_binding()).verify_context(
        _subscription()
    )

    assert verified.subscription_id == "subscription-synthetic"
    assert verified.generation == 2


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("context_read_capability", False),
        ("state", "paused"),
        ("policy_ref", "different-policy"),
        ("policy_ref", "private-context-policy "),
        ("route_id", "different-route"),
        ("conversation_id", "different-conversation"),
        ("generation", 3),
    ],
)
def test_private_subscription_context_policy_rejects_drift(
    field: str,
    value: object,
) -> None:
    binding = _binding()
    binding["subscriptions"][0][field] = value

    with pytest.raises(SubscriptionPolicyError) as raised:
        PrivateBindingSubscriptionPolicyVerifier(binding).verify_context(_subscription())

    assert raised.value.code == "UNVERIFIED"


def test_private_subscription_context_policy_rejects_missing_entry() -> None:
    binding = _binding()
    binding["subscriptions"] = []

    with pytest.raises(SubscriptionPolicyError) as raised:
        PrivateBindingSubscriptionPolicyVerifier(binding).verify_context(_subscription())

    assert raised.value.code == "NOT_FOUND"


def test_private_subscription_context_policy_rejects_duplicate_entry() -> None:
    binding = _binding()
    binding["subscriptions"].append(deepcopy(binding["subscriptions"][0]))

    with pytest.raises(SubscriptionPolicyError) as raised:
        PrivateBindingSubscriptionPolicyVerifier(binding).verify_context(_subscription())

    assert raised.value.code == "AMBIGUOUS"


@pytest.mark.parametrize(
    ("requested_id", "configured_id"),
    [
        ("123", 123),
        ("subscription-synthetic", "subscription-synthetic "),
    ],
)
def test_private_subscription_context_policy_rejects_non_exact_candidate_ids(
    requested_id: str,
    configured_id: object,
) -> None:
    subscription = _subscription()
    subscription["subscription_id"] = requested_id
    binding = _binding()
    binding["subscriptions"][0]["subscription_id"] = configured_id

    with pytest.raises(SubscriptionPolicyError) as raised:
        PrivateBindingSubscriptionPolicyVerifier(binding).verify_context(subscription)

    assert raised.value.code == "NOT_FOUND"
