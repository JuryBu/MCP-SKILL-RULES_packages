from __future__ import annotations

import hashlib
import json
import unittest

from wechat_docs_mcp.route_verifier import (
    PrivateBindingRouteVerifier,
    RouteVerificationError,
    RouteVerificationStatus,
    precise_route_identity_sha256,
)


OWNER_KEY = "synthetic-owner-key"
USERNAME = "synthetic-room@chatroom"


def text_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def binding(*, title: str = "Synthetic Room") -> dict:
    return {
        "schemaVersion": 2,
        "ownerAccountKey": OWNER_KEY,
        "routes": [
            {
                "route_id": "route-synthetic",
                "display_title": title,
                "chat_type": "group",
                "username": USERNAME,
                "state": "active",
                "outbound": {"enabled": True, "text": True},
            }
        ],
    }


def ledger_route() -> dict:
    return {
        "route_id": "route-synthetic",
        "state": "active",
        "identity_version": 2,
        "identity_sha256": precise_route_identity_sha256(OWNER_KEY, USERNAME, "group"),
        "owner_account_key_sha256": text_sha256(OWNER_KEY),
        "username_sha256": text_sha256(USERNAME),
        "chat_type": "group",
        "display_title": "Old Display Title",
    }


class PrivateBindingRouteVerifierTests(unittest.TestCase):
    def test_identity_hash_matches_ledger_canonical_contract(self) -> None:
        canonical = json.dumps(
            {
                "owner_account_key": OWNER_KEY,
                "username": USERNAME,
                "chat_type": "group",
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        expected = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        self.assertEqual(expected, precise_route_identity_sha256(OWNER_KEY, USERNAME, "group"))

    def test_exact_identity_is_verified(self) -> None:
        route = PrivateBindingRouteVerifier(binding()).verify("route-synthetic", ledger_route())
        self.assertEqual(USERNAME, route.username)
        self.assertEqual("group", route.chat_type)

    def test_display_title_does_not_participate_in_identity(self) -> None:
        route = PrivateBindingRouteVerifier(binding(title="Renamed Display")).verify(
            "route-synthetic", ledger_route()
        )
        self.assertEqual("Renamed Display", route.display_title)

    def test_missing_route_is_not_found(self) -> None:
        result = PrivateBindingRouteVerifier(binding()).inspect("route-other", ledger_route())
        self.assertEqual(RouteVerificationStatus.NOT_FOUND, result.status)

    def test_duplicate_route_is_ambiguous(self) -> None:
        duplicated = binding()
        duplicated["routes"].append(dict(duplicated["routes"][0]))
        result = PrivateBindingRouteVerifier(duplicated).inspect("route-synthetic", ledger_route())
        self.assertEqual(RouteVerificationStatus.AMBIGUOUS, result.status)

    def test_hash_mismatch_is_unverified(self) -> None:
        mismatched = ledger_route()
        mismatched["username_sha256"] = "0" * 64
        result = PrivateBindingRouteVerifier(binding()).inspect("route-synthetic", mismatched)
        self.assertEqual(RouteVerificationStatus.UNVERIFIED, result.status)

    def test_chat_type_username_mismatch_is_unverified(self) -> None:
        malformed = binding()
        malformed["routes"][0]["username"] = "synthetic-friend-id"
        result = PrivateBindingRouteVerifier(malformed).inspect("route-synthetic", ledger_route())
        self.assertEqual(RouteVerificationStatus.UNVERIFIED, result.status)

    def test_non_v2_binding_is_rejected(self) -> None:
        old_binding = binding()
        old_binding["schemaVersion"] = 1
        with self.assertRaises(RouteVerificationError) as raised:
            PrivateBindingRouteVerifier(old_binding).verify("route-synthetic", ledger_route())
        self.assertEqual("UNVERIFIED", raised.exception.code)

    def test_outbound_policy_is_required_per_capability(self) -> None:
        disabled = binding()
        disabled["routes"][0]["outbound"] = {"enabled": False, "text": True}
        result = PrivateBindingRouteVerifier(disabled).inspect("route-synthetic", ledger_route())
        self.assertEqual(RouteVerificationStatus.UNVERIFIED, result.status)

        missing_file = binding()
        result = PrivateBindingRouteVerifier(missing_file).inspect(
            "route-synthetic", ledger_route(), capability="file"
        )
        self.assertEqual(RouteVerificationStatus.UNVERIFIED, result.status)

    def test_owner_account_key_is_normalized_before_scope_check(self) -> None:
        normalized_binding = binding()
        normalized_binding["ownerAccountKey"] = f"  {OWNER_KEY}  "
        normalized_binding["routes"][0]["ownerAccountKey"] = OWNER_KEY
        route = PrivateBindingRouteVerifier(normalized_binding).verify(
            "route-synthetic", ledger_route()
        )
        self.assertEqual(USERNAME, route.username)

    def test_whitespace_owner_account_key_is_unverified(self) -> None:
        whitespace_binding = binding()
        whitespace_binding["ownerAccountKey"] = "   "
        with self.assertRaises(RouteVerificationError) as raised:
            PrivateBindingRouteVerifier(whitespace_binding).verify(
                "route-synthetic", ledger_route()
            )
        self.assertEqual("UNVERIFIED", raised.exception.code)


if __name__ == "__main__":
    unittest.main()
