from __future__ import annotations

import hashlib
import ctypes
import struct
from ctypes import wintypes
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from wechat_docs_mcp import win32_attachment_ui
from wechat_docs_mcp.attachments import AttachmentRegistry
from wechat_docs_mcp.ledger import EventLedger, LedgerError
from wechat_docs_mcp.outbound import FocusState, OutboundRefused, OutboundState, UiBackendError
from wechat_docs_mcp.route_verifier import PrivateBindingRouteVerifier
from wechat_docs_mcp.wechat_attachment_outbound import SafeAttachmentOutbound
from wechat_docs_mcp.wechat_outbound_verifier import AttachmentDatabaseVerificationError
from wechat_docs_mcp.win32_attachment_ui import (
    CF_HDROP,
    INPUT,
    ClipboardFormat,
    Win32EnvironmentSnapshot,
    Win32WechatAttachmentBackend,
    Win32WechatTextBackend,
)


OWNER_KEY = "synthetic-owner"
USERNAME = "synthetic-room@chatroom"


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _binding() -> dict[str, object]:
    return {
        "schemaVersion": 2,
        "ownerAccountKey": OWNER_KEY,
        "routes": [
            {
                "route_id": "route-a",
                "display_title": "Synthetic Room",
                "chat_type": "group",
                "username": USERNAME,
                "state": "active",
                "outbound": {"enabled": True, "file": True, "image": True},
            }
        ],
    }


class FakeBackend:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.focus = FocusState.VERIFIED
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
        return "window"

    def window_focus_state(self, window: object) -> FocusState:
        self._step("window_focus")
        return FocusState.VERIFIED

    def navigate_visible(self, window: object, route: object) -> None:
        self._step("navigate")

    def claim_empty_draft(self, window: object, route: object) -> object:
        self._step("claim")
        return {"owned": True}

    def write_owned_attachment(
        self,
        window: object,
        draft_handle: object,
        route: object,
        path: Path,
    ) -> None:
        self._step("write")

    def focus_state(self, window: object, draft_handle: object, route: object) -> FocusState:
        self._step("focus")
        return self.focus

    def send_owned_attachment(self, window: object, draft_handle: object) -> None:
        self._step("send")

    def clear_owned_attachment(self, window: object, draft_handle: object) -> None:
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
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.failure: Exception | None = None

    def baseline(self, route: object) -> int:
        self.calls.append("baseline")
        return 20

    def verify(
        self,
        route: object,
        kind: str,
        payload: dict[str, Any],
        baseline_local_id: int,
    ) -> dict[str, Any]:
        self.calls.append("verify")
        if self.failure is not None:
            raise self.failure
        return {
            "route_id": "route-a",
            "local_id": baseline_local_id + 1,
            "server_id": "1001",
            "observed_at": "2026-01-01T00:00:01+00:00",
            "source_kind": "wechat_message_database",
        }


def _prepared(tmp_path: Path) -> tuple[EventLedger, dict[str, Any], dict[str, Any]]:
    ledger = EventLedger(tmp_path / "events.sqlite3")
    ledger.register_route(
        "route-a",
        profile="test",
        identity={
            "owner_account_key": OWNER_KEY,
            "username": USERNAME,
            "chat_type": "group",
            "display_title": "Synthetic Room",
        },
        state="active",
    )
    ledger.register_subscription(
        "route-a",
        "conversation-a",
        1,
        subscription_id="subscription-a",
        send_capability=True,
        policy_ref="synthetic-policy",
    )
    intake = tmp_path / "intake"
    upload = tmp_path / "upload"
    intake.mkdir()
    upload.mkdir()
    source = upload / "sample.txt"
    source.write_text("safe", encoding="utf-8")
    prepared = AttachmentRegistry(ledger, intake, upload).prepare_upload_draft(
        "subscription-a",
        "route-a",
        source,
        "dedupe-upload",
        "file",
        "2099-01-01T00:00:00+00:00",
    )
    payload = prepared["draft"]["payload"]
    ledger.approve_draft(
        prepared["draft"]["draft_id"],
        payload,
        [
            {
                "conversation_id": "conversation-owner",
                "turn_id": "turn-owner",
                "message_item_id": "item-owner",
                "role": "user",
                "authorized_at": "2026-01-01T00:00:00+00:00",
            }
        ],
        "dedupe-upload",
        called_at="2026-01-02T00:00:00+00:00",
    )
    return ledger, prepared, payload


def _remote_confirmation(
    prepared: dict[str, Any],
    payload: dict[str, Any],
    *,
    authorized_at: str = "2026-01-01T00:00:02+00:00",
) -> dict[str, Any]:
    return {
        "status": "receiver_downloaded",
        "draft_id": prepared["draft"]["draft_id"],
        "route_id": "route-a",
        "file_name": payload["file_name"],
        "byte_count": payload["byte_count"],
        "sha256": payload["sha256"],
        "content_md5": payload["content_md5"],
        "owner_confirmation_ref": {
            "conversation_id": "conversation-owner",
            "turn_id": "turn-confirmation",
            "message_item_id": "item-confirmation",
            "role": "user",
            "authorized_at": authorized_at,
        },
    }


def _sender(
    ledger: EventLedger,
    backend: FakeBackend,
    verifier: FakeDatabaseVerifier,
    upload_root: Path,
    execution_gate=None,
):
    return SafeAttachmentOutbound(
        ledger,
        PrivateBindingRouteVerifier(_binding()),
        backend,
        verifier,
        upload_root,
        execution_gate,
    )


def test_attachment_send_requires_remote_confirmation_after_database_proof(tmp_path: Path) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    backend = FakeBackend()
    verifier = FakeDatabaseVerifier()

    result = _sender(ledger, backend, verifier, tmp_path / "upload").execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )

    assert result.state is OutboundState.UNKNOWN
    assert result.error_code == "ATTACHMENT_REMOTE_CONFIRMATION_REQUIRED"
    assert backend.calls[-1] == "restore"
    assert verifier.calls == ["baseline", "verify"]
    draft = ledger.get_draft(prepared["draft"]["draft_id"])
    assert draft["state"] == "UNKNOWN"
    assert draft["result"]["local_attachment_observation"]["local_id"] == 21
    assert draft["result"]["environment_observation"]["foreground_restored"] is True
    transfer = AttachmentRegistry(ledger, tmp_path / "intake", tmp_path / "upload").get(
        prepared["transfer"]["transfer_id"]
    )
    assert transfer["state"] != "VERIFIED"


def test_attachment_runtime_gate_closing_before_send_cleans_draft(tmp_path: Path) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    backend = FakeBackend()
    gate_states = iter([True, False])

    result = _sender(
        ledger,
        backend,
        FakeDatabaseVerifier(),
        tmp_path / "upload",
        lambda: next(gate_states),
    ).execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )

    assert result.state is OutboundState.FAILED
    assert result.error_code == "ATTACHMENT_OUTBOUND_DISABLED"
    assert result.send_action_invoked is False
    assert "write" in backend.calls
    assert "clear" in backend.calls
    assert "send" not in backend.calls
    assert result.restore_succeeded is True


