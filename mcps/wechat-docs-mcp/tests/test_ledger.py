from __future__ import annotations

import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from wechat_docs_mcp.ledger import EventLedger, LedgerError, route_identity_sha256
from wechat_docs_mcp.routes import evaluate_route_enrollment
from wechat_docs_mcp.tencent_docs import TencentDocsMcpClient, classify_tool


class LedgerTests(unittest.TestCase):
    RECOVERY_EVIDENCE_REF = "private-test-evidence"
    RECOVERY_EVIDENCE_SHA256 = "1" * 64
    RECOVERY_BACKUP_SHA256 = "2" * 64

    @staticmethod
    def event_delivery_state(ledger: EventLedger) -> dict[str, int]:
        connection = ledger._connect()
        try:
            return {
                "events": int(connection.execute("SELECT COUNT(*) FROM events").fetchone()[0]),
                "events_acked": int(
                    connection.execute(
                        "SELECT COUNT(*) FROM events WHERE acked_at IS NOT NULL"
                    ).fetchone()[0]
                ),
                "deliveries": int(
                    connection.execute("SELECT COUNT(*) FROM event_deliveries").fetchone()[0]
                ),
                "deliveries_acked": int(
                    connection.execute(
                        "SELECT COUNT(*) FROM event_deliveries WHERE acked_at IS NOT NULL"
                    ).fetchone()[0]
                ),
                "legacy_wakes": int(connection.execute("SELECT COUNT(*) FROM wakes").fetchone()[0]),
                "subscription_wakes": int(
                    connection.execute("SELECT COUNT(*) FROM subscription_wakes").fetchone()[0]
                ),
            }
        finally:
            connection.close()

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

    @staticmethod
    def successful_text_audit(baseline_local_id: int = 41) -> dict:
        return {
            "send_action_invoked": True,
            "restore_succeeded": True,
            "baseline_local_id": baseline_local_id,
            "environment_observation": {
                "restore_skipped_user_interaction": False,
                "foreground_restored": True,
                "mouse_restored": True,
                "clipboard_semantics_restored": True,
            },
        }

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
        with self.assertRaises(LedgerError) as invalid_scope:
            self.ledger.acquire_draft_execution(
                second["draft_id"],
                second_payload,
                "dedupe-second",
                "execution-second-invalid-scope",
                lease_expires,
                lease_scope="wechat-visible-attachment-ui",
            )
        self.assertEqual("SEND_LEASE_SCOPE_INVALID", invalid_scope.exception.code)
        with self.assertRaises(LedgerError) as raised:
            self.ledger.acquire_draft_execution(
                second["draft_id"],
                second_payload,
                "dedupe-second",
                "execution-second",
                lease_expires,
            )
        self.assertEqual("SEND_LEASE_BUSY", raised.exception.code)

    def test_legacy_persisted_wechat_lease_scope_still_blocks_new_execution(self) -> None:
        first, first_payload = self.approved_wechat_draft("first", "dedupe-first")
        second, second_payload = self.approved_wechat_draft("second", "dedupe-second")
        lease_expires = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        self.ledger.acquire_draft_execution(
            first["draft_id"], first_payload, "dedupe-first", "execution-first", lease_expires
        )
        connection = sqlite3.connect(self.ledger.path)
        try:
            connection.execute(
                "UPDATE outbound_drafts SET lease_scope=? WHERE draft_id=?",
                ("wechat-visible-attachment-ui", first["draft_id"]),
            )
            connection.commit()
        finally:
            connection.close()

        with self.assertRaises(LedgerError) as raised:
            self.ledger.acquire_draft_execution(
                second["draft_id"],
                second_payload,
                "dedupe-second",
                "execution-second",
                lease_expires,
            )

        self.assertEqual("SEND_LEASE_BUSY", raised.exception.code)
        self.assertEqual("APPROVED", self.ledger.get_draft(second["draft_id"])["state"])

    def test_active_wechat_execution_count_tracks_drain(self) -> None:
        draft, payload = self.approved_wechat_draft("active", "dedupe-active")
        self.assertEqual(0, self.ledger.count_active_wechat_executions())

        self.ledger.acquire_draft_execution(
            draft["draft_id"],
            payload,
            "dedupe-active",
            "execution-active",
            (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
        )
        self.assertEqual(1, self.ledger.count_active_wechat_executions())

        self.ledger.finish_draft_execution(
            draft["draft_id"],
            "execution-active",
            "FAILED",
            error_code="SYNTHETIC_FAILURE",
        )
        self.assertEqual(0, self.ledger.count_active_wechat_executions())

    def test_expired_legacy_wechat_lease_is_recovered_atomically_before_acquire(self) -> None:
        first, first_payload = self.approved_wechat_draft("first", "dedupe-first")
        second, second_payload = self.approved_wechat_draft("second", "dedupe-second")
        future_lease = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        self.ledger.acquire_draft_execution(
            first["draft_id"], first_payload, "dedupe-first", "execution-first", future_lease
        )
        connection = sqlite3.connect(self.ledger.path)
        try:
            connection.execute(
                "UPDATE outbound_drafts SET lease_scope=?,lease_expires_at=? WHERE draft_id=?",
                (
                    "wechat-visible-attachment-ui",
                    (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
                    first["draft_id"],
                ),
            )
            connection.commit()
        finally:
            connection.close()

        acquired = self.ledger.acquire_draft_execution(
            second["draft_id"],
            second_payload,
            "dedupe-second",
            "execution-second",
            future_lease,
        )

        self.assertEqual("UNKNOWN", self.ledger.get_draft(first["draft_id"])["state"])
        self.assertEqual("EXECUTION_LEASE_EXPIRED", self.ledger.get_draft(first["draft_id"])["error_code"])
        self.assertEqual("EXECUTING", acquired["state"])

    def test_non_wechat_execution_requires_explicit_non_wechat_scope(self) -> None:
        payload = {
            "provider": "tencent_docs_official_mcp",
            "tool": "synthetic_mutation",
            "arguments": {"value": "safe"},
        }
        draft = self.ledger.prepare_draft(
            "route-test",
            "tdocs_official_call",
            payload,
            (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
        )
        self.ledger.approve_draft(
            draft["draft_id"],
            payload,
            [
                {
                    "conversation_id": "conversation-owner",
                    "turn_id": "turn-owner",
                    "message_item_id": "item-owner",
                    "role": "user",
                    "authorized_at": (
                        datetime.now(timezone.utc) - timedelta(minutes=1)
                    ).isoformat(),
                }
            ],
            "dedupe-docs",
        )
        lease_expires = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()

        with self.assertRaises(LedgerError) as raised:
            self.ledger.acquire_draft_execution(
                draft["draft_id"],
                payload,
                "dedupe-docs",
                "execution-docs-invalid",
                lease_expires,
            )
        self.assertEqual("SEND_LEASE_SCOPE_REQUIRED", raised.exception.code)

        acquired = self.ledger.acquire_draft_execution(
            draft["draft_id"],
            payload,
            "dedupe-docs",
            "execution-docs",
            lease_expires,
            lease_scope="tencent-docs-official-mcp",
        )
        self.assertEqual("EXECUTING", acquired["state"])

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

    def test_legacy_event_verification_is_disabled_for_wechat(self) -> None:
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
            draft["draft_id"],
            execution_id,
            "SEND_ATTEMPTED",
            self.successful_text_audit(),
        )
        outbound = self.ledger.ingest_event(
            "route-test",
            "fp-legacy-confirmation",
            "text",
            {"visible_text": "unique-marker", "direction": "outbound"},
        )
        with self.assertRaises(LedgerError) as raised:
            self.ledger.verify_draft(draft["draft_id"], outbound["event_id"])
        self.assertEqual("OUTBOUND_LEGACY_OBSERVATION_DISABLED", raised.exception.code)
        self.assertEqual("SEND_ATTEMPTED", self.ledger.get_draft(draft["draft_id"])["state"])

    def test_direct_database_verification_consumes_observation_once(self) -> None:
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
            self.ledger.finish_draft_execution(
                draft["draft_id"],
                execution_id,
                "SEND_ATTEMPTED",
                self.successful_text_audit(),
            )
        observation = {
            "route_id": "route-test",
            "local_id": 42,
            "server_id": "server-42",
            "occurred_at": datetime.now(timezone.utc).isoformat(),
            "source_kind": "wechat_message_database",
            "source_fingerprint": "route-user:42:server-42",
            "visible_text": "same-marker",
            "baseline_local_id": 41,
        }
        self.ledger.verify_text_draft(first["draft_id"], observation)
        with self.assertRaises(LedgerError) as raised:
            self.ledger.verify_text_draft(second["draft_id"], observation)
        self.assertEqual("OUTBOUND_OBSERVATION_ALREADY_USED", raised.exception.code)
        self.assertEqual("SEND_ATTEMPTED", self.ledger.get_draft(second["draft_id"])["state"])

    def test_direct_text_database_proof_is_audited_without_delivery(self) -> None:
        draft, payload = self.approved_wechat_draft("exact-marker", "dedupe-direct-text")
        execution_id = "execution-direct-text"
        self.ledger.acquire_draft_execution(
            draft["draft_id"],
            payload,
            "dedupe-direct-text",
            execution_id,
            (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
        )
        self.ledger.finish_draft_execution(
            draft["draft_id"],
            execution_id,
            "SEND_ATTEMPTED",
            self.successful_text_audit(),
        )

        verified = self.ledger.verify_text_draft(
            draft["draft_id"],
            {
                "route_id": "route-test",
                "local_id": 42,
                "server_id": "server-42",
                "occurred_at": datetime.now(timezone.utc).isoformat(),
                "source_kind": "wechat_message_database",
                "source_fingerprint": "route-user:42:server-42",
                "visible_text": "exact-marker",
                "baseline_local_id": 41,
            },
        )

        self.assertEqual("VERIFIED", verified["state"])
        self.assertTrue(verified["result"]["restore_succeeded"])
        self.assertEqual([], self.ledger.list_pending("subscription-test"))
        state = self.event_delivery_state(self.ledger)
        self.assertEqual(1, state["events"])
        self.assertEqual(1, state["events_acked"])
        self.assertEqual(0, state["deliveries"])

    def test_direct_text_database_proof_requires_environment_restore(self) -> None:
        draft, payload = self.approved_wechat_draft("restore-marker", "dedupe-restore-proof")
        execution_id = "execution-restore-proof"
        self.ledger.acquire_draft_execution(
            draft["draft_id"],
            payload,
            "dedupe-restore-proof",
            execution_id,
            (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
        )
        audit = self.successful_text_audit()
        audit["restore_succeeded"] = False
        audit["environment_observation"]["foreground_restored"] = False
        self.ledger.finish_draft_execution(
            draft["draft_id"],
            execution_id,
            "UNKNOWN",
            audit,
            "RESTORE_FAILED_AFTER_SEND",
        )

        with self.assertRaises(LedgerError) as raised:
            self.ledger.verify_text_draft(
                draft["draft_id"],
                {
                    "route_id": "route-test",
                    "local_id": 42,
                    "server_id": "server-42",
                    "occurred_at": datetime.now(timezone.utc).isoformat(),
                    "source_kind": "wechat_message_database",
                    "source_fingerprint": "route-user:42:server-42",
                    "visible_text": "restore-marker",
                    "baseline_local_id": 41,
                },
            )

        self.assertEqual("OUTBOUND_TEXT_ENVIRONMENT_UNVERIFIED", raised.exception.code)
        self.assertEqual("UNKNOWN", self.ledger.get_draft(draft["draft_id"])["state"])

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

    def test_recover_legacy_route_identity_from_matching_events(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger = EventLedger(Path(temp_dir) / "events.sqlite3")
            ledger.register_route(
                "legacy-route",
                identity={"chat_name": "legacy-title", "chat_type": "group"},
                state="active",
            )
            legacy_hash = ledger.get_route("legacy-route")["identity_sha256"]
            ledger.ingest_event("legacy-route", "room@chatroom:1", "text", {"text": "one"})
            ledger.ingest_event("legacy-route", "room@chatroom:2", "text", {"text": "two"})
            message_state_before = self.event_delivery_state(ledger)

            with mock.patch.object(ledger, "get_route", side_effect=AssertionError("unexpected read")):
                recovered = ledger.recover_legacy_route_identity_from_events(
                    "legacy-route",
                    legacy_hash,
                    "owner-key",
                    "room@chatroom",
                    "group",
                    "current-title",
                    verification_evidence_ref=self.RECOVERY_EVIDENCE_REF,
                    verification_evidence_sha256=self.RECOVERY_EVIDENCE_SHA256,
                    backup_sha256=self.RECOVERY_BACKUP_SHA256,
                )

            self.assertEqual(2, recovered["identity_version"])
            self.assertEqual("active", recovered["state"])
            self.assertEqual("group", recovered["chat_type"])
            self.assertEqual("current-title", recovered["display_title"])
            self.assertEqual(
                route_identity_sha256("owner-key", "room@chatroom", "group"),
                recovered["identity_sha256"],
            )
            connection = ledger._connect()
            try:
                audit = connection.execute(
                    "SELECT value FROM schema_meta WHERE key='legacy_route_recovery:legacy-route'"
                ).fetchone()
            finally:
                connection.close()
            self.assertIsNotNone(audit)
            self.assertIn(self.RECOVERY_EVIDENCE_SHA256, audit["value"])
            self.assertIn(self.RECOVERY_BACKUP_SHA256, audit["value"])
            self.assertEqual(message_state_before, self.event_delivery_state(ledger))

    def test_recover_legacy_route_identity_requires_audit_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger = EventLedger(Path(temp_dir) / "events.sqlite3")
            ledger.register_route("legacy-route", identity={"chat_name": "x"}, state="active")
            legacy_hash = ledger.get_route("legacy-route")["identity_sha256"]
            ledger.ingest_event("legacy-route", "room@chatroom:1", "text", {"text": "one"})

            with self.assertRaises(LedgerError) as raised:
                ledger.recover_legacy_route_identity_from_events(
                    "legacy-route",
                    legacy_hash,
                    "owner-key",
                    "room@chatroom",
                    "group",
                    verification_evidence_ref="",
                    verification_evidence_sha256="invalid",
                    backup_sha256="invalid",
                )

            self.assertEqual("LEGACY_ROUTE_AUDIT_EVIDENCE_REQUIRED", raised.exception.code)
            self.assertEqual(1, ledger.get_route("legacy-route")["identity_version"])

    def test_recover_legacy_route_identity_rolls_back_on_audit_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger = EventLedger(Path(temp_dir) / "events.sqlite3")
            ledger.register_route("legacy-route", identity={"chat_name": "x"}, state="active")
            legacy_hash = ledger.get_route("legacy-route")["identity_sha256"]
            ledger.ingest_event("legacy-route", "room@chatroom:1", "text", {"text": "one"})
            with ledger._transaction() as connection:
                connection.execute(
                    "INSERT INTO schema_meta(key,value) VALUES(?,?)",
                    ("legacy_route_recovery:legacy-route", "existing"),
                )

            with self.assertRaises(LedgerError) as raised:
                ledger.recover_legacy_route_identity_from_events(
                    "legacy-route",
                    legacy_hash,
                    "owner-key",
                    "room@chatroom",
                    "group",
                    verification_evidence_ref=self.RECOVERY_EVIDENCE_REF,
                    verification_evidence_sha256=self.RECOVERY_EVIDENCE_SHA256,
                    backup_sha256=self.RECOVERY_BACKUP_SHA256,
                )

            self.assertEqual("LEGACY_ROUTE_AUDIT_CONFLICT", raised.exception.code)
            self.assertEqual(1, ledger.get_route("legacy-route")["identity_version"])
            self.assertEqual(legacy_hash, ledger.get_route("legacy-route")["identity_sha256"])

    def test_recover_legacy_route_identity_rejects_already_precise_route(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger = EventLedger(Path(temp_dir) / "events.sqlite3")
            ledger.register_route(
                "precise-route",
                owner_account_key="owner-key",
                username="room@chatroom",
                chat_type="group",
                state="active",
            )
            precise_hash = ledger.get_route("precise-route")["identity_sha256"]
            ledger.ingest_event("precise-route", "room@chatroom:1", "text", {"text": "one"})

            with self.assertRaises(LedgerError) as raised:
                ledger.recover_legacy_route_identity_from_events(
                    "precise-route",
                    precise_hash,
                    "owner-key",
                    "room@chatroom",
                    "group",
                    verification_evidence_ref=self.RECOVERY_EVIDENCE_REF,
                    verification_evidence_sha256=self.RECOVERY_EVIDENCE_SHA256,
                    backup_sha256=self.RECOVERY_BACKUP_SHA256,
                )

            self.assertEqual("LEGACY_ROUTE_RECOVERY_NOT_APPLICABLE", raised.exception.code)

    def test_recover_legacy_route_identity_rejects_changed_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger = EventLedger(Path(temp_dir) / "events.sqlite3")
            ledger.register_route("legacy-route", identity={"chat_name": "x"}, state="active")
            ledger.ingest_event("legacy-route", "room@chatroom:1", "text", {"text": "one"})

            with self.assertRaises(LedgerError) as raised:
                ledger.recover_legacy_route_identity_from_events(
                    "legacy-route",
                    "a" * 64,
                    "owner-key",
                    "room@chatroom",
                    "group",
                    verification_evidence_ref=self.RECOVERY_EVIDENCE_REF,
                    verification_evidence_sha256=self.RECOVERY_EVIDENCE_SHA256,
                    backup_sha256=self.RECOVERY_BACKUP_SHA256,
                )

            self.assertEqual("LEGACY_ROUTE_HASH_MISMATCH", raised.exception.code)
            self.assertEqual(1, ledger.get_route("legacy-route")["identity_version"])
            self.assertEqual("active", ledger.get_route("legacy-route")["state"])

    def test_recover_legacy_route_identity_requires_existing_events(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger = EventLedger(Path(temp_dir) / "events.sqlite3")
            ledger.register_route("legacy-route", identity={"chat_name": "x"}, state="active")
            legacy_hash = ledger.get_route("legacy-route")["identity_sha256"]

            with self.assertRaises(LedgerError) as raised:
                ledger.recover_legacy_route_identity_from_events(
                    "legacy-route",
                    legacy_hash,
                    "owner-key",
                    "room@chatroom",
                    "group",
                    verification_evidence_ref=self.RECOVERY_EVIDENCE_REF,
                    verification_evidence_sha256=self.RECOVERY_EVIDENCE_SHA256,
                    backup_sha256=self.RECOVERY_BACKUP_SHA256,
                )

            self.assertEqual("LEGACY_ROUTE_EVIDENCE_MISSING", raised.exception.code)

    def test_recover_legacy_route_identity_requires_active_route(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger = EventLedger(Path(temp_dir) / "events.sqlite3")
            ledger.register_route("legacy-route", identity={"chat_name": "x"}, state="active")
            legacy_hash = ledger.get_route("legacy-route")["identity_sha256"]
            ledger.ingest_event("legacy-route", "room@chatroom:1", "text", {"text": "one"})
            with ledger._transaction() as connection:
                connection.execute(
                    "UPDATE routes SET state='quarantine' WHERE route_id='legacy-route'"
                )

            with self.assertRaises(LedgerError) as raised:
                ledger.recover_legacy_route_identity_from_events(
                    "legacy-route",
                    legacy_hash,
                    "owner-key",
                    "room@chatroom",
                    "group",
                    verification_evidence_ref=self.RECOVERY_EVIDENCE_REF,
                    verification_evidence_sha256=self.RECOVERY_EVIDENCE_SHA256,
                    backup_sha256=self.RECOVERY_BACKUP_SHA256,
                )

            self.assertEqual("LEGACY_ROUTE_RECOVERY_REQUIRES_ACTIVE", raised.exception.code)
            self.assertEqual("quarantine", ledger.get_route("legacy-route")["state"])

    def test_recover_legacy_group_requires_chatroom_username(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger = EventLedger(Path(temp_dir) / "events.sqlite3")
            ledger.register_route("legacy-route", identity={"chat_name": "x"}, state="active")
            legacy_hash = ledger.get_route("legacy-route")["identity_sha256"]
            ledger.ingest_event("legacy-route", "not-a-room:1", "text", {"text": "one"})

            with self.assertRaises(LedgerError) as raised:
                ledger.recover_legacy_route_identity_from_events(
                    "legacy-route",
                    legacy_hash,
                    "owner-key",
                    "not-a-room",
                    "group",
                    verification_evidence_ref=self.RECOVERY_EVIDENCE_REF,
                    verification_evidence_sha256=self.RECOVERY_EVIDENCE_SHA256,
                    backup_sha256=self.RECOVERY_BACKUP_SHA256,
                )

            self.assertEqual("ROUTE_IDENTITY_INCOMPLETE", raised.exception.code)

    def test_recover_legacy_friend_rejects_chatroom_username(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger = EventLedger(Path(temp_dir) / "events.sqlite3")
            ledger.register_route("legacy-route", identity={"chat_name": "x"}, state="active")
            legacy_hash = ledger.get_route("legacy-route")["identity_sha256"]
            ledger.ingest_event("legacy-route", "room@chatroom:1", "text", {"text": "one"})

            with self.assertRaises(LedgerError) as raised:
                ledger.recover_legacy_route_identity_from_events(
                    "legacy-route",
                    legacy_hash,
                    "owner-key",
                    "room@chatroom",
                    "friend",
                    verification_evidence_ref=self.RECOVERY_EVIDENCE_REF,
                    verification_evidence_sha256=self.RECOVERY_EVIDENCE_SHA256,
                    backup_sha256=self.RECOVERY_BACKUP_SHA256,
                )

            self.assertEqual("ROUTE_IDENTITY_INCOMPLETE", raised.exception.code)

    def test_recover_legacy_route_rejects_colon_in_username(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger = EventLedger(Path(temp_dir) / "events.sqlite3")
            ledger.register_route("legacy-route", identity={"chat_name": "x"}, state="active")
            legacy_hash = ledger.get_route("legacy-route")["identity_sha256"]
            ledger.ingest_event("legacy-route", "friend:name:1", "text", {"text": "one"})

            with self.assertRaises(LedgerError) as raised:
                ledger.recover_legacy_route_identity_from_events(
                    "legacy-route",
                    legacy_hash,
                    "owner-key",
                    "friend:name",
                    "friend",
                    verification_evidence_ref=self.RECOVERY_EVIDENCE_REF,
                    verification_evidence_sha256=self.RECOVERY_EVIDENCE_SHA256,
                    backup_sha256=self.RECOVERY_BACKUP_SHA256,
                )

            self.assertEqual("ROUTE_IDENTITY_INCOMPLETE", raised.exception.code)

    def test_recover_legacy_route_identity_rejects_mixed_event_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger = EventLedger(Path(temp_dir) / "events.sqlite3")
            ledger.register_route("legacy-route", identity={"chat_name": "x"}, state="active")
            legacy_hash = ledger.get_route("legacy-route")["identity_sha256"]
            ledger.ingest_event("legacy-route", "room@chatroom:1", "text", {"text": "one"})
            ledger.ingest_event("legacy-route", "other@chatroom:2", "text", {"text": "two"})
            message_state_before = self.event_delivery_state(ledger)

            with self.assertRaises(LedgerError) as raised:
                ledger.recover_legacy_route_identity_from_events(
                    "legacy-route",
                    legacy_hash,
                    "owner-key",
                    "room@chatroom",
                    "group",
                    verification_evidence_ref=self.RECOVERY_EVIDENCE_REF,
                    verification_evidence_sha256=self.RECOVERY_EVIDENCE_SHA256,
                    backup_sha256=self.RECOVERY_BACKUP_SHA256,
                )

            self.assertEqual("LEGACY_ROUTE_EVIDENCE_MISMATCH", raised.exception.code)
            self.assertEqual(1, ledger.get_route("legacy-route")["identity_version"])
            self.assertEqual("active", ledger.get_route("legacy-route")["state"])
            self.assertEqual(message_state_before, self.event_delivery_state(ledger))

    def test_recover_legacy_route_identity_rejects_precise_identity_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            ledger = EventLedger(Path(temp_dir) / "events.sqlite3")
            ledger.register_route(
                "precise-route",
                owner_account_key="owner-key",
                username="room@chatroom",
                chat_type="group",
                state="active",
            )
            ledger.register_route("legacy-route", identity={"chat_name": "x"}, state="active")
            legacy_hash = ledger.get_route("legacy-route")["identity_sha256"]
            ledger.ingest_event("legacy-route", "room@chatroom:1", "text", {"text": "one"})

            with self.assertRaises(LedgerError) as raised:
                ledger.recover_legacy_route_identity_from_events(
                    "legacy-route",
                    legacy_hash,
                    "owner-key",
                    "room@chatroom",
                    "group",
                    verification_evidence_ref=self.RECOVERY_EVIDENCE_REF,
                    verification_evidence_sha256=self.RECOVERY_EVIDENCE_SHA256,
                    backup_sha256=self.RECOVERY_BACKUP_SHA256,
                )

            self.assertEqual("ROUTE_IDENTITY_CONFLICT", raised.exception.code)
            self.assertEqual(1, ledger.get_route("legacy-route")["identity_version"])


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
