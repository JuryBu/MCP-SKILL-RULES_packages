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


@dataclass
class FakeLedgerStorage:
    state: str = OutboundState.APPROVED.value
    used_dedupe_keys: set[str] = field(default_factory=set)
    finishes: list[dict[str, Any]] = field(default_factory=list)


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


def sender(ledger: FakeLedger, backend: FakeBackend) -> SafeTextOutbound:
    return SafeTextOutbound(ledger, PrivateBindingRouteVerifier(binding()), backend)


def execute(sender_instance: SafeTextOutbound, dedupe_key: str = "dedupe-synthetic"):
    return sender_instance.execute_text(
        draft_id="draft-synthetic",
        payload=PAYLOAD,
        dedupe_key=dedupe_key,
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-synthetic",
    )


class SafeTextOutboundTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