def test_attachment_database_confirmation_precedes_environment_restore(tmp_path: Path) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    timeline: list[str] = []

    class OrderedBackend(FakeBackend):
        def restore_environment(self, snapshot: object) -> None:
            timeline.append("restore")
            super().restore_environment(snapshot)

    class OrderedVerifier(FakeDatabaseVerifier):
        def verify(
            self,
            route: object,
            kind: str,
            payload: dict[str, Any],
            baseline_local_id: int,
        ) -> dict[str, Any]:
            timeline.append("verify")
            return super().verify(route, kind, payload, baseline_local_id)

    _sender(ledger, OrderedBackend(), OrderedVerifier(), tmp_path / "upload").execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )

    assert timeline == ["verify", "restore"]


def test_attachment_restore_failure_preserves_primary_error(tmp_path: Path) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    backend = FakeBackend()
    backend.failures["locate"] = UiBackendError("WECHAT_FOCUS_FAILED", "synthetic")
    backend.failures["restore"] = RuntimeError("synthetic restore failure")

    result = _sender(ledger, backend, FakeDatabaseVerifier(), tmp_path / "upload").execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )

    assert result.state is OutboundState.FAILED
    assert result.error_code == "WECHAT_FOCUS_FAILED"
    assert result.restore_error_code == "RESTORE_FAILED"
    draft = ledger.get_draft(prepared["draft"]["draft_id"])
    assert draft["result"]["restore_error_code"] == "RESTORE_FAILED"


def test_attachment_cleanup_failure_preserves_primary_error(tmp_path: Path) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    backend = FakeBackend()
    backend.failures["write"] = UiBackendError("ATTACHMENT_WRITE_FAILED", "synthetic")
    backend.failures["clear"] = UiBackendError("ATTACHMENT_CLEAR_FAILED", "synthetic")

    result = _sender(ledger, backend, FakeDatabaseVerifier(), tmp_path / "upload").execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )

    assert result.state is OutboundState.FAILED
    assert result.error_code == "ATTACHMENT_WRITE_FAILED"
    assert result.cleanup_error_code == "ATTACHMENT_OWNED_DRAFT_CLEANUP_FAILED"
    draft = ledger.get_draft(prepared["draft"]["draft_id"])
    assert draft["result"]["cleanup_error_code"] == "ATTACHMENT_OWNED_DRAFT_CLEANUP_FAILED"


def test_attachment_uses_global_wechat_ui_lease_scope(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    scopes: list[str | None] = []
    original_acquire = ledger.acquire_draft_execution

    def capture_scope(*args: object, **kwargs: object) -> dict[str, Any]:
        scopes.append(kwargs.get("lease_scope"))
        return original_acquire(*args, **kwargs)

    monkeypatch.setattr(ledger, "acquire_draft_execution", capture_scope)
    _sender(ledger, FakeBackend(), FakeDatabaseVerifier(), tmp_path / "upload").execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )

    assert scopes == ["wechat-visible-ui"]


def test_attachment_remote_confirmation_promotes_existing_unknown_without_resend(
    tmp_path: Path,
) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    result = _sender(ledger, FakeBackend(), FakeDatabaseVerifier(), tmp_path / "upload").execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )
    assert result.state is OutboundState.UNKNOWN
    draft = ledger.get_draft(prepared["draft"]["draft_id"])
    observation = dict(draft["result"]["local_attachment_observation"])
    observation["remote_confirmation"] = {
        "status": "receiver_downloaded",
        "draft_id": prepared["draft"]["draft_id"],
        "route_id": "route-a",
        "file_name": payload["file_name"],
        "byte_count": payload["byte_count"],
        "sha256": payload["sha256"],
        "content_md5": payload["content_md5"],
        "owner_confirmation_ref": {
            "conversation_id": "conversation-owner",
            "turn_id": "turn-confirmation",
            "message_item_id": "item-confirmation",
            "role": "user",
            "authorized_at": "2026-01-01T00:00:02+00:00",
        },
    }

    verified = ledger.verify_attachment_draft(prepared["draft"]["draft_id"], observation)

    assert verified["state"] == "VERIFIED"
    assert verified["result"]["remote_confirmation"]["status"] == "receiver_downloaded"


def test_attachment_remote_confirmation_rejects_non_user_evidence(tmp_path: Path) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    _sender(ledger, FakeBackend(), FakeDatabaseVerifier(), tmp_path / "upload").execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )
    observation = dict(
        ledger.get_draft(prepared["draft"]["draft_id"])["result"][
            "local_attachment_observation"
        ]
    )
    observation["remote_confirmation"] = {
        "status": "receiver_visible_and_downloadable",
        "draft_id": prepared["draft"]["draft_id"],
        "route_id": "route-a",
        "file_name": payload["file_name"],
        "byte_count": payload["byte_count"],
        "sha256": payload["sha256"],
        "content_md5": payload["content_md5"],
        "owner_confirmation_ref": {
            "conversation_id": "conversation-agent",
            "turn_id": "turn-agent",
            "message_item_id": "item-agent",
            "role": "assistant",
            "authorized_at": "2026-01-01T00:00:02+00:00",
        },
    }

    with pytest.raises(LedgerError) as raised:
        ledger.verify_attachment_draft(prepared["draft"]["draft_id"], observation)

    assert raised.value.code == "OUTBOUND_ATTACHMENT_REMOTE_PROOF_INVALID"


def test_attachment_remote_confirmation_rejects_changed_attachment_identity(tmp_path: Path) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    _sender(ledger, FakeBackend(), FakeDatabaseVerifier(), tmp_path / "upload").execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )
    observation = dict(
        ledger.get_draft(prepared["draft"]["draft_id"])["result"][
            "local_attachment_observation"
        ]
    )
    observation["remote_confirmation"] = _remote_confirmation(prepared, payload)
    observation["remote_confirmation"]["sha256"] = "f" * 64

    with pytest.raises(LedgerError) as raised:
        ledger.verify_attachment_draft(prepared["draft"]["draft_id"], observation)

    assert raised.value.code == "OUTBOUND_ATTACHMENT_REMOTE_PROOF_INVALID"


def test_attachment_remote_confirmation_rejects_future_reference(tmp_path: Path) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    _sender(ledger, FakeBackend(), FakeDatabaseVerifier(), tmp_path / "upload").execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )
    observation = dict(
        ledger.get_draft(prepared["draft"]["draft_id"])["result"][
            "local_attachment_observation"
        ]
    )
    observation["remote_confirmation"] = _remote_confirmation(
        prepared,
        payload,
        authorized_at="2999-01-01T00:00:00+00:00",
    )

    with pytest.raises(LedgerError) as raised:
        ledger.verify_attachment_draft(prepared["draft"]["draft_id"], observation)

    assert raised.value.code == "OUTBOUND_ATTACHMENT_REMOTE_PROOF_INVALID"


