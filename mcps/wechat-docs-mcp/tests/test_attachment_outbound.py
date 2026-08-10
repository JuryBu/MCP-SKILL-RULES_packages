from __future__ import annotations

import hashlib
import ctypes
import struct
from ctypes import wintypes
from pathlib import Path
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
            "observed_at": "2099-01-01T00:00:01+00:00",
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


def _sender(
    ledger: EventLedger,
    backend: FakeBackend,
    verifier: FakeDatabaseVerifier,
    upload_root: Path,
):
    return SafeAttachmentOutbound(
        ledger,
        PrivateBindingRouteVerifier(_binding()),
        backend,
        verifier,
        upload_root,
    )


def test_attachment_send_is_verified_only_after_database_proof(tmp_path: Path) -> None:
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

    assert result.state is OutboundState.VERIFIED
    assert backend.calls[-1] == "restore"
    assert verifier.calls == ["baseline", "verify"]
    draft = ledger.get_draft(prepared["draft"]["draft_id"])
    assert draft["state"] == "VERIFIED"
    transfer = AttachmentRegistry(ledger, tmp_path / "intake", tmp_path / "upload").get(
        prepared["transfer"]["transfer_id"]
    )
    assert transfer["state"] == "VERIFIED"


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

    backend = object.__new__(Win32WechatAttachmentBackend)
    backend.user32 = User32()
    backend._owned_clipboard_sequence = 100
    backend._user_interaction_detected = False
    backend._snapshot = object()
    backend._expected_mouse_position = (1, 1)
    restored: list[object] = []
    backend._replace_clipboard = restored.append
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
    backend._find_window = lambda *, required: None
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
    backend._snapshot_clipboard = lambda: pytest.fail("text sender must not read clipboard payloads")

    snapshot = backend.snapshot_environment()

    assert snapshot.foreground_window == 77
    assert snapshot.mouse_position == (12, 34)
    assert snapshot.clipboard_formats == ()
    assert snapshot.clipboard_sequence_number == 88
    assert backend._owned_clipboard_sequence is None


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
    assert handle["text_sha256"] == hashlib.sha256(b"SYNTHETIC_TEXT").hexdigest()
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
    backend._guard = lambda window: int(window)
    calls: list[int] = []
    backend._window_enter = calls.append

    backend.send_owned_draft(9001, handle)

    assert calls == [9001]
