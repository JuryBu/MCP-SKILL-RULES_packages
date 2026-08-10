from __future__ import annotations

import csv
import ctypes
import hashlib
import os
import sqlite3
import struct
import subprocess
import time
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .outbound import FocusState, UiBackendError
from .route_verifier import VerifiedRoute


CF_HDROP = 15
CF_LOCALE = 16
CF_OEMTEXT = 7
CF_TEXT = 1
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
SW_HIDE = 0
SW_SHOWNORMAL = 1
SW_MINIMIZE = 6
SW_RESTORE = 9
VK_CONTROL = 0x11
VK_DELETE = 0x2E
VK_DOWN = 0x28
VK_F = 0x46
VK_RETURN = 0x0D
VK_UP = 0x26
VK_V = 0x56
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
SMTO_ABORTIFHUNG = 0x0002
WM_CHAR = 0x0102
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WINDOW_MESSAGE_TIMEOUT_MS = 1000
VISIBLE_TEXT_CODE_UNIT_LIMIT = 512
SAFE_CLIPBOARD_FORMATS = frozenset(
    {CF_TEXT, CF_OEMTEXT, CF_UNICODETEXT, CF_HDROP, CF_LOCALE}
)


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_void_p),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_void_p),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", INPUT_UNION)]


@dataclass(frozen=True)
class ClipboardFormat:
    format_id: int
    data: bytes


@dataclass(frozen=True)
class Win32EnvironmentSnapshot:
    foreground_window: int
    mouse_position: tuple[int, int]
    clipboard_formats: tuple[ClipboardFormat, ...]
    clipboard_sequence_number: int
    wechat_window: int | None
    wechat_visible: bool
    wechat_iconic: bool