def test_attachment_remote_confirmation_requires_environment_restoration(tmp_path: Path) -> None:
    ledger, prepared, payload = _prepared(tmp_path)

    class IncompleteEnvironmentBackend(FakeBackend):
        @staticmethod
        def environment_observation() -> dict[str, Any]:
            return {
                "restore_skipped_user_interaction": False,
                "foreground_restored": False,
                "mouse_restored": True,
                "clipboard_semantics_restored": True,
            }

    _sender(
        ledger,
        IncompleteEnvironmentBackend(),
        FakeDatabaseVerifier(),
        tmp_path / "upload",
    ).execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )
    observation = dict(
        ledger.get_draft(prepared["draft"]["draft_id"])["result"][
            "local_attachment_observation"
        ]
    )
    observation["remote_confirmation"] = _remote_confirmation(prepared, payload)

    with pytest.raises(LedgerError) as raised:
        ledger.verify_attachment_draft(prepared["draft"]["draft_id"], observation)

    assert raised.value.code == "OUTBOUND_ATTACHMENT_ENVIRONMENT_UNVERIFIED"


def test_database_timeout_becomes_unknown_and_is_not_retried(tmp_path: Path) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    backend = FakeBackend()
    verifier = FakeDatabaseVerifier()
    verifier.failure = AttachmentDatabaseVerificationError("VERIFY_TIMEOUT", "synthetic")
    sender = _sender(ledger, backend, verifier, tmp_path / "upload")

    result = sender.execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )

    assert result.state is OutboundState.UNKNOWN
    assert result.error_code == "VERIFY_TIMEOUT"
    with pytest.raises(OutboundRefused) as raised:
        sender.execute(
            draft_id=prepared["draft"]["draft_id"],
            payload=payload,
            dedupe_key="dedupe-upload",
            lease_expires_at="2099-01-01T00:00:00+00:00",
            execution_id="execution-b",
        )
    assert raised.value.code == "DRAFT_NOT_APPROVED"


def test_unverified_draft_route_never_presses_send(tmp_path: Path) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    backend = FakeBackend()
    backend.focus = FocusState.UNKNOWN
    verifier = FakeDatabaseVerifier()

    result = _sender(ledger, backend, verifier, tmp_path / "upload").execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )

    assert result.state is OutboundState.FAILED
    assert "send" not in backend.calls
    assert verifier.calls == ["baseline"]


def test_changed_source_is_refused_before_ui(tmp_path: Path) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    Path(payload["local_path"]).write_text("changed", encoding="utf-8")
    backend = FakeBackend()

    with pytest.raises(OutboundRefused) as raised:
        _sender(ledger, backend, FakeDatabaseVerifier(), tmp_path / "upload").execute(
            draft_id=prepared["draft"]["draft_id"],
            payload=payload,
            dedupe_key="dedupe-upload",
            lease_expires_at="2099-01-01T00:00:00+00:00",
            execution_id="execution-a",
        )
    assert raised.value.code == "ATTACHMENT_SOURCE_CHANGED"
    assert backend.calls == []


def test_source_changed_during_navigation_is_refused_before_paste(tmp_path: Path) -> None:
    ledger, prepared, payload = _prepared(tmp_path)
    source = Path(payload["local_path"])

    class MutatingBackend(FakeBackend):
        def navigate_visible(self, window: object, route: object) -> None:
            super().navigate_visible(window, route)
            source.write_text("changed-during-navigation", encoding="utf-8")

    backend = MutatingBackend()
    result = _sender(
        ledger,
        backend,
        FakeDatabaseVerifier(),
        tmp_path / "upload",
    ).execute(
        draft_id=prepared["draft"]["draft_id"],
        payload=payload,
        dedupe_key="dedupe-upload",
        lease_expires_at="2099-01-01T00:00:00+00:00",
        execution_id="execution-a",
    )
    assert result.state is OutboundState.FAILED
    assert result.error_code == "ATTACHMENT_SOURCE_CHANGED"
    assert "write" not in backend.calls
    assert "send" not in backend.calls


def test_execute_payload_rejects_source_outside_upload_root(tmp_path: Path) -> None:
    ledger, _, payload = _prepared(tmp_path)
    outside = tmp_path / "outside" / "sample.txt"
    outside.parent.mkdir()
    outside.write_text("safe", encoding="utf-8")
    forged = {**payload, "local_path": str(outside)}
    sender = _sender(ledger, FakeBackend(), FakeDatabaseVerifier(), tmp_path / "upload")

    with pytest.raises(OutboundRefused) as raised:
        sender._validate_payload("wechat_file", forged)

    assert raised.value.code == "ATTACHMENT_UPLOAD_PATH_NOT_ALLOWED"


def test_execute_payload_recomputes_content_md5(tmp_path: Path) -> None:
    ledger, _, payload = _prepared(tmp_path)
    forged = {**payload, "content_md5": "0" * 32}
    sender = _sender(ledger, FakeBackend(), FakeDatabaseVerifier(), tmp_path / "upload")

    with pytest.raises(OutboundRefused) as raised:
        sender._validate_payload("wechat_file", forged)

    assert raised.value.code == "ATTACHMENT_SOURCE_CHANGED"


def test_clipboard_sequence_change_preserves_user_clipboard() -> None:
    class User32:
        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return 200

        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 1
            point._obj.y = 1
            return True

        @staticmethod
        def GetForegroundWindow() -> int:
            return 1

    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend._owned_clipboard_sequence = 100
    backend._user_interaction_detected = False
    backend._snapshot = object()
    backend._expected_mouse_position = (1, 1)
    restored: list[object] = []
    backend._replace_clipboard = restored.append
    backend._visible_wechat_window_count = lambda: 0
    snapshot = Win32EnvironmentSnapshot(
        1,
        (1, 1),
        (ClipboardFormat(CF_HDROP, b"test"),),
        50,
        None,
        False,
        False,
    )
    with pytest.raises(UiBackendError) as raised:
        backend.restore_environment(snapshot)
    assert raised.value.code == "ENV_RESTORE_SKIPPED_USER_INTERACTION"
    assert restored == []


