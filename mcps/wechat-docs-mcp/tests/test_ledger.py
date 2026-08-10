from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from wechat_docs_mcp.ledger import EventLedger, LedgerError
from wechat_docs_mcp.routes import evaluate_route_enrollment
from wechat_docs_mcp.tencent_docs import TencentDocsMcpClient, classify_tool


class LedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.ledger = EventLedger(Path(self.temp_dir.name) / "events.sqlite3")
        self.ledger.register_route(
            "route-test",
            profile="human_self_test",
            identity={"chat_name": "sanitized-self", "chat_type": "self"},
            state="active",
        )
        self.ledger.register_subscription(
            "route-test",
            "conversation-test",
            1,
            subscription_id="subscription-test",
            send_capability=True,
            policy_ref="test-policy",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def approved_wechat_draft(self, text: str, dedupe_key: str) -> tuple[dict, dict]:
        payload = {"text": text}
        expires = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
        draft = self.ledger.prepare_draft(
            "route-test",
            "wechat_text",
            payload,
            expires,
            subscription_id="subscription-test",
        )
        reference = {
            "conversation_id": "conversation-owner",
            "turn_id": "turn-owner",
            "message_item_id": "item-owner",
            "role": "user",
            "authorized_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
        }
        self.ledger.approve_draft(draft["draft_id"], payload, [reference], dedupe_key)
        return draft, payload

    def test_ingest_merges_wake_and_deduplicates(self) -> None:
        first = self.ledger.ingest_event("route-test", "fp-1", "text", {"text": "one"})
        second = self.ledger.ingest_event("route-test", "fp-2", "text", {"text": "two"})
        duplicate = self.ledger.ingest_event("route-test", "fp-2", "text", {"text": "two"})
        self.assertEqual(first["wake"]["wake_id"], second["wake"]["wake_id"])
        self.assertFalse(duplicate["inserted"])

    def test_wake_notification_state_is_compare_and_swap(self) -> None:
        event = self.ledger.ingest_event("route-test", "fp-wake", "text", {"text": "private"})
        pending = self.ledger.list_wakes_for_notification()
        self.assertEqual([event["wake"]["wake_id"]], [wake["wake_id"] for wake in pending])
        self.assertEqual("conversation-test", pending[0]["conversation_id"])
        submitted = self.ledger.mark_wake_state(event["wake"]["wake_id"], ["prepared"], "submitted")
        self.assertEqual("submitted", submitted["state"])
        with self.assertRaises(LedgerError) as raised:
            self.ledger.mark_wake_state(event["wake"]["wake_id"], ["prepared"], "unknown")
        self.assertEqual("WAKE_STATE_CONFLICT", raised.exception.code)

    def test_partial_ack_keeps_later_event_pending(self) -> None:
        first = self.ledger.ingest_event("route-test", "fp-1", "text", {"text": "one"})
        second = self.ledger.ingest_event("route-test", "fp-2", "text", {"text": "two"})
        result = self.ledger.ack("route-test", 1, first["wake"]["wake_id"], [first["event_id"]])
        self.assertEqual(1, result["pending_count"])
        self.assertEqual([second["event_id"]], [item["event_id"] for item in self.ledger.list_pending("route-test")])

    def test_changed_draft_invalidates_approval(self) -> None:
        expires = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        draft = self.ledger.prepare_draft(
            "route-test",
            "wechat_text",
            {"text": "WX_MCP_TEST"},
            expires,
            subscription_id="subscription-test",
        )
        reference = {
            "conversation_id": "conversation-owner",
            "turn_id": "turn-owner",
            "message_item_id": "item-owner",
            "role": "user",
            "authorized_at": "2026-08-09T16:41:00+08:00",
        }
        with self.assertRaises(LedgerError) as raised:
            self.ledger.approve_draft(
                draft["draft_id"],
                {"text": "changed"},
                [reference],
                "dedupe-1",
                "2026-08-09T16:50:00+08:00",
            )
        self.assertEqual("DRAFT_CHANGED", raised.exception.code)

    def test_owner_reference_is_required(self) -> None:
        expires = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        draft = self.ledger.prepare_draft(
            "route-test",
            "wechat_text",
            {"text": "WX_MCP_TEST"},
            expires,
            subscription_id="subscription-test",
        )
        with self.assertRaises(LedgerError) as raised:
            self.ledger.approve_draft(draft["draft_id"], {"text": "WX_MCP_TEST"}, [], "dedupe-2")
        self.assertEqual("OWNER_AUTH_REQUIRED", raised.exception.code)

    def test_approved_draft_survives_ledger_restart(self) -> None:
        expires = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        payload = {
            "provider": "tencent_docs_official_mcp",
            "tool": "create_word_by_markdown",
            "arguments": {"title": "sanitized", "markdown": "test"},
        }
        draft = self.ledger.prepare_draft("route-test", "tdocs_official_call", payload, expires)
        reference = {
            "conversation_id": "conversation-owner",
            "turn_id": "turn-owner",
            "message_item_id": "item-owner",
            "role": "user",
            "authorized_at": "2026-08-09T16:41:00+08:00",
        }
        self.ledger.approve_draft(
            draft["draft_id"], payload, [reference], "tdocs-write-1", "2026-08-09T16:50:00+08:00"
        )
        restarted = EventLedger(Path(self.temp_dir.name) / "events.sqlite3")
        restored = restarted.require_approved_draft(draft["draft_id"], payload, "tdocs-write-1")
        self.assertEqual("APPROVED", restored["state"])

    def test_pending_events_survive_ledger_restart(self) -> None:
        event = self.ledger.ingest_event("route-test", "fp-restart", "text", {"text": "persist"})
        restarted = EventLedger(Path(self.temp_dir.name) / "events.sqlite3")
        self.assertEqual(event["event_id"], restarted.list_pending("route-test")[0]["event_id"])

    def test_draft_state_transition_is_compare_and_swap(self) -> None:
        expires = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        draft = self.ledger.prepare_draft(
            "route-test",
            "wechat_text",
            {"text": "test"},
            expires,
            subscription_id="subscription-test",
        )
        updated = self.ledger.mark_draft_state(draft["draft_id"], "PREPARED", "FAILED")
        self.assertEqual("FAILED", updated["state"])
        with self.assertRaises(LedgerError) as raised:
            self.ledger.mark_draft_state(draft["draft_id"], "PREPARED", "APPROVED")
        self.assertEqual("DRAFT_STATE_CONFLICT", raised.exception.code)

    def test_wechat_draft_requires_send_capable_subscription(self) -> None:
        expires = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        with self.assertRaises(LedgerError) as raised:
            self.ledger.prepare_draft("route-test", "wechat_text", {"text": "test"}, expires)
        self.assertEqual("SUBSCRIPTION_REQUIRED", raised.exception.code)

        self.ledger.set_subscription_capabilities(
            "subscription-test",
            1,
            listen_capability=True,
            send_capability=False,
        )
        with self.assertRaises(LedgerError) as raised:
            self.ledger.prepare_draft(
                "route-test",
                "wechat_text",
                {"text": "test"},
                expires,
                subscription_id="subscription-test",
            )
        self.assertEqual("SUBSCRIPTION_SEND_DISABLED", raised.exception.code)

    def test_expired_execution_becomes_unknown_and_cannot_retry(self) -> None:
        draft, payload = self.approved_wechat_draft("unique", "dedupe-expired")
        lease_expires = datetime.now(timezone.utc) + timedelta(minutes=5)
        self.ledger.acquire_draft_execution(
            draft["draft_id"],
            payload,
            "dedupe-expired",
            "execution-expired",
            lease_expires.isoformat(),
        )
        called_at = (lease_expires + timedelta(seconds=1)).astimezone(
            timezone(timedelta(hours=8))
        )
        self.assertEqual(
            [draft["draft_id"]],
            self.ledger.recover_expired_executions(called_at.isoformat()),
        )
        self.assertEqual("UNKNOWN", self.ledger.get_draft(draft["draft_id"])["state"])
        with self.assertRaises(LedgerError) as raised:
            self.ledger.acquire_draft_execution(
                draft["draft_id"],
                payload,
                "dedupe-expired",
                "execution-retry",
                (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
            )
        self.assertEqual("DRAFT_NOT_EXECUTABLE", raised.exception.code)

    def test_wechat_execution_lease_is_global(self) -> None:
        first, first_payload = self.approved_wechat_draft("first", "dedupe-first")
        second, second_payload = self.approved_wechat_draft("second", "dedupe-second")
        lease_expires = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        self.ledger.acquire_draft_execution(
            first["draft_id"], first_payload, "dedupe-first", "execution-first", lease_expires
        )
        with self.assertRaises(LedgerError) as raised:
            self.ledger.acquire_draft_execution(
                second["draft_id"],
                second_payload,
                "dedupe-second",
                "execution-second",
                lease_expires,
            )
        self.assertEqual("SEND_LEASE_BUSY", raised.exception.code)

    def test_wechat_execution_rechecks_subscription_capability(self) -> None:
        draft, payload = self.approved_wechat_draft("revoked", "dedupe-revoked")
        self.ledger.set_subscription_capabilities(
            "subscription-test",
            1,
            listen_capability=True,
            send_capability=False,
        )
        with self.assertRaises(LedgerError) as raised:
            self.ledger.acquire_draft_execution(
                draft["draft_id"],
                payload,
                "dedupe-revoked",
                "execution-revoked",
                (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
            )
        self.assertEqual("SUBSCRIPTION_SEND_DISABLED", raised.exception.code)
        self.assertEqual("APPROVED", self.ledger.get_draft(draft["draft_id"])["state"])

    def test_database_verification_requires_outbound_exact_match(self) -> None:
        draft, payload = self.approved_wechat_draft("unique-marker", "dedupe-verify")
        execution_id = "execution-verify"
        self.ledger.acquire_draft_execution(
            draft["draft_id"],
            payload,
            "dedupe-verify",
            execution_id,
            (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
        )
        self.ledger.finish_draft_execution(
            draft["draft_id"], execution_id, "SEND_ATTEMPTED", {"ui_attempted": True}
        )
        inbound = self.ledger.ingest_event(
            "route-test",
            "fp-inbound-confirmation",
            "text",
            {"visible_text": "unique-marker", "direction": "inbound"},
        )
        with self.assertRaises(LedgerError) as raised:
            self.ledger.verify_draft(draft["draft_id"], inbound["event_id"])
        self.assertEqual("OUTBOUND_DIRECTION_UNVERIFIED", raised.exception.code)

        outbound = self.ledger.ingest_event(
            "route-test",
            "fp-outbound-confirmation",
            "text",
            {"visible_text": "unique-marker", "direction": "outbound"},
        )
        verified = self.ledger.verify_draft(draft["draft_id"], outbound["event_id"])
        self.assertEqual("VERIFIED", verified["state"])
        self.assertTrue(verified["result"]["ui_attempted"])
        self.assertEqual(outbound["event_id"], verified["result"]["observed_event_id"])

    def test_database_verification_consumes_observation_once(self) -> None:
        first, first_payload = self.approved_wechat_draft("same-marker", "dedupe-verify-first")
        second, second_payload = self.approved_wechat_draft("same-marker", "dedupe-verify-second")
        for draft, payload, execution_id, dedupe_key in (
            (first, first_payload, "execution-first-observation", "dedupe-verify-first"),
            (second, second_payload, "execution-second-observation", "dedupe-verify-second"),
        ):
            self.ledger.acquire_draft_execution(
                draft["draft_id"],
                payload,
                dedupe_key,
                execution_id,
                (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
            )
            self.ledger.finish_draft_execution(draft["draft_id"], execution_id, "SEND_ATTEMPTED")
        outbound = self.ledger.ingest_event(
            "route-test",
            "fp-single-use-confirmation",
            "text",
            {"visible_text": "same-marker", "direction": "outbound"},
        )
        self.ledger.verify_draft(first["draft_id"], outbound["event_id"])
        with self.assertRaises(LedgerError) as raised:
            self.ledger.verify_draft(second["draft_id"], outbound["event_id"])
        self.assertEqual("OUTBOUND_OBSERVATION_ALREADY_USED", raised.exception.code)
        self.assertEqual("SEND_ATTEMPTED", self.ledger.get_draft(second["draft_id"])["state"])

    def test_register_route_stores_baseline(self) -> None:
        self.temp_dir2 = tempfile.TemporaryDirectory()
        ledger2 = EventLedger(Path(self.temp_dir2.name) / "ev.sqlite3")
        ledger2.register_route(
            "route-bl",
            "conv-bl",
            1,
            "test",
            {"chat_name": "x"},
            "active",
            baseline_local_id=42,
        )
        self.assertEqual(42, ledger2.get_baseline("route-bl"))
        self.temp_dir2.cleanup()

    def test_update_baseline_advances_and_prevents_regression(self) -> None:
        self.temp_dir3 = tempfile.TemporaryDirectory()
        ledger3 = EventLedger(Path(self.temp_dir3.name) / "ev.sqlite3")
        ledger3.register_route(
            "route-bl2",
            "conv-bl2",
            1,
            "test",
            {"chat_name": "y"},
            "active",
            baseline_local_id=10,
        )
        ledger3.update_baseline("route-bl2", 15)
        self.assertEqual(15, ledger3.get_baseline("route-bl2"))
        with self.assertRaises(LedgerError) as raised:
            ledger3.update_baseline("route-bl2", 12)
        self.assertEqual("BASELINE_REGRESSION", raised.exception.code)
        self.temp_dir3.cleanup()


class RouteTests(unittest.TestCase):
    def test_duplicate_exact_title_is_quarantined(self) -> None:
        binding = {"exact_title": "same", "expected_chat_type": "group"}
        observations = [
            {"chat_name": "same", "chat_type": "group"},
            {"chat_name": "same", "chat_type": "group"},
        ]
        result = evaluate_route_enrollment(binding, observations)
        self.assertEqual("quarantine", result["state"])


class TencentDocsPolicyTests(unittest.TestCase):
    def test_dynamic_tool_classification_defaults_to_approval(self) -> None:
        self.assertEqual("read_only", classify_tool({"name": "get_content"}))
        self.assertEqual("approval_required", classify_tool({"name": "future_magic_operation"}))

    def test_audit_summary_never_contains_token(self) -> None:
        summary = TencentDocsMcpClient.audit_summary("tools/call", "get_content")
        self.assertEqual("[REDACTED]", summary["authorization"])


if __name__ == "__main__":
    unittest.main()
