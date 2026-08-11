from __future__ import annotations

import hashlib
import unittest
from dataclasses import dataclass, field
from typing import Any

from wechat_docs_mcp.outbound import (
    FocusState,
    OutboundState,
    SafeTextOutbound,
    UiBackendError,
)
from wechat_docs_mcp.route_verifier import PrivateBindingRouteVerifier, precise_route_identity_sha256


OWNER_KEY = "synthetic-owner-key"
USERNAME = "synthetic-room@chatroom"
PAYLOAD = {"text": "SYNTHETIC_TEST_MARKER"}


def text_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def route_record() -> dict[str, Any]:
    return {
        "route_id": "route-synthetic",
        "state": "active",
        "identity_version": 2,
        "identity_sha256": precise_route_identity_sha256(OWNER_KEY, USERNAME, "group"),
        "owner_account_key_sha256": text_sha256(OWNER_KEY),
        "username_sha256": text_sha256(USERNAME),
        "chat_type": "group",
    }


def binding() -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "ownerAccountKey": OWNER_KEY,
        "routes": [
            {
                "route_id": "route-synthetic",
                "display_title": "Synthetic Room",
                "chat_type": "group",
                "username": USERNAME,
                "state": "active",
                "outbound": {"enabled": True, "text": True},
            }
        ],
    }


def legacy_binding() -> dict[str, Any]:
    value = binding()
    value["schemaVersion"] = 1
    value["routes"][0].pop("state")
    return value


@dataclass
class FakeLedgerStorage:
    state: str = OutboundState.APPROVED.value
    used_dedupe_keys: set[str] = field(default_factory=set)
    finishes: list[dict[str, Any]] = field(default_factory=list)
    verifications: list[dict[str, Any]] = field(default_factory=list)


class FakeLedgerError(RuntimeError):
    pass