class Win32WechatAttachmentBackend:
    def __init__(
        self,
        decrypted_dir: str | Path,
        refresh_decrypted: Callable[[], None],
        *,
        settle_seconds: float = 0.35,
    ) -> None:
        self.decrypted_dir = Path(decrypted_dir)
        self.refresh_decrypted = refresh_decrypted
        self.settle_seconds = settle_seconds
        self.user32 = ctypes.windll.user32
        self.kernel32 = ctypes.windll.kernel32
        self._snapshot: Win32EnvironmentSnapshot | None = None
        self._expected_mouse_position: tuple[int, int] | None = None
        self._owned_clipboard_sequence: int | None = None
        self._user_interaction_detected = False
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            pass
        self._configure_apis()

    def _configure_apis(self) -> None:
        self.user32.OpenClipboard.argtypes = [wintypes.HWND]
        self.user32.OpenClipboard.restype = wintypes.BOOL
        self.user32.GetClipboardData.argtypes = [wintypes.UINT]
        self.user32.GetClipboardData.restype = wintypes.HANDLE
        self.user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
        self.user32.SetClipboardData.restype = wintypes.HANDLE
        self.user32.EnumClipboardFormats.argtypes = [wintypes.UINT]
        self.user32.EnumClipboardFormats.restype = wintypes.UINT
        self.user32.SendMessageTimeoutW.argtypes = [
            wintypes.HWND,
            wintypes.UINT,
            wintypes.WPARAM,
            wintypes.LPARAM,
            wintypes.UINT,
            wintypes.UINT,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        self.user32.SendMessageTimeoutW.restype = wintypes.LPARAM
        self.user32.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
        self.user32.MapVirtualKeyW.restype = wintypes.UINT
        self.kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
        self.kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
        self.kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
        self.kernel32.GlobalLock.restype = ctypes.c_void_p
        self.kernel32.GlobalSize.argtypes = [wintypes.HGLOBAL]
        self.kernel32.GlobalSize.restype = ctypes.c_size_t
        self.kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
        self.kernel32.GlobalUnlock.restype = wintypes.BOOL
        self.kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
        self.kernel32.GlobalFree.restype = wintypes.HGLOBAL
        self.user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
        self.user32.SendInput.restype = wintypes.UINT
        self.user32.GetClipboardSequenceNumber.restype = wintypes.DWORD

    def _open_clipboard(self) -> None:
        for _ in range(20):
            if self.user32.OpenClipboard(None):
                return
            time.sleep(0.05)
        raise UiBackendError("CLIPBOARD_BUSY", "剪贴板被其它程序占用")

    def _snapshot_clipboard(self) -> tuple[ClipboardFormat, ...]:
        self._open_clipboard()
        try:
            format_ids: list[int] = []
            format_id = 0
            while True:
                format_id = int(self.user32.EnumClipboardFormats(format_id))
                if not format_id:
                    break
                format_ids.append(format_id)
            unsupported = sorted(set(format_ids) - SAFE_CLIPBOARD_FORMATS)
            if unsupported:
                raise UiBackendError(
                    "CLIPBOARD_FORMAT_UNSUPPORTED",
                    "剪贴板包含图片或复杂格式；为保证无损恢复，拒绝附件 UI 操作",
                )
            formats: list[ClipboardFormat] = []
            for current_format in format_ids:
                handle = self.user32.GetClipboardData(current_format)
                if not handle:
                    raise UiBackendError(
                        "CLIPBOARD_SNAPSHOT_FAILED",
                        "无法读取当前剪贴板格式",
                    )
                size = int(self.kernel32.GlobalSize(handle))
                if size <= 0:
                    raise UiBackendError(
                        "CLIPBOARD_SNAPSHOT_FAILED",
                        "当前剪贴板格式不是可安全复制的全局内存",
                    )
                pointer = self.kernel32.GlobalLock(handle)
                if not pointer:
                    raise UiBackendError(
                        "CLIPBOARD_SNAPSHOT_FAILED",
                        "无法锁定当前剪贴板内存",
                    )
                try:
                    formats.append(
                        ClipboardFormat(current_format, ctypes.string_at(pointer, size))
                    )
                finally:
                    self.kernel32.GlobalUnlock(handle)
            return tuple(formats)
        finally:
            self.user32.CloseClipboard()

    def _replace_clipboard(self, formats: tuple[ClipboardFormat, ...]) -> None:
        self._open_clipboard()
        try:
            if not self.user32.EmptyClipboard():
                raise UiBackendError("CLIPBOARD_CLEAR_FAILED", "无法清空剪贴板")
            for item in formats:
                handle = self.kernel32.GlobalAlloc(GMEM_MOVEABLE, max(1, len(item.data)))
                if not handle:
                    raise UiBackendError("CLIPBOARD_ALLOC_FAILED", "无法分配剪贴板内存")
                pointer = self.kernel32.GlobalLock(handle)
                if not pointer:
                    self.kernel32.GlobalFree(handle)
                    raise UiBackendError("CLIPBOARD_LOCK_FAILED", "无法写入剪贴板内存")
                try:
                    ctypes.memmove(pointer, item.data, len(item.data))
                finally:
                    self.kernel32.GlobalUnlock(handle)
                if not self.user32.SetClipboardData(item.format_id, handle):
                    self.kernel32.GlobalFree(handle)
                    raise UiBackendError("CLIPBOARD_RESTORE_FAILED", "剪贴板格式恢复失败")
        finally:
            self.user32.CloseClipboard()

    @staticmethod
    def _dropfiles(path: Path) -> bytes:
        encoded = (str(path) + "\0\0").encode("utf-16-le")
        return struct.pack("<IiiII", 20, 0, 0, 0, 1) + encoded

    def _set_file_clipboard(self, path: Path) -> None:
        self._replace_clipboard((ClipboardFormat(CF_HDROP, self._dropfiles(path)),))
        self._owned_clipboard_sequence = int(self.user32.GetClipboardSequenceNumber())

    @staticmethod
    def _wechat_pids() -> set[int]:
        result = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            check=True,
        )
        pids: set[int] = set()
        for row in csv.reader(result.stdout.splitlines()):
            if len(row) >= 2 and row[0].lower().startswith("weixin"):
                try:
                    pids.add(int(row[1]))
                except ValueError:
                    continue
        return pids

    def _find_window(self, *, required: bool) -> int | None:
        pids = self._wechat_pids()
        found: list[int] = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        @callback_type
        def callback(window: int, _: int) -> bool:
            pid = wintypes.DWORD()
            self.user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
            if int(pid.value) not in pids:
                return True
            title_length = self.user32.GetWindowTextLengthW(window)
            title_buffer = ctypes.create_unicode_buffer(title_length + 1)
            self.user32.GetWindowTextW(window, title_buffer, len(title_buffer))
            class_buffer = ctypes.create_unicode_buffer(256)
            self.user32.GetClassNameW(window, class_buffer, len(class_buffer))
            if title_buffer.value == "微信" and "QWindowIcon" in class_buffer.value:
                found.append(int(window))
            return True

        self.user32.EnumWindows(callback, 0)
        if len(found) == 1:
            return found[0]
        if required:
            code = "WECHAT_MAIN_WINDOW_NOT_FOUND" if not found else "WECHAT_MAIN_WINDOW_AMBIGUOUS"
            raise UiBackendError(code, "无法唯一定位微信主窗口")
        return None

    def snapshot_environment(self) -> Win32EnvironmentSnapshot:
        point = wintypes.POINT()
        if not self.user32.GetCursorPos(ctypes.byref(point)):
            raise UiBackendError("CURSOR_SNAPSHOT_FAILED", "无法读取鼠标位置")
        wechat_window = self._find_window(required=False)
        clipboard_formats = self._snapshot_clipboard()
        snapshot = Win32EnvironmentSnapshot(
            foreground_window=int(self.user32.GetForegroundWindow()),
            mouse_position=(int(point.x), int(point.y)),
            clipboard_formats=clipboard_formats,
            clipboard_sequence_number=int(self.user32.GetClipboardSequenceNumber()),
            wechat_window=wechat_window,
            wechat_visible=bool(wechat_window and self.user32.IsWindowVisible(wechat_window)),
            wechat_iconic=bool(wechat_window and self.user32.IsIconic(wechat_window)),
        )
        self._snapshot = snapshot
        self._expected_mouse_position = snapshot.mouse_position
        self._user_interaction_detected = False
        return snapshot

    def wake(self) -> None:
        os.startfile("weixin://")
        time.sleep(4)

    def locate_window(self) -> int:
        window = self._find_window(required=True)
        assert window is not None
        self.user32.ShowWindow(window, SW_RESTORE)
        self.user32.SetForegroundWindow(window)
        time.sleep(1)
        if int(self.user32.GetForegroundWindow()) != window:
            raise UiBackendError("WECHAT_FOCUS_FAILED", "无法把微信窗口置于前台")
        return window

    def _guard(self, window: object) -> int:
        if not isinstance(window, int) or not self.user32.IsWindow(window):
            raise UiBackendError("WECHAT_WINDOW_LOST", "微信窗口已失效")
        if int(self.user32.GetForegroundWindow()) != window:
            self._user_interaction_detected = True
            raise UiBackendError("USER_INTERACTION_DETECTED", "前台窗口已变化，停止自动操作")
        if self._expected_mouse_position is not None:
            point = wintypes.POINT()
            self.user32.GetCursorPos(ctypes.byref(point))
            if (int(point.x), int(point.y)) != self._expected_mouse_position:
                self._user_interaction_detected = True
                raise UiBackendError("USER_INTERACTION_DETECTED", "鼠标位置已变化，停止自动操作")
        return window

    def window_focus_state(self, window: object) -> FocusState:
        try:
            self._guard(window)
            return FocusState.VERIFIED
        except UiBackendError:
            return FocusState.UNKNOWN

    def _send_inputs(self, inputs: list[INPUT]) -> None:
        array = (INPUT * len(inputs))(*inputs)
        sent = self.user32.SendInput(len(array), array, ctypes.sizeof(INPUT))
        if sent != len(array):
            raise UiBackendError("KEYBOARD_INPUT_FAILED", "Windows 未接受全部键盘输入")
        time.sleep(self.settle_seconds)

    @staticmethod
    def _virtual_key(value: int, *, key_up: bool = False) -> INPUT:
        return INPUT(
            type=1,
            ki=KEYBDINPUT(value, 0, KEYEVENTF_KEYUP if key_up else 0, 0, None),
        )

    def _press(self, window: int, value: int) -> None:
        self._guard(window)
        self._send_inputs([self._virtual_key(value), self._virtual_key(value, key_up=True)])

    def _hotkey(self, window: int, modifier: int, value: int) -> None:
        self._guard(window)
        self._send_inputs(
            [
                self._virtual_key(modifier),
                self._virtual_key(value),
                self._virtual_key(value, key_up=True),
                self._virtual_key(modifier, key_up=True),
            ]
        )

    def _unicode_text(self, window: int, text: str) -> None:
        self._guard(window)
        inputs: list[INPUT] = []
        encoded = text.encode("utf-16-le")
        for index in range(0, len(encoded), 2):
            unit = int.from_bytes(encoded[index : index + 2], "little")
            inputs.extend(
                [
                    INPUT(type=1, ki=KEYBDINPUT(0, unit, KEYEVENTF_UNICODE, 0, None)),
                    INPUT(
                        type=1,
                        ki=KEYBDINPUT(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, None),
                    ),
                ]
            )
        self._send_inputs(inputs)

    def _focus_input(self, window: int) -> None:
        self._guard(window)
        rectangle = wintypes.RECT()
        if not self.user32.GetWindowRect(window, ctypes.byref(rectangle)):
            raise UiBackendError("WECHAT_WINDOW_RECT_FAILED", "无法读取微信窗口位置")
        width = rectangle.right - rectangle.left
        height = rectangle.bottom - rectangle.top
        if width < 400 or height < 300:
            raise UiBackendError("WECHAT_WINDOW_GEOMETRY_INVALID", "微信窗口尺寸异常")
        point = (rectangle.left + int(width * 0.60), rectangle.bottom - int(height * 0.08))
        if not self.user32.SetCursorPos(*point):
            raise UiBackendError("WECHAT_INPUT_FOCUS_FAILED", "无法定位微信输入区")
        self._expected_mouse_position = point
        self.user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        self.user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        time.sleep(0.5)
        self._guard(window)

    def _refresh(self) -> None:
        try:
            self.refresh_decrypted()
        except Exception as error:
            raise UiBackendError("WECHAT_DATABASE_REFRESH_FAILED", "无法刷新微信草稿数据库") from error

    def _route_title_unique(self, route: VerifiedRoute) -> bool:
        database = self.decrypted_dir / "contact" / "contact.db"
        connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
        try:
            exact = connection.execute(
                """
                SELECT contact.nick_name,contact.remark
                FROM name2id JOIN contact ON contact.id=name2id.rowid
                WHERE name2id.username=?
                """,
                (route.username,),
            ).fetchall()
            duplicates = connection.execute(
                "SELECT COUNT(*) FROM contact WHERE nick_name=? OR remark=?",
                (route.display_title, route.display_title),
            ).fetchone()[0]
        finally:
            connection.close()
        return len(exact) == 1 and route.display_title in {exact[0][0], exact[0][1]} and duplicates == 1

    def navigate_visible(self, window: object, route: VerifiedRoute) -> None:
        active_window = self._guard(window)
        self._refresh()
        if not self._route_title_unique(route):
            raise UiBackendError("WECHAT_SEARCH_TARGET_AMBIGUOUS", "目标显示名无法在本地联系人库唯一确认")
        self._hotkey(active_window, VK_CONTROL, VK_F)
        self._unicode_text(active_window, route.display_title)
        time.sleep(2)
        self._press(active_window, VK_DOWN)
        self._press(active_window, VK_UP)
        self._press(active_window, VK_RETURN)
        time.sleep(1.5)
        self._guard(active_window)

    def _draft_rows(self, username: str) -> list[tuple[Any, Any]]:
        database = self.decrypted_dir / "session" / "session.db"
        connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
        try:
            return connection.execute(
                "SELECT window_id,draft_data FROM SessionDraft WHERE username=?",
                (username,),
            ).fetchall()
        finally:
            connection.close()

    def claim_empty_draft(self, window: object, route: VerifiedRoute) -> dict[str, Any]:
        self._guard(window)
        self._refresh()
        rows = self._draft_rows(route.username)
        if any(row[1] not in (None, b"", "") for row in rows):
            raise UiBackendError("WECHAT_EXISTING_DRAFT", "目标会话已有草稿，拒绝覆盖")
        return {"username": route.username, "proof_sha256": None, "file_name": None}

    @staticmethod
    def _draft_bytes(value: Any) -> bytes:
        if value is None:
            return b""
        if isinstance(value, bytes):
            return value
        return str(value).encode("utf-8")

    @staticmethod
    def _contains_file_name(data: bytes, file_name: str) -> bool:
        return any(
            encoded in data
            for encoded in (
                file_name.encode("utf-8"),
                file_name.encode("utf-16-le"),
                file_name.encode("utf-16-be"),
            )
        )

    def write_owned_attachment(
        self,
        window: object,
        draft_handle: object,
        route: VerifiedRoute,
        path: Path,
    ) -> None:
        active_window = self._guard(window)
        if not isinstance(draft_handle, dict) or draft_handle.get("username") != route.username:
            raise UiBackendError("ATTACHMENT_DRAFT_HANDLE_INVALID", "附件草稿句柄无效")
        self._focus_input(active_window)
        self._set_file_clipboard(path)
        self._hotkey(active_window, VK_CONTROL, VK_V)
        time.sleep(2)
        self._refresh()
        rows = self._draft_rows(route.username)
        if len(rows) != 1:
            raise UiBackendError("ATTACHMENT_DRAFT_ROUTE_UNVERIFIED", "微信草稿表未唯一指向目标 route")
        data = self._draft_bytes(rows[0][1])
        if not data or not self._contains_file_name(data, path.name):
            raise UiBackendError("ATTACHMENT_DRAFT_CONTENT_UNVERIFIED", "微信草稿表未包含目标附件名称")
        draft_handle["proof_sha256"] = hashlib.sha256(data).hexdigest()
        draft_handle["file_name"] = path.name

    def focus_state(
        self,
        window: object,
        draft_handle: object,
        route: VerifiedRoute,
    ) -> FocusState:
        try:
            self._guard(window)
            if not isinstance(draft_handle, dict) or draft_handle.get("username") != route.username:
                return FocusState.UNKNOWN
            proof = draft_handle.get("proof_sha256")
            if not isinstance(proof, str) or not proof:
                return FocusState.UNKNOWN
            self._refresh()
            rows = self._draft_rows(route.username)
            if len(rows) != 1:
                return FocusState.UNKNOWN
            data = self._draft_bytes(rows[0][1])
            return (
                FocusState.VERIFIED
                if hashlib.sha256(data).hexdigest() == proof
                else FocusState.MISMATCH
            )
        except Exception:
            return FocusState.UNKNOWN

    def send_owned_attachment(self, window: object, draft_handle: object) -> None:
        active_window = self._guard(window)
        if not isinstance(draft_handle, dict) or not draft_handle.get("proof_sha256"):
            raise UiBackendError("ATTACHMENT_DRAFT_HANDLE_INVALID", "附件草稿未获得 route 证明")
        try:
            self._press(active_window, VK_RETURN)
        except Exception as error:
            raise UiBackendError(
                "ATTACHMENT_SEND_OUTCOME_UNKNOWN",
                "发送按键执行结果未知",
                send_may_have_occurred=True,
            ) from error
        time.sleep(1)

    def clear_owned_attachment(self, window: object, draft_handle: object) -> None:
        active_window = self._guard(window)
        self._hotkey(active_window, VK_CONTROL, 0x41)
        self._press(active_window, VK_DELETE)
        time.sleep(0.5)
        self._refresh()
        username = draft_handle.get("username") if isinstance(draft_handle, dict) else None
        if not isinstance(username, str):
            raise UiBackendError("ATTACHMENT_DRAFT_HANDLE_INVALID", "附件草稿句柄无效")
        if any(row[1] not in (None, b"", "") for row in self._draft_rows(username)):
            raise UiBackendError("ATTACHMENT_DRAFT_CLEANUP_FAILED", "附件草稿未被清理")

    def restore_environment(self, snapshot: object) -> None:
        if not isinstance(snapshot, Win32EnvironmentSnapshot):
            raise UiBackendError("ENV_SNAPSHOT_INVALID", "环境快照类型无效")
        errors: list[Exception] = []
        clipboard_sequence = int(self.user32.GetClipboardSequenceNumber())
        if self._owned_clipboard_sequence is not None:
            if clipboard_sequence == self._owned_clipboard_sequence:
                try:
                    self._replace_clipboard(snapshot.clipboard_formats)
                except Exception as error:
                    errors.append(error)
            else:
                self._user_interaction_detected = True
        if self._user_interaction_detected:
            self._snapshot = None
            self._expected_mouse_position = None
            self._owned_clipboard_sequence = None
            raise UiBackendError(
                "ENV_RESTORE_SKIPPED_USER_INTERACTION",
                "检测到用户操作；未覆盖用户的新剪贴板，也未改变当前窗口和鼠标",
            )
        current = self._find_window(required=False)
        if current is not None:
            try:
                if snapshot.wechat_window is None or not snapshot.wechat_visible:
                    self.user32.ShowWindow(current, SW_HIDE)
                elif snapshot.wechat_iconic:
                    self.user32.ShowWindow(current, SW_MINIMIZE)
                else:
                    self.user32.ShowWindow(current, SW_SHOWNORMAL)
            except Exception as error:
                errors.append(error)
        try:
            self.user32.SetCursorPos(*snapshot.mouse_position)
            if snapshot.foreground_window and self.user32.IsWindow(snapshot.foreground_window):
                self.user32.SetForegroundWindow(snapshot.foreground_window)
        except Exception as error:
            errors.append(error)
        self._snapshot = None
        self._expected_mouse_position = None
        self._owned_clipboard_sequence = None
        if errors:
            raise UiBackendError("ENV_RESTORE_FAILED", "无法完整恢复剪贴板、窗口或焦点")