def test_environment_restore_does_not_override_later_user_focus_or_mouse() -> None:
    setters: list[tuple[object, ...]] = []

    class User32:
        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return 50

        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 8
            point._obj.y = 9
            return True

        @staticmethod
        def GetForegroundWindow() -> int:
            return 777

        @staticmethod
        def SetCursorPos(*args: object) -> bool:
            setters.append(("mouse", *args))
            return True

        @staticmethod
        def SetForegroundWindow(*args: object) -> bool:
            setters.append(("foreground", *args))
            return True

        @staticmethod
        def IsWindow(_: object) -> bool:
            return True

    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend._owned_clipboard_sequence = None
    backend._user_interaction_detected = False
    backend._snapshot = object()
    backend._expected_mouse_position = (1, 1)
    backend._owned_wechat_window = 9001
    backend._visible_started_at = None
    backend._visible_duration_seconds = 0.5
    backend._hidden_text_phase = False
    backend._environment_observation = {"restore_skipped_user_interaction": False}
    backend._visible_wechat_window_count = lambda: 1
    snapshot = Win32EnvironmentSnapshot(1, (1, 1), (), 50, None, False, False)

    with pytest.raises(UiBackendError) as raised:
        backend.restore_environment(snapshot)

    assert raised.value.code == "ENV_RESTORE_SKIPPED_USER_INTERACTION"
    assert setters == []
    observation = backend.environment_observation()
    assert observation["restore_skipped_user_interaction"] is True
    assert observation["foreground_unchanged_before_restore"] is False
    assert observation["mouse_unchanged_before_restore"] is False