class FakeLedger:
    def __init__(self, storage: FakeLedgerStorage | None = None) -> None:
        self.storage = storage or FakeLedgerStorage()

    def get_route(self, route_id: str) -> dict[str, Any]:
        if route_id != "route-synthetic":
            raise FakeLedgerError("route missing")
        return route_record()

    def get_draft(self, draft_id: str) -> dict[str, Any]:
        return {
            "draft_id": draft_id,
            "route_id": "route-synthetic",
            "state": self.storage.state,
            "owner_authorization_refs": [{"role": "user", "message_item_id": "synthetic-item"}],
        }

    def acquire_draft_execution(
        self,
        draft_id: str,
        payload: dict[str, Any],
        dedupe_key: str,
        execution_id: str,
        lease_expires_at: str,
    ) -> dict[str, Any]:
        if dedupe_key in self.storage.used_dedupe_keys:
            raise FakeLedgerError("dedupe conflict")
        if self.storage.state != OutboundState.APPROVED.value:
            raise FakeLedgerError("draft is not approved")
        self.storage.used_dedupe_keys.add(dedupe_key)
        self.storage.state = OutboundState.EXECUTING.value
        return {"draft_id": draft_id, "execution_id": execution_id, "lease_expires_at": lease_expires_at}

    def finish_draft_execution(
        self,
        draft_id: str,
        execution_id: str,
        next_state: str,
        result: dict[str, Any] | None = None,
        error_code: str | None = None,
    ) -> dict[str, Any]:
        self.storage.state = next_state
        finished = {
            "draft_id": draft_id,
            "execution_id": execution_id,
            "state": next_state,
            "result": result,
            "error_code": error_code,
        }
        self.storage.finishes.append(finished)
        return finished

    def verify_text_draft(self, draft_id: str, observation: dict[str, Any]) -> dict[str, Any]:
        self.storage.state = OutboundState.VERIFIED.value
        self.storage.verifications.append(observation)
        return {"draft_id": draft_id, "state": OutboundState.VERIFIED.value, "error_code": None}

    def mark_draft_unknown(
        self,
        draft_id: str,
        expected_states: list[str],
        error_code: str,
        result: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        assert self.storage.state in expected_states
        self.storage.state = OutboundState.UNKNOWN.value
        return {"draft_id": draft_id, "state": OutboundState.UNKNOWN.value, "error_code": error_code}


class FakeBackend:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.keyboard_actions: list[str] = []
        self.window_focus = FocusState.VERIFIED
        self.focus_states: list[FocusState] = [FocusState.VERIFIED] * 8
        self.failures: dict[str, Exception] = {}

    def _step(self, name: str) -> None:
        self.calls.append(name)
        if name in self.failures:
            raise self.failures[name]

    def snapshot_environment(self) -> object:
        self._step("snapshot")
        return {"foreground": "synthetic"}

    def wake(self) -> None:
        self._step("wake")

    def locate_window(self) -> object:
        self._step("locate")
        return "synthetic-window"

    def window_focus_state(self, window: object) -> FocusState:
        self._step("window_focus")
        return self.window_focus

    def navigate_visible(self, window: object, route: object) -> None:
        self._step("navigate")

    def focus_state(self, window: object, route: object) -> FocusState:
        self._step("focus")
        return self.focus_states.pop(0)

    def claim_empty_draft(self, window: object, route: object) -> object:
        self._step("claim")
        return "owned-draft"

    def write_owned_draft(self, window: object, draft_handle: object, text: str) -> None:
        self.keyboard_actions.append("write")
        self._step("write")

    def send_owned_draft(self, window: object, draft_handle: object) -> None:
        self.keyboard_actions.append("send")
        self._step("send")

    def clear_owned_draft(self, window: object, draft_handle: object) -> None:
        self.keyboard_actions.append("clear")
        self._step("clear")

    def restore_environment(self, snapshot: object) -> None:
        self._step("restore")

    @staticmethod
    def environment_observation() -> dict[str, Any]:
        return {
            "restore_skipped_user_interaction": False,
            "foreground_restored": True,
            "mouse_restored": True,
            "clipboard_semantics_restored": True,
        }


class FakeDatabaseVerifier:
    def __init__(self, *, failure: Exception | None = None) -> None:
        self.failure = failure
        self.baselines: list[object] = []
        self.verifications: list[tuple[object, str, int]] = []

    def baseline(self, route: object) -> int:
        self.baselines.append(route)
        return 41

    def verify(self, route: object, text: str, baseline_local_id: int) -> dict[str, Any]:
        self.verifications.append((route, text, baseline_local_id))
        if self.failure is not None:
            raise self.failure
        return {
            "local_id": 42,
            "server_id": 4200,
            "status": 2,
            "origin_source": 1,
            "text": text,
        }


def sender(
    ledger: FakeLedger,
    backend: FakeBackend,
    database_verifier: FakeDatabaseVerifier | None = None,
    execution_gate=None,
) -> SafeTextOutbound:
    return SafeTextOutbound(
        ledger,
        PrivateBindingRouteVerifier(binding()),
        backend,
        database_verifier,
        execution_gate,
    )


def execute(sender_instance: SafeTextOutbound, dedupe_key: str = "dedupe-synthetic"):
    return sender_instance.execute_text(
        draft_id="draft-synthetic",
        payload=PAYLOAD,
        dedupe_key=dedupe_key,
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-synthetic",
    )


class SafeTextOutboundTests(unittest.TestCase):
    def test_legacy_private_binding_keeps_exact_outbound_verification(self) -> None:
        verified = PrivateBindingRouteVerifier(legacy_binding()).verify(
            "route-synthetic",
            route_record(),
            "text",
        )
        self.assertEqual(USERNAME, verified.username)

    def test_wake_exception_restores_snapshot(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        backend.failures["wake"] = UiBackendError("WAKE_FAILED", "synthetic")
        result = execute(sender(ledger, backend))
        self.assertEqual(OutboundState.FAILED, result.state)
        self.assertEqual(["snapshot", "wake", "restore"], backend.calls)

    def test_unverified_focus_performs_no_keyboard_action(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        backend.focus_states = [FocusState.UNKNOWN]
        result = execute(sender(ledger, backend))
        self.assertEqual(OutboundState.FAILED, result.state)
        self.assertEqual([], backend.keyboard_actions)
        self.assertNotIn("claim", backend.calls)
        self.assertEqual("restore", backend.calls[-1])

    def test_unverified_window_focus_does_not_navigate_or_press_keys(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        backend.window_focus = FocusState.UNKNOWN
        result = execute(sender(ledger, backend))
        self.assertEqual(OutboundState.FAILED, result.state)
        self.assertNotIn("navigate", backend.calls)
        self.assertEqual([], backend.keyboard_actions)

    def test_owned_draft_is_cleared_after_write_failure(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        backend.failures["write"] = UiBackendError("WRITE_FAILED", "synthetic")
        result = execute(sender(ledger, backend))
        self.assertEqual(OutboundState.FAILED, result.state)
        self.assertTrue(result.cleanup_performed)
        self.assertEqual(["write", "clear"], backend.keyboard_actions)

    def test_cleanup_failure_preserves_primary_error(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        backend.failures["write"] = UiBackendError("WRITE_FAILED", "synthetic")
        backend.failures["clear"] = UiBackendError("CLEAR_FAILED", "synthetic")

        result = execute(sender(ledger, backend))

        self.assertEqual(OutboundState.FAILED, result.state)
        self.assertEqual("WRITE_FAILED", result.error_code)
        self.assertEqual("OWNED_DRAFT_CLEANUP_FAILED", result.cleanup_error_code)
        self.assertFalse(result.cleanup_performed)

    def test_lost_focus_skips_owned_draft_cleanup(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        backend.focus_states = [FocusState.VERIFIED, FocusState.VERIFIED, FocusState.UNKNOWN, FocusState.UNKNOWN]
        result = execute(sender(ledger, backend))
        self.assertEqual(OutboundState.FAILED, result.state)
        self.assertEqual(["write"], backend.keyboard_actions)
        self.assertFalse(result.cleanup_performed)

    def test_successful_key_action_is_only_send_attempted(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        result = execute(sender(ledger, backend))
        self.assertEqual(OutboundState.SEND_ATTEMPTED, result.state)
        self.assertNotEqual(OutboundState.VERIFIED, result.state)
        self.assertEqual(OutboundState.SEND_ATTEMPTED.value, ledger.storage.finishes[-1]["state"])

    def test_runtime_gate_closing_before_send_cleans_draft_without_sending(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        gate_states = iter([True, False])

        result = execute(
            sender(
                ledger,
                backend,
                FakeDatabaseVerifier(),
                lambda: next(gate_states),
            )
        )

        self.assertEqual(OutboundState.FAILED, result.state)
        self.assertEqual("OUTBOUND_DISABLED", result.error_code)
        self.assertFalse(result.send_action_invoked)
        self.assertIn("write", backend.keyboard_actions)
        self.assertIn("clear", backend.keyboard_actions)
        self.assertNotIn("send", backend.keyboard_actions)
        self.assertTrue(result.restore_succeeded)

    def test_unique_database_confirmation_promotes_send_to_verified(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        verifier = FakeDatabaseVerifier()

        result = execute(sender(ledger, backend, verifier))

        self.assertEqual(OutboundState.VERIFIED, result.state)
        self.assertEqual([41], [item[2] for item in verifier.verifications])
        self.assertEqual(41, ledger.storage.verifications[0]["baseline_local_id"])
        self.assertTrue(result.send_action_invoked)
        self.assertTrue(result.restore_succeeded)
        self.assertTrue(
            ledger.storage.finishes[-1]["result"]["environment_observation"][
                "foreground_restored"
            ]
        )

    def test_database_confirmation_occurs_before_environment_restore(self) -> None:
        timeline: list[str] = []

        class OrderedBackend(FakeBackend):
            def restore_environment(self, snapshot: object) -> None:
                timeline.append("restore")
                super().restore_environment(snapshot)

        class OrderedVerifier(FakeDatabaseVerifier):
            def verify(
                self,
                route: object,
                text: str,
                baseline_local_id: int,
            ) -> dict[str, Any]:
                timeline.append("verify")
                return super().verify(route, text, baseline_local_id)

        result = execute(sender(FakeLedger(), OrderedBackend(), OrderedVerifier()))

        self.assertEqual(OutboundState.VERIFIED, result.state)
        self.assertEqual(["verify", "restore"], timeline)

    def test_database_confirmation_failure_is_unknown_and_not_retryable(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        failure = UiBackendError("TEXT_DATABASE_AMBIGUOUS", "synthetic")

        result = execute(sender(ledger, backend, FakeDatabaseVerifier(failure=failure)))

        self.assertEqual(OutboundState.UNKNOWN, result.state)
        self.assertEqual("TEXT_DATABASE_AMBIGUOUS", result.error_code)
        self.assertEqual(OutboundState.UNKNOWN.value, ledger.storage.state)

    def test_send_exception_becomes_unknown_without_cleanup(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        backend.failures["send"] = UiBackendError(
            "SEND_OUTCOME_UNKNOWN",
            "synthetic",
            send_may_have_occurred=True,
        )
        result = execute(sender(ledger, backend))
        self.assertEqual(OutboundState.UNKNOWN, result.state)
        self.assertEqual(["write", "send"], backend.keyboard_actions)
        self.assertFalse(result.cleanup_performed)

    def test_pre_key_send_refusal_is_failed_and_cleans_owned_draft(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        backend.failures["send"] = UiBackendError("SEND_GUARD_FAILED", "synthetic")
        result = execute(sender(ledger, backend))
        self.assertEqual(OutboundState.FAILED, result.state)
        self.assertEqual(["write", "send", "clear"], backend.keyboard_actions)
        self.assertTrue(result.cleanup_performed)

    def test_restore_failure_after_send_becomes_unknown(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        backend.failures["restore"] = RuntimeError("synthetic")
        result = execute(sender(ledger, backend))
        self.assertEqual(OutboundState.UNKNOWN, result.state)
        self.assertEqual("RESTORE_FAILED_AFTER_SEND", result.error_code)
        self.assertEqual("RESTORE_FAILED_AFTER_SEND", result.restore_error_code)

    def test_restore_failure_preserves_primary_error_and_records_secondary_error(self) -> None:
        ledger = FakeLedger()
        backend = FakeBackend()
        backend.failures["locate"] = UiBackendError("WECHAT_FOCUS_FAILED", "synthetic")
        backend.failures["restore"] = RuntimeError("synthetic restore failure")

        result = execute(sender(ledger, backend))

        self.assertEqual(OutboundState.FAILED, result.state)
        self.assertEqual("WECHAT_FOCUS_FAILED", result.error_code)
        self.assertEqual("RESTORE_FAILED", result.restore_error_code)
        self.assertEqual(
            "RESTORE_FAILED",
            ledger.storage.finishes[-1]["result"]["restore_error_code"],
        )

    def test_reload_dedupe_refuses_second_execution_before_ui(self) -> None:
        storage = FakeLedgerStorage()
        first_backend = FakeBackend()
        first = execute(sender(FakeLedger(storage), first_backend), dedupe_key="dedupe-reload")
        self.assertEqual(OutboundState.SEND_ATTEMPTED, first.state)

        storage.state = OutboundState.APPROVED.value
        restarted_backend = FakeBackend()
        with self.assertRaises(FakeLedgerError):
            execute(sender(FakeLedger(storage), restarted_backend), dedupe_key="dedupe-reload")
        self.assertEqual([], restarted_backend.calls)

    def test_hidden_wm_char_capability_is_disabled(self) -> None:
        self.assertFalse(SafeTextOutbound.capabilities.experimental_hidden_wm_char)
        self.assertTrue(SafeTextOutbound.capabilities.hidden_after_verified_navigation)


if __name__ == "__main__":
    unittest.main()