class Win32WechatTextBackend(Win32WechatAttachmentBackend):
    def _send_window_message(self, window: int, message: int, wparam: int, lparam: int) -> None:
        self._guard(window)
        result = ctypes.c_size_t()
        delivered = self.user32.SendMessageTimeoutW(
            window,
            message,
            wparam,
            lparam,
            SMTO_ABORTIFHUNG,
            WINDOW_MESSAGE_TIMEOUT_MS,
            ctypes.byref(result),
        )
        if not delivered:
            raise UiBackendError("WECHAT_WINDOW_MESSAGE_TIMEOUT", "微信窗口消息没有在时限内完成")

    def _window_unicode_text(self, window: int, text: str) -> None:
        encoded = text.encode("utf-16-le")
        code_units = [
            int.from_bytes(encoded[index : index + 2], "little")
            for index in range(0, len(encoded), 2)
        ]
        if len(code_units) > VISIBLE_TEXT_CODE_UNIT_LIMIT:
            raise UiBackendError("TEXT_CAPABILITY_LIMIT", "当前可见文字后端不接受超过 512 个 UTF-16 单元的正文")
        for unit in code_units:
            self._send_window_message(window, WM_CHAR, unit, 1)
            time.sleep(0.2)

    def _window_enter(self, window: int) -> None:
        scan = int(self.user32.MapVirtualKeyW(VK_RETURN, 0))
        lparam_down = (scan << 16) | 1
        self._send_window_message(window, WM_KEYDOWN, VK_RETURN, lparam_down)
        self._send_window_message(window, WM_KEYUP, VK_RETURN, lparam_down | 0xC0000000)

    def snapshot_environment(self) -> Win32EnvironmentSnapshot:
        point = wintypes.POINT()
        if not self.user32.GetCursorPos(ctypes.byref(point)):
            raise UiBackendError("CURSOR_SNAPSHOT_FAILED", "无法读取鼠标位置")
        wechat_window = self._find_window(required=False)
        snapshot = Win32EnvironmentSnapshot(
            foreground_window=int(self.user32.GetForegroundWindow()),
            mouse_position=(int(point.x), int(point.y)),
            clipboard_formats=(),
            clipboard_sequence_number=int(self.user32.GetClipboardSequenceNumber()),
            wechat_window=wechat_window,
            wechat_visible=bool(wechat_window and self.user32.IsWindowVisible(wechat_window)),
            wechat_iconic=bool(wechat_window and self.user32.IsIconic(wechat_window)),
        )
        self._snapshot = snapshot
        self._expected_mouse_position = snapshot.mouse_position
        self._owned_clipboard_sequence = None
        self._user_interaction_detected = False
        return snapshot

    @staticmethod
    def _contains_text(data: bytes, text: str) -> bool:
        return any(
            encoded in data
            for encoded in (
                text.encode("utf-8"),
                text.encode("utf-16-le"),
                text.encode("utf-16-be"),
            )
        )

    def write_owned_draft(self, window: object, draft_handle: object, text: str) -> None:
        active_window = self._guard(window)
        if not isinstance(draft_handle, dict) or not isinstance(draft_handle.get("username"), str):
            raise UiBackendError("TEXT_DRAFT_HANDLE_INVALID", "文字草稿句柄无效")
        self._focus_input(active_window)
        self._window_unicode_text(active_window, text)
        time.sleep(1)
        self._refresh()
        rows = self._draft_rows(draft_handle["username"])
        if len(rows) != 1:
            raise UiBackendError("TEXT_DRAFT_ROUTE_UNVERIFIED", "微信草稿表未唯一指向目标 route")
        data = self._draft_bytes(rows[0][1])
        if not data or not self._contains_text(data, text):
            raise UiBackendError("TEXT_DRAFT_CONTENT_UNVERIFIED", "微信草稿表未包含批准正文")
        draft_handle["proof_sha256"] = hashlib.sha256(data).hexdigest()
        draft_handle["text_sha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
        self._text_draft_handle = draft_handle

    def focus_state(self, window: object, route: VerifiedRoute) -> FocusState:
        try:
            self._guard(window)
            handle = getattr(self, "_text_draft_handle", None)
            if handle is None:
                rows = self._draft_rows(route.username)
                return (
                    FocusState.VERIFIED
                    if not rows or all(row[1] in (None, b"", "") for row in rows)
                    else FocusState.MISMATCH
                )
            if not isinstance(handle, dict) or handle.get("username") != route.username:
                return FocusState.UNKNOWN
            proof = handle.get("proof_sha256")
            if not isinstance(proof, str) or not proof:
                return FocusState.UNKNOWN
            self._refresh()
            rows = self._draft_rows(route.username)
            if len(rows) != 1:
                return FocusState.UNKNOWN
            data = self._draft_bytes(rows[0][1])
            return FocusState.VERIFIED if hashlib.sha256(data).hexdigest() == proof else FocusState.MISMATCH
        except Exception:
            return FocusState.UNKNOWN

    def send_owned_draft(self, window: object, draft_handle: object) -> None:
        active_window = self._guard(window)
        if draft_handle is not getattr(self, "_text_draft_handle", None):
            raise UiBackendError("TEXT_DRAFT_HANDLE_INVALID", "文字草稿未获得 route 证明")
        try:
            self._window_enter(active_window)
        except Exception as error:
            raise UiBackendError(
                "TEXT_SEND_OUTCOME_UNKNOWN",
                "发送按键执行结果未知",
                send_may_have_occurred=True,
            ) from error
        time.sleep(1)

    def clear_owned_draft(self, window: object, draft_handle: object) -> None:
        active_window = self._guard(window)
        if draft_handle is not getattr(self, "_text_draft_handle", None):
            raise UiBackendError("TEXT_DRAFT_HANDLE_INVALID", "文字草稿句柄无效")
        self._hotkey(active_window, VK_CONTROL, 0x41)
        self._press(active_window, VK_DELETE)
        time.sleep(0.5)
        self._refresh()
        username = draft_handle.get("username")
        if any(row[1] not in (None, b"", "") for row in self._draft_rows(username)):
            raise UiBackendError("TEXT_DRAFT_CLEANUP_FAILED", "文字草稿未被清理")
        self._text_draft_handle = None