def test_locate_window_counts_visibility_from_first_restore(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = {"now": 100.0}

    class User32:
        @staticmethod
        def ShowWindow(*_: object) -> bool:
            return True

        @staticmethod
        def SetForegroundWindow(*_: object) -> bool:
            return True

        @staticmethod
        def GetForegroundWindow() -> int:
            return 9001

    monkeypatch.setattr(win32_attachment_ui.time, "monotonic", lambda: clock["now"])
    monkeypatch.setattr(
        win32_attachment_ui.time,
        "sleep",
        lambda seconds: clock.__setitem__("now", clock["now"] + seconds),
    )
    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend._find_window = lambda *, required: 9001
    backend._guard_pre_ui_takeover = lambda _: None
    backend._displayed_wechat_window = None
    backend._owned_wechat_window = None
    backend._visible_started_at = None
    backend._visible_duration_seconds = 0.0
    backend._environment_observation = {}

    assert backend.locate_window() == 9001
    assert backend.environment_observation()["wechat_visible_duration_ms"] == 1000


def test_wake_counts_visibility_that_begins_before_locate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = {"now": 100.0}

    class User32:
        @staticmethod
        def IsWindow(_: object) -> bool:
            return True

        @staticmethod
        def IsWindowVisible(_: object) -> bool:
            return clock["now"] >= 101.0

        @staticmethod
        def IsIconic(_: object) -> bool:
            return False

        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 1
            point._obj.y = 2
            return True

        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return 50

        @staticmethod
        def GetForegroundWindow() -> int:
            return 10

    monkeypatch.setattr(win32_attachment_ui.os, "startfile", lambda _: None)
    monkeypatch.setattr(win32_attachment_ui.time, "monotonic", lambda: clock["now"])
    monkeypatch.setattr(
        win32_attachment_ui.time,
        "sleep",
        lambda seconds: clock.__setitem__("now", clock["now"] + seconds),
    )
    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend._snapshot = Win32EnvironmentSnapshot(10, (1, 2), (), 50, 9001, False, False, 7)
    backend._last_input_tick = lambda: 7
    backend._user_interaction_detected = False
    backend._displayed_wechat_window = None
    backend._visible_started_at = None
    backend._visible_duration_seconds = 0.0
    backend._environment_observation = {}

    backend.wake()

    assert backend._displayed_wechat_window == 9001
    assert backend.environment_observation()["wechat_visible_duration_ms"] == 3000


def test_locate_window_refuses_input_that_arrived_during_wake() -> None:
    calls: list[tuple[str, object]] = []

    class User32:
        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 1
            point._obj.y = 2
            return True

        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return 50

        @staticmethod
        def GetForegroundWindow() -> int:
            return 9001

        @staticmethod
        def ShowWindow(window: object, state: object) -> bool:
            calls.append(("show", (window, state)))
            return True

        @staticmethod
        def SetForegroundWindow(window: object) -> bool:
            calls.append(("focus", window))
            return True

    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend._snapshot = Win32EnvironmentSnapshot(10, (1, 2), (), 50, 9001, False, False, 10)
    backend._find_window = lambda *, required: 9001
    backend._last_input_tick = lambda: 11
    backend._user_interaction_detected = False

    with pytest.raises(UiBackendError) as raised:
        backend.locate_window()

    assert raised.value.code == "USER_INTERACTION_DETECTED"
    assert calls == []


def test_focus_failure_restores_displayed_but_unowned_wechat_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actions: list[tuple[str, object]] = []

    class User32:
        foreground = 10

        @classmethod
        def ShowWindow(cls, window: object, state: object) -> bool:
            actions.append(("show", (window, state)))
            return True

        @classmethod
        def SetForegroundWindow(cls, window: object) -> bool:
            actions.append(("focus", window))
            return False

        @classmethod
        def GetForegroundWindow(cls) -> int:
            return cls.foreground

        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 1
            point._obj.y = 2
            return True

        @staticmethod
        def SetCursorPos(x: object, y: object) -> bool:
            actions.append(("mouse", (x, y)))
            return True

        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return 50

        @staticmethod
        def IsWindow(_: object) -> bool:
            return True

    monkeypatch.setattr(win32_attachment_ui.time, "sleep", lambda _: None)
    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend._snapshot = Win32EnvironmentSnapshot(10, (1, 2), (), 50, None, False, False, 7)
    backend._find_window = lambda *, required: 9001
    backend._guard_pre_ui_takeover = lambda _: None
    backend._expected_mouse_position = (1, 2)
    backend._owned_clipboard_sequence = None
    backend._user_interaction_detected = False
    backend._hidden_text_phase = False
    backend._hidden_foreground_window = None
    backend._displayed_wechat_window = None
    backend._owned_wechat_window = None
    backend._visible_started_at = None
    backend._visible_duration_seconds = 0.0
    backend._environment_observation = {"restore_skipped_user_interaction": False}
    backend._visible_wechat_window_count = lambda: 0

    with pytest.raises(UiBackendError) as raised:
        backend.locate_window()
    assert raised.value.code == "WECHAT_FOCUS_FAILED"

    backend.restore_environment(backend._snapshot)

    assert ("show", (9001, win32_attachment_ui.SW_HIDE)) in actions
    assert backend.environment_observation()["restore_skipped_user_interaction"] is False


def test_visible_window_count_excludes_minimized_wechat() -> None:
    class User32:
        iconic = True

        @staticmethod
        def EnumWindows(callback: object, _: object) -> None:
            callback(9001, 0)

        @staticmethod
        def IsWindowVisible(_: object) -> bool:
            return True

        @classmethod
        def IsIconic(cls, _: object) -> bool:
            return cls.iconic

    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend._wechat_pids = lambda: {42}
    backend._window_pid = lambda _: 42

    assert backend._visible_wechat_window_count() == 0
    User32.iconic = False
    assert backend._visible_wechat_window_count() == 1


def test_win32_input_layout_and_dropfiles_payload_are_native_safe(tmp_path: Path) -> None:
    assert ctypes.sizeof(INPUT) == 40
    source = tmp_path / "sample.txt"
    payload = Win32WechatAttachmentBackend._dropfiles(source)
    offset, x, y, non_client, wide = struct.unpack("<IiiII", payload[:20])
    assert (offset, x, y, non_client, wide) == (20, 0, 0, 0, 1)
    assert payload[20:].decode("utf-16-le").rstrip("\0") == str(source)


def test_win32_clipboard_handle_functions_use_pointer_sized_types() -> None:
    class NativeFunction:
        argtypes: list[object] | None = None
        restype: object | None = None

    class NativeLibrary:
        def __getattr__(self, name: str) -> NativeFunction:
            function = NativeFunction()
            setattr(self, name, function)
            return function

    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = NativeLibrary()
    backend.kernel32 = NativeLibrary()
    backend._configure_apis()

    assert backend.kernel32.GlobalUnlock.argtypes == [wintypes.HGLOBAL]
    assert backend.kernel32.GlobalUnlock.restype is wintypes.BOOL
    assert backend.kernel32.GlobalFree.argtypes == [wintypes.HGLOBAL]
    assert backend.kernel32.GlobalFree.restype is wintypes.HGLOBAL


def test_clipboard_snapshot_rejects_unsafe_format_before_reading_data() -> None:
    calls: list[object] = []

    class User32:
        def OpenClipboard(self, *_: object) -> bool:
            return True
        def EnumClipboardFormats(self, previous: int) -> int:
            return 2 if previous == 0 else 0
        def GetClipboardData(self, format_id: int) -> int:
            calls.append(("get", format_id))
            return 1
        def CloseClipboard(self) -> bool:
            calls.append("close")
            return True

    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()

    with pytest.raises(UiBackendError) as raised:
        backend._snapshot_clipboard()

    assert raised.value.code == "CLIPBOARD_FORMAT_UNSUPPORTED"
    assert calls == ["close"]


def test_clipboard_snapshot_copies_safe_global_memory_format() -> None:
    raw = ctypes.create_string_buffer("hello\0".encode("utf-16-le"))
    calls: list[object] = []

    class User32:
        def OpenClipboard(self, *_: object) -> bool:
            return True
        def EnumClipboardFormats(self, previous: int) -> int:
            return 13 if previous == 0 else 0
        def GetClipboardData(self, format_id: int) -> int:
            calls.append(("get", format_id))
            return 42
        def CloseClipboard(self) -> bool:
            calls.append("close")
            return True

    class Kernel32:
        @staticmethod
        def GlobalSize(_: object) -> int:
            return len(raw)
        @staticmethod
        def GlobalLock(_: object) -> int:
            return ctypes.addressof(raw)
        @staticmethod
        def GlobalUnlock(_: object) -> bool:
            return True

    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend.kernel32 = Kernel32()

    captured = backend._snapshot_clipboard()

    assert captured == (ClipboardFormat(13, bytes(raw)),)
    assert calls == [("get", 13), "close"]


def test_clipboard_restore_replays_snapshot_when_sequence_is_owned() -> None:
    class User32:
        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return 100

        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 1
            point._obj.y = 1
            return True

        @staticmethod
        def GetForegroundWindow() -> int:
            return 0

        @staticmethod
        def SetCursorPos(*_: object) -> bool:
            return True
        @staticmethod
        def IsWindow(_: object) -> bool:
            return False

    clipboard_formats = (ClipboardFormat(CF_HDROP, b"test"),)
    restored: list[tuple[ClipboardFormat, ...]] = []
    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend._owned_clipboard_sequence = 100
    backend._user_interaction_detected = False
    backend._snapshot = object()
    backend._expected_mouse_position = (1, 1)
    backend._replace_clipboard = restored.append
    backend._snapshot_clipboard = lambda: clipboard_formats
    backend._find_window = lambda *, required: None
    backend._visible_wechat_window_count = lambda: 0
    snapshot = Win32EnvironmentSnapshot(0, (1, 1), clipboard_formats, 50, None, False, False)

    backend.restore_environment(snapshot)

    assert restored == [clipboard_formats]


def test_locate_window_accepts_verified_foreground_when_win32_return_is_false(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class User32:
        @staticmethod
        def ShowWindow(*_: object) -> bool:
            return True

        @staticmethod
        def SetForegroundWindow(*_: object) -> bool:
            return False

        @staticmethod
        def GetForegroundWindow() -> int:
            return 9001

    monkeypatch.setattr(win32_attachment_ui.time, "sleep", lambda _: None)
    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend._find_window = lambda *, required: 9001
    backend._guard_pre_ui_takeover = lambda _: None

    assert backend.locate_window() == 9001


def test_locate_window_rejects_unverified_foreground(monkeypatch: pytest.MonkeyPatch) -> None:
    class User32:
        @staticmethod
        def ShowWindow(*_: object) -> bool:
            return True

        @staticmethod
        def SetForegroundWindow(*_: object) -> bool:
            return True

        @staticmethod
        def GetForegroundWindow() -> int:
            return 42

    monkeypatch.setattr(win32_attachment_ui.time, "sleep", lambda _: None)
    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend._find_window = lambda *, required: 9001
    backend._guard_pre_ui_takeover = lambda _: None

    with pytest.raises(UiBackendError) as raised:
        backend.locate_window()
    assert raised.value.code == "WECHAT_FOCUS_FAILED"


def test_text_snapshot_never_reads_or_copies_clipboard() -> None:
    class User32:
        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 12
            point._obj.y = 34
            return True

        @staticmethod
        def GetForegroundWindow() -> int:
            return 77

        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return 88

        @staticmethod
        def IsWindowVisible(_: object) -> bool:
            return False

        @staticmethod
        def IsIconic(_: object) -> bool:
            return False

    backend = object.__new__(Win32WechatTextBackend)
    backend.user32 = User32()
    backend._find_window = lambda *, required: None
    backend._visible_wechat_window_count = lambda: 0
    backend._last_input_tick = lambda: 99
    backend._snapshot_clipboard = lambda: pytest.fail("text sender must not read clipboard payloads")

    snapshot = backend.snapshot_environment()

    assert snapshot.foreground_window == 77
    assert snapshot.mouse_position == (12, 34)
    assert snapshot.clipboard_formats == ()
    assert snapshot.clipboard_sequence_number == 88
    assert snapshot.last_input_tick == 99
    assert backend._owned_clipboard_sequence is None


def test_snapshot_rejects_input_that_arrives_during_capture() -> None:
    class User32:
        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 12
            point._obj.y = 34
            return True

        @staticmethod
        def GetForegroundWindow() -> int:
            return 77

        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return 88

    ticks = iter([10, 11])
    backend = object.__new__(Win32WechatTextBackend)
    backend.user32 = User32()
    backend._snapshot = None
    backend._user_interaction_detected = False
    backend._find_window = lambda *, required: None
    backend._last_input_tick = lambda: next(ticks)

    with pytest.raises(UiBackendError) as raised:
        backend.snapshot_environment()

    assert raised.value.code == "ENV_SNAPSHOT_UNSTABLE"
    assert backend._snapshot is None


def test_text_draft_requires_database_proof_before_send(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(win32_attachment_ui.time, "sleep", lambda _: None)
    backend = object.__new__(Win32WechatTextBackend)
    backend._text_draft_handle = None
    calls: list[object] = []
    backend._guard = lambda window: int(window)
    backend._focus_input = lambda window: calls.append(("focus", window))
    backend._window_unicode_text = lambda window, text: calls.append(("write", window, text))
    backend._refresh = lambda: calls.append("refresh")
    backend._draft_rows = lambda username: [(1, "SYNTHETIC_TEXT".encode("utf-16-le"))]
    handle: dict[str, Any] = {"username": USERNAME, "proof_sha256": None}

    backend.write_owned_draft(9001, handle, "SYNTHETIC_TEXT")

    assert handle["proof_sha256"]
    assert handle["approved_text_sha256"] == hashlib.sha256(b"SYNTHETIC_TEXT").hexdigest()
    assert handle["text"] == "SYNTHETIC_TEXT"
    assert backend._text_draft_handle is handle
    assert calls == [("focus", 9001), ("write", 9001, "SYNTHETIC_TEXT"), "refresh"]


def test_text_window_message_writer_is_visible_guarded_and_bounded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(win32_attachment_ui.time, "sleep", lambda _: None)
    calls: list[tuple[int, int, int, int]] = []
    backend = object.__new__(Win32WechatTextBackend)
    backend._guard = lambda window: int(window)
    backend._send_window_message = lambda window, message, wparam, lparam: calls.append(
        (window, message, wparam, lparam)
    )

    backend._window_unicode_text(9001, "A猫")

    assert calls == [
        (9001, win32_attachment_ui.WM_CHAR, ord("A"), 1),
        (9001, win32_attachment_ui.WM_CHAR, ord("猫"), 1),
    ]
    with pytest.raises(UiBackendError) as raised:
        backend._window_unicode_text(9001, "x" * (win32_attachment_ui.VISIBLE_TEXT_CODE_UNIT_LIMIT + 1))
    assert raised.value.code == "TEXT_CAPABILITY_LIMIT"


def test_text_send_uses_bounded_window_enter(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(win32_attachment_ui.time, "sleep", lambda _: None)
    backend = object.__new__(Win32WechatTextBackend)
    handle: dict[str, Any] = {"username": USERNAME, "proof_sha256": "proof"}
    backend._text_draft_handle = handle
    backend._hidden_text_phase = False
    backend._guard = lambda window: int(window)
    calls: list[int] = []
    backend._window_enter = calls.append

    backend.send_owned_draft(9001, handle)

    assert calls == [9001]


def test_text_focus_proof_tolerates_database_metadata_changes() -> None:
    backend = object.__new__(Win32WechatTextBackend)
    text = "SYNTHETIC_TEXT"
    handle: dict[str, Any] = {
        "username": USERNAME,
        "proof_sha256": "old-row-hash",
        "text": text,
        "approved_text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }
    backend._text_draft_handle = handle
    backend._hidden_text_phase = False
    backend._guard = lambda window: int(window)
    backend._refresh = lambda: None
    backend._draft_rows = lambda username: [(1, b"changed-prefix" + text.encode("utf-8"))]

    assert backend.focus_state(9001, SimpleNamespace(username=USERNAME)) is FocusState.VERIFIED


def test_text_cleanup_uses_select_all_delete_and_database_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(win32_attachment_ui.time, "sleep", lambda _: None)
    backend = object.__new__(Win32WechatTextBackend)
    text = "SYNTHETIC_TEXT"
    handle: dict[str, Any] = {
        "username": USERNAME,
        "proof_sha256": "proof",
        "text": text,
        "approved_text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }
    backend._text_draft_handle = handle
    backend._hidden_text_phase = False
    calls: list[object] = []
    rows = [[(1, text.encode("utf-8"))], [(1, b"")]]
    backend._guard = lambda window: int(window)
    backend._focus_input = lambda window: calls.append(("focus", window))
    backend._hotkey = lambda window, modifier, key: calls.append(("hotkey", window, modifier, key))
    backend._press = lambda window, key: calls.append(("press", window, key))
    backend._refresh = lambda: calls.append("refresh")
    backend._draft_rows = lambda username: rows.pop(0) if len(rows) > 1 else rows[0]

    backend.clear_owned_draft(9001, handle)

    assert calls == [
        "refresh",
        ("focus", 9001),
        ("hotkey", 9001, win32_attachment_ui.VK_CONTROL, 0x41),
        ("press", 9001, win32_attachment_ui.VK_DELETE),
        "refresh",
    ]
    assert backend._text_draft_handle is None


def test_text_draft_polls_until_exact_route_row_appears(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(win32_attachment_ui.time, "sleep", lambda _: None)
    backend = object.__new__(Win32WechatTextBackend)
    backend._text_draft_handle = None
    backend.hide_text_after_navigation = False
    backend.draft_timeout_seconds = 1
    backend.database_poll_seconds = 0
    backend._guard = lambda window: int(window)
    backend._focus_input = lambda window: None
    backend._window_unicode_text = lambda window, text: None
    refreshes: list[str] = []
    backend._refresh = lambda: refreshes.append("refresh")
    rows = [[], [], [(1, b"SYNTHETIC_TEXT")]]
    backend._draft_rows = lambda username: rows.pop(0)
    handle: dict[str, Any] = {"username": USERNAME, "proof_sha256": None}

    backend.write_owned_draft(9001, handle, "SYNTHETIC_TEXT")

    assert len(refreshes) == 3
    assert handle["proof_sha256"]


def test_hidden_text_phase_detects_foreground_change() -> None:
    class User32:
        foreground = 77

        @staticmethod
        def IsWindow(_: object) -> bool:
            return True

        @staticmethod
        def IsWindowVisible(_: object) -> bool:
            return False

        @classmethod
        def GetForegroundWindow(cls) -> int:
            return cls.foreground

        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 10
            point._obj.y = 20
            return True

        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return 50

    backend = object.__new__(Win32WechatTextBackend)
    backend.user32 = User32()
    backend._hidden_text_phase = True
    backend._hidden_foreground_window = 77
    backend._hidden_last_input_tick = 10
    backend._hidden_clipboard_sequence = 50
    backend._last_input_tick = lambda: 10
    backend._expected_mouse_position = (10, 20)
    backend._user_interaction_detected = False

    assert backend._guard_text_phase(9001) == 9001
    User32.foreground = 88
    with pytest.raises(UiBackendError) as raised:
        backend._guard_text_phase(9001)
    assert raised.value.code == "USER_INTERACTION_DETECTED"


def test_hidden_text_phase_detects_keyboard_or_clipboard_change() -> None:
    state = {"last_input": 10, "clipboard": 50}

    class User32:
        @staticmethod
        def IsWindow(_: object) -> bool:
            return True

        @staticmethod
        def IsWindowVisible(_: object) -> bool:
            return False

        @staticmethod
        def GetForegroundWindow() -> int:
            return 77

        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 10
            point._obj.y = 20
            return True

        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return state["clipboard"]

    backend = object.__new__(Win32WechatTextBackend)
    backend.user32 = User32()
    backend._hidden_text_phase = True
    backend._hidden_foreground_window = 77
    backend._hidden_last_input_tick = 10
    backend._hidden_clipboard_sequence = 50
    backend._last_input_tick = lambda: state["last_input"]
    backend._expected_mouse_position = (10, 20)
    backend._user_interaction_detected = False

    state["last_input"] = 11
    with pytest.raises(UiBackendError) as input_error:
        backend._guard_text_phase(9001)
    assert input_error.value.code == "USER_INTERACTION_DETECTED"

    backend._user_interaction_detected = False
    state["last_input"] = 10
    state["clipboard"] = 51
    with pytest.raises(UiBackendError) as clipboard_error:
        backend._guard_text_phase(9001)
    assert clipboard_error.value.code == "USER_INTERACTION_DETECTED"


def test_hidden_text_phase_rejects_input_during_hide(monkeypatch: pytest.MonkeyPatch) -> None:
    state = {"last_input": 10, "clipboard": 50}

    class User32:
        @staticmethod
        def ShowWindow(*_: object) -> bool:
            return True

        @staticmethod
        def IsWindowVisible(_: object) -> bool:
            return False

        @staticmethod
        def GetForegroundWindow() -> int:
            return 77

        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return state["clipboard"]

    def advance_user_input(_: float) -> None:
        state["last_input"] = 11
        state["clipboard"] = 51

    monkeypatch.setattr(win32_attachment_ui.time, "sleep", advance_user_input)
    backend = object.__new__(Win32WechatTextBackend)
    backend.user32 = User32()
    backend._guard = lambda window: int(window)
    backend._last_input_tick = lambda: state["last_input"]
    backend._user_interaction_detected = False
    backend._hidden_text_phase = False
    backend._hidden_foreground_window = None
    backend._hidden_last_input_tick = None
    backend._hidden_clipboard_sequence = None
    backend._visible_started_at = None
    backend._visible_duration_seconds = 0.0

    with pytest.raises(UiBackendError) as raised:
        backend._enter_hidden_text_phase(9001)

    assert raised.value.code == "USER_INTERACTION_DETECTED"
    assert backend._hidden_last_input_tick == 10
    assert backend._hidden_clipboard_sequence == 50


def test_hidden_cleanup_focus_failure_is_rehidden_by_environment_restore(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actions: list[tuple[str, object]] = []

    class User32:
        visible = False

        @classmethod
        def ShowWindow(cls, window: object, state: object) -> bool:
            actions.append(("show", (window, state)))
            cls.visible = state not in {win32_attachment_ui.SW_HIDE, win32_attachment_ui.SW_MINIMIZE}
            return True

        @staticmethod
        def SetForegroundWindow(window: object) -> bool:
            actions.append(("focus", window))
            return False

        @staticmethod
        def GetForegroundWindow() -> int:
            return 10

        @classmethod
        def IsWindowVisible(cls, _: object) -> bool:
            return cls.visible

        @staticmethod
        def IsWindow(_: object) -> bool:
            return True

        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 1
            point._obj.y = 2
            return True

        @staticmethod
        def SetCursorPos(x: object, y: object) -> bool:
            actions.append(("mouse", (x, y)))
            return True

        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return 50

    monkeypatch.setattr(win32_attachment_ui.time, "sleep", lambda _: None)
    backend = object.__new__(Win32WechatTextBackend)
    backend.user32 = User32()
    snapshot = Win32EnvironmentSnapshot(10, (1, 2), (), 50, None, False, False, 7)
    backend._snapshot = snapshot
    backend._expected_mouse_position = (1, 2)
    backend._owned_clipboard_sequence = None
    backend._user_interaction_detected = False
    backend._hidden_text_phase = True
    backend._hidden_foreground_window = 10
    backend._hidden_last_input_tick = 7
    backend._hidden_clipboard_sequence = 50
    backend._last_input_tick = lambda: 7
    backend._displayed_wechat_window = None
    backend._owned_wechat_window = 9001
    backend._visible_started_at = None
    backend._visible_duration_seconds = 0.0
    backend._environment_observation = {"restore_skipped_user_interaction": False}
    backend._find_window = lambda *, required: 9001
    backend._visible_wechat_window_count = lambda: int(User32.visible)

    with pytest.raises(UiBackendError) as raised:
        backend._restore_visible_text_control(9001)
    assert raised.value.code == "WECHAT_FOCUS_FAILED"
    assert backend._hidden_text_phase is True
    assert User32.visible is True

    backend.restore_environment(snapshot)

    assert User32.visible is False
    assert ("show", (9001, win32_attachment_ui.SW_HIDE)) in actions
    assert backend.environment_observation()["restore_skipped_user_interaction"] is False


def test_hidden_cleanup_focus_failure_rehides_owned_window_after_user_switch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    actions: list[tuple[str, object]] = []
    state = {"foreground": 10, "visible": False}

    class User32:
        @staticmethod
        def ShowWindow(window: object, show_state: object) -> bool:
            actions.append(("show", (window, show_state)))
            state["visible"] = show_state not in {
                win32_attachment_ui.SW_HIDE,
                win32_attachment_ui.SW_MINIMIZE,
            }
            return True

        @staticmethod
        def SetForegroundWindow(window: object) -> bool:
            actions.append(("focus", window))
            return False

        @staticmethod
        def GetForegroundWindow() -> int:
            return state["foreground"]

        @staticmethod
        def IsWindowVisible(_: object) -> bool:
            return state["visible"]

        @staticmethod
        def IsWindow(_: object) -> bool:
            return True

        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 1
            point._obj.y = 2
            return True

        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return 50

    monkeypatch.setattr(win32_attachment_ui.time, "sleep", lambda _: None)
    backend = object.__new__(Win32WechatTextBackend)
    backend.user32 = User32()
    snapshot = Win32EnvironmentSnapshot(10, (1, 2), (), 50, None, False, False, 7)
    backend._snapshot = snapshot
    backend._expected_mouse_position = (1, 2)
    backend._owned_clipboard_sequence = None
    backend._user_interaction_detected = False
    backend._hidden_text_phase = True
    backend._hidden_foreground_window = 10
    backend._hidden_last_input_tick = 7
    backend._hidden_clipboard_sequence = 50
    backend._last_input_tick = lambda: 7
    backend._displayed_wechat_window = None
    backend._owned_wechat_window = 9001
    backend._visible_started_at = None
    backend._visible_duration_seconds = 0.0
    backend._environment_observation = {"restore_skipped_user_interaction": False}
    backend._find_window = lambda *, required: 9001
    backend._visible_wechat_window_count = lambda: int(state["visible"])

    with pytest.raises(UiBackendError) as focus_error:
        backend._restore_visible_text_control(9001)
    assert focus_error.value.code == "WECHAT_FOCUS_FAILED"
    state["foreground"] = 88

    with pytest.raises(UiBackendError) as restore_error:
        backend.restore_environment(snapshot)

    assert restore_error.value.code == "ENV_RESTORE_SKIPPED_USER_INTERACTION"
    assert state["visible"] is False
    assert ("show", (9001, win32_attachment_ui.SW_HIDE)) in actions
    assert backend.environment_observation()["wechat_window_unwound_after_user_interaction"] is True


def test_cf_hdrop_rechecks_owned_clipboard_before_paste(tmp_path: Path) -> None:
    class User32:
        @staticmethod
        def IsWindow(_: object) -> bool:
            return True

        @staticmethod
        def GetForegroundWindow() -> int:
            return 9001

        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 1
            point._obj.y = 2
            return True

        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return 101

    source = tmp_path / "sample.txt"
    source.write_text("safe", encoding="utf-8")
    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend.attachment_input_mode = "cf_hdrop"
    backend._expected_mouse_position = (1, 2)
    backend._owned_clipboard_sequence = None
    backend._user_interaction_detected = False
    backend._snapshot = Win32EnvironmentSnapshot(9001, (1, 2), (), 101, 9001, True, False, 10)
    backend._focus_input = lambda window: None
    backend._set_file_clipboard = lambda path: setattr(backend, "_owned_clipboard_sequence", 100)
    backend._send_inputs = lambda inputs: pytest.fail("changed clipboard must block paste")

    with pytest.raises(UiBackendError) as raised:
        backend.write_owned_attachment(
            9001,
            {"username": USERNAME},
            SimpleNamespace(username=USERNAME),
            source,
        )

    assert raised.value.code == "USER_INTERACTION_DETECTED"


def test_cf_hdrop_refuses_to_replace_clipboard_changed_since_snapshot(tmp_path: Path) -> None:
    class User32:
        @staticmethod
        def IsWindow(_: object) -> bool:
            return True

        @staticmethod
        def GetForegroundWindow() -> int:
            return 9001

        @staticmethod
        def GetCursorPos(point: object) -> bool:
            point._obj.x = 1
            point._obj.y = 2
            return True

        @staticmethod
        def GetClipboardSequenceNumber() -> int:
            return 60

    source = tmp_path / "sample.txt"
    source.write_text("safe", encoding="utf-8")
    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend.attachment_input_mode = "cf_hdrop"
    backend._snapshot = Win32EnvironmentSnapshot(9001, (1, 2), (), 50, 9001, True, False, 10)
    backend._expected_mouse_position = (1, 2)
    backend._owned_clipboard_sequence = None
    backend._user_interaction_detected = False
    backend._focus_input = lambda window: None
    backend._set_file_clipboard = lambda path: pytest.fail("changed clipboard must not be replaced")

    with pytest.raises(UiBackendError) as raised:
        backend.write_owned_attachment(
            9001,
            {"username": USERNAME},
            SimpleNamespace(username=USERNAME),
            source,
        )

    assert raised.value.code == "USER_INTERACTION_DETECTED"


def test_file_picker_path_does_not_replace_clipboard(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(win32_attachment_ui.time, "sleep", lambda _: None)

    class User32:
        @staticmethod
        def GetWindowRect(_: object, rectangle: object) -> bool:
            rectangle._obj.left = 0
            rectangle._obj.top = 0
            rectangle._obj.right = 1000
            rectangle._obj.bottom = 1000
            return True

        @staticmethod
        def SetCursorPos(*_: object) -> bool:
            return True

        @staticmethod
        def mouse_event(*_: object) -> None:
            return None

        @staticmethod
        def SetForegroundWindow(*_: object) -> bool:
            return True

        @staticmethod
        def IsWindow(_: object) -> bool:
            return True

    source = tmp_path / "sample.txt"
    source.write_text("safe", encoding="utf-8")
    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend._guard = lambda window: int(window)
    backend._expected_mouse_position = None
    dialog_results = [[100], []]
    backend._file_dialogs = lambda window: dialog_results.pop(0)
    backend._picker_controls = lambda dialog: (101, 102, 103)
    actions: list[object] = []
    backend._set_dialog_path = lambda edit, path: actions.append(("path", edit, path))
    backend._click_control = lambda control: actions.append(("click", control))
    backend._set_file_clipboard = lambda path: pytest.fail("file picker must not replace clipboard")

    backend._select_file_with_dialog(9001, source)

    assert actions == [("path", 101, source), ("click", 102)]


def test_file_picker_error_dialog_is_closed_before_refusal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(win32_attachment_ui.time, "sleep", lambda _: None)

    class User32:
        @staticmethod
        def GetWindowRect(_: object, rectangle: object) -> bool:
            rectangle._obj.left = 0
            rectangle._obj.top = 0
            rectangle._obj.right = 1000
            rectangle._obj.bottom = 1000
            return True

        @staticmethod
        def SetCursorPos(*_: object) -> bool:
            return True

        @staticmethod
        def mouse_event(*_: object) -> None:
            return None

        @staticmethod
        def SetForegroundWindow(*_: object) -> bool:
            return True

        @staticmethod
        def IsWindow(_: object) -> bool:
            return True

    source = tmp_path / "sample.txt"
    source.write_text("safe", encoding="utf-8")
    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend._guard = lambda window: int(window)
    backend._expected_mouse_position = None
    dialog_results = [[100], [100, 200]]
    backend._file_dialogs = lambda window: dialog_results.pop(0)
    backend._picker_controls = lambda dialog: (101, 102, 103) if dialog == 100 else None
    backend._set_dialog_path = lambda edit, path: None
    backend._dialog_control = (
        lambda dialog, class_name, title="": 201
        if dialog == 200 and class_name == "Button" and title == "确定"
        else None
    )
    clicked: list[int] = []
    backend._click_control = clicked.append

    with pytest.raises(UiBackendError) as raised:
        backend._select_file_with_dialog(9001, source)

    assert raised.value.code == "FILE_PICKER_REJECTED"
    assert clicked == [102, 201, 103]
