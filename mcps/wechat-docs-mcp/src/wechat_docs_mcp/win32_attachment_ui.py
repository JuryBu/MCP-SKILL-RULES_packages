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
BM_CLICK = 0x00F5
GMEM_MOVEABLE = 0x0002
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
SW_HIDE = 0
SW_SHOWNORMAL = 1
SW_MINIMIZE = 6
SW_RESTORE = 9
VK_CONTROL = 0x11
VK_END = 0x23
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
WM_SETTEXT = 0x000C
WINDOW_MESSAGE_TIMEOUT_MS = 1000
VISIBLE_TEXT_CODE_UNIT_LIMIT = 512
DEFAULT_DRAFT_TIMEOUT_SECONDS = 60.0
DEFAULT_CLEANUP_TIMEOUT_SECONDS = 30.0
DEFAULT_DATABASE_POLL_SECONDS = 2.0
FILE_DIALOG_TIMEOUT_SECONDS = 10.0
FOREGROUND_RESTORE_POLL_ATTEMPTS = 20
FOREGROUND_RESTORE_POLL_SECONDS = 0.05
FOREGROUND_RESTORE_STABLE_SAMPLES = 2
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
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


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


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
    last_input_tick: int = 0


class Win32WechatAttachmentBackend:
    def __init__(
        self,
        decrypted_dir: str | Path,
        refresh_decrypted: Callable[[], None],
        *,
        settle_seconds: float = 0.35,
        attachment_input_mode: str = "file_picker",
        draft_timeout_seconds: float = DEFAULT_DRAFT_TIMEOUT_SECONDS,
        cleanup_timeout_seconds: float = DEFAULT_CLEANUP_TIMEOUT_SECONDS,
        database_poll_seconds: float = DEFAULT_DATABASE_POLL_SECONDS,
        hide_text_after_navigation: bool = True,
    ) -> None:
        self.decrypted_dir = Path(decrypted_dir)
        self.refresh_decrypted = refresh_decrypted
        self.settle_seconds = settle_seconds
        if attachment_input_mode not in {"file_picker", "cf_hdrop"}:
            raise ValueError("attachment_input_mode must be file_picker or cf_hdrop")
        self.attachment_input_mode = attachment_input_mode
        self.draft_timeout_seconds = draft_timeout_seconds
        self.cleanup_timeout_seconds = cleanup_timeout_seconds
        self.database_poll_seconds = database_poll_seconds
        self.hide_text_after_navigation = hide_text_after_navigation
        self.user32 = ctypes.windll.user32
        self.kernel32 = ctypes.windll.kernel32
        self._snapshot: Win32EnvironmentSnapshot | None = None
        self._expected_mouse_position: tuple[int, int] | None = None
        self._owned_clipboard_sequence: int | None = None
        self._user_interaction_detected = False
        self._hidden_text_phase = False
        self._hidden_foreground_window: int | None = None
        self._hidden_last_input_tick: int | None = None
        self._hidden_clipboard_sequence: int | None = None
        self._displayed_wechat_window: int | None = None
        self._owned_wechat_window: int | None = None
        self._visible_started_at: float | None = None
        self._visible_duration_seconds = 0.0
        self._environment_observation: dict[str, Any] = {}
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
        self.user32.GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
        self.user32.GetLastInputInfo.restype = wintypes.BOOL

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
        return struct.pack("<IIIII", 20, 0, 0, 0, 1) + encoded

    def _set_file_clipboard(self, path: Path) -> None:
        if not path.is_file():
            raise UiBackendError("ATTACHMENT_SOURCE_MISSING", "附件来源文件不存在")
        if path.stat().st_size > MAX_ATTACHMENT_BYTES:
            raise UiBackendError("ATTACHMENT_SOURCE_TOO_LARGE", "附件超过当前单文件大小限制")
        self._replace_clipboard((ClipboardFormat(CF_HDROP, self._dropfiles(path)),))
        self._owned_clipboard_sequence = int(self.user32.GetClipboardSequenceNumber())

    def _guard_snapshot_clipboard_unchanged(self) -> None:
        snapshot = getattr(self, "_snapshot", None)
        if not isinstance(snapshot, Win32EnvironmentSnapshot):
            raise UiBackendError("ENV_SNAPSHOT_MISSING", "附件剪贴板操作缺少环境快照")
        if int(self.user32.GetClipboardSequenceNumber()) != snapshot.clipboard_sequence_number:
            self._user_interaction_detected = True
            raise UiBackendError("USER_INTERACTION_DETECTED", "附件写入前剪贴板已发生变化")

    def _window_class(self, window: int) -> str:
        buffer = ctypes.create_unicode_buffer(256)
        self.user32.GetClassNameW(window, buffer, len(buffer))
        return buffer.value

    def _window_title(self, window: int) -> str:
        length = int(self.user32.GetWindowTextLengthW(window))
        buffer = ctypes.create_unicode_buffer(length + 1)
        self.user32.GetWindowTextW(window, buffer, len(buffer))
        return buffer.value

    def _window_pid(self, window: int) -> int:
        pid = wintypes.DWORD()
        self.user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
        return int(pid.value)

    def _descendants(self, window: int) -> list[int]:
        found: list[int] = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        @callback_type
        def callback(child: int, _: int) -> bool:
            found.append(int(child))
            return True

        self.user32.EnumChildWindows(window, callback, 0)
        return found

    def _file_dialogs(self, window: int) -> list[int]:
        target_pid = self._window_pid(window)
        found: set[int] = set()
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        @callback_type
        def callback(candidate: int, _: int) -> bool:
            handle = int(candidate)
            if (
                self._window_class(handle) == "#32770"
                and self.user32.IsWindowVisible(handle)
                and self._window_pid(handle) == target_pid
            ):
                found.add(handle)
            return True

        self.user32.EnumWindows(callback, 0)
        self.user32.EnumChildWindows(window, callback, 0)
        return sorted(found)

    def _dialog_control(
        self,
        dialog: int,
        class_name: str,
        title_fragment: str = "",
    ) -> int | None:
        matches = [
            child
            for child in self._descendants(dialog)
            if self._window_class(child) == class_name
            and self.user32.IsWindowVisible(child)
            and (not title_fragment or title_fragment in self._window_title(child))
        ]
        return matches[0] if len(matches) == 1 else None

    def _click_control(self, control: int) -> None:
        rectangle = wintypes.RECT()
        if not self.user32.GetWindowRect(control, ctypes.byref(rectangle)):
            raise UiBackendError("FILE_PICKER_CONTROL_INVALID", "无法读取文件选择器控件位置")
        point = ((rectangle.left + rectangle.right) // 2, (rectangle.top + rectangle.bottom) // 2)
        if not self.user32.SetCursorPos(*point):
            raise UiBackendError("FILE_PICKER_CONTROL_INVALID", "无法定位文件选择器控件")
        self._expected_mouse_position = point
        result = ctypes.c_size_t()
        delivered = self.user32.SendMessageTimeoutW(
            control,
            BM_CLICK,
            0,
            0,
            SMTO_ABORTIFHUNG,
            WINDOW_MESSAGE_TIMEOUT_MS,
            ctypes.byref(result),
        )
        if not delivered:
            raise UiBackendError("FILE_PICKER_CONTROL_TIMEOUT", "文件选择器控件未响应")

    def _set_dialog_path(self, edit: int, path: Path) -> None:
        buffer = ctypes.create_unicode_buffer(str(path))
        result = ctypes.c_size_t()
        delivered = self.user32.SendMessageTimeoutW(
            edit,
            WM_SETTEXT,
            0,
            ctypes.cast(buffer, ctypes.c_void_p).value,
            SMTO_ABORTIFHUNG,
            WINDOW_MESSAGE_TIMEOUT_MS,
            ctypes.byref(result),
        )
        if not delivered or self._window_title(edit) != str(path):
            raise UiBackendError("FILE_PICKER_PATH_REJECTED", "文件选择器未接受目标路径")

    def _picker_controls(self, dialog: int) -> tuple[int, int, int] | None:
        edit = self._dialog_control(dialog, "Edit")
        open_button = self._dialog_control(dialog, "Button", "打开")
        cancel_button = self._dialog_control(dialog, "Button", "取消")
        if edit is None or open_button is None or cancel_button is None:
            return None
        return edit, open_button, cancel_button

    def _select_file_with_dialog(self, window: int, path: Path) -> None:
        if not path.is_file():
            raise UiBackendError("ATTACHMENT_SOURCE_MISSING", "附件来源文件不存在")
        if path.stat().st_size > MAX_ATTACHMENT_BYTES:
            raise UiBackendError("ATTACHMENT_SOURCE_TOO_LARGE", "附件超过当前单文件大小限制")
        self._guard(window)
        rectangle = wintypes.RECT()
        if not self.user32.GetWindowRect(window, ctypes.byref(rectangle)):
            raise UiBackendError("WECHAT_WINDOW_RECT_FAILED", "无法读取微信窗口位置")
        width = rectangle.right - rectangle.left
        height = rectangle.bottom - rectangle.top
        point = (rectangle.left + int(width * 0.385), rectangle.top + int(height * 0.955))
        if not self.user32.SetCursorPos(*point):
            raise UiBackendError("FILE_PICKER_OPEN_FAILED", "无法定位微信文件按钮")
        self._expected_mouse_position = point
        self.user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        self.user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)

        deadline = time.monotonic() + FILE_DIALOG_TIMEOUT_SECONDS
        picker: int | None = None
        controls: tuple[int, int, int] | None = None
        while time.monotonic() < deadline:
            candidates = [
                (dialog, self._picker_controls(dialog))
                for dialog in self._file_dialogs(window)
            ]
            candidates = [(dialog, value) for dialog, value in candidates if value is not None]
            if len(candidates) == 1:
                picker, controls = candidates[0]
                break
            if len(candidates) > 1:
                raise UiBackendError("FILE_PICKER_AMBIGUOUS", "出现多个文件选择器，拒绝猜测")
            time.sleep(0.2)
        if picker is None or controls is None:
            raise UiBackendError("FILE_PICKER_NOT_FOUND", "微信文件选择器未出现")

        edit, open_button, cancel_button = controls
        self.user32.SetForegroundWindow(picker)
        self._set_dialog_path(edit, path)
        self._click_control(open_button)

        deadline = time.monotonic() + FILE_DIALOG_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            dialogs = self._file_dialogs(window)
            if picker not in dialogs or not self.user32.IsWindow(picker):
                self.user32.SetForegroundWindow(window)
                return
            for dialog in dialogs:
                if dialog == picker:
                    continue
                ok_button = self._dialog_control(dialog, "Button", "确定")
                if ok_button is not None:
                    self._click_control(ok_button)
                    if self.user32.IsWindow(cancel_button):
                        self._click_control(cancel_button)
                    raise UiBackendError("FILE_PICKER_REJECTED", "文件选择器拒绝了目标文件")
            time.sleep(0.2)
        if self.user32.IsWindow(cancel_button):
            self._click_control(cancel_button)
        raise UiBackendError("FILE_PICKER_TIMEOUT", "文件选择器没有在时限内完成")

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

    def _visible_wechat_window_count(self) -> int:
        if not hasattr(self.user32, "EnumWindows"):
            return 0
        pids = self._wechat_pids()
        count = 0
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        @callback_type
        def callback(window: int, _: int) -> bool:
            nonlocal count
            if (
                self._window_pid(int(window)) in pids
                and self.user32.IsWindowVisible(window)
                and not self.user32.IsIconic(window)
            ):
                count += 1
            return True

        self.user32.EnumWindows(callback, 0)
        return count

    @staticmethod
    def _clipboard_digest(formats: tuple[ClipboardFormat, ...]) -> str:
        digest = hashlib.sha256()
        for item in formats:
            digest.update(struct.pack("<I", item.format_id))
            digest.update(struct.pack("<Q", len(item.data)))
            digest.update(item.data)
        return digest.hexdigest()

    def _start_visible_interval(self) -> None:
        if getattr(self, "_visible_started_at", None) is None:
            self._visible_started_at = time.monotonic()

    def _stop_visible_interval(self) -> None:
        visible_started_at = getattr(self, "_visible_started_at", None)
        if visible_started_at is not None:
            self._visible_duration_seconds = getattr(self, "_visible_duration_seconds", 0.0)
            self._visible_duration_seconds += time.monotonic() - visible_started_at
            self._visible_started_at = None

    def environment_observation(self) -> dict[str, Any]:
        duration = getattr(self, "_visible_duration_seconds", 0.0)
        visible_started_at = getattr(self, "_visible_started_at", None)
        if visible_started_at is not None:
            duration += time.monotonic() - visible_started_at
        result = dict(getattr(self, "_environment_observation", {}))
        result["wechat_visible_duration_ms"] = round(duration * 1000)
        return result

    def _last_input_tick(self) -> int:
        info = LASTINPUTINFO(cbSize=ctypes.sizeof(LASTINPUTINFO))
        if not self.user32.GetLastInputInfo(ctypes.byref(info)):
            raise UiBackendError("LAST_INPUT_SNAPSHOT_FAILED", "无法读取 Windows 最近输入时间")
        return int(info.dwTime)

    def _guard_pre_ui_takeover(self, window: int | None) -> None:
        snapshot = getattr(self, "_snapshot", None)
        if not isinstance(snapshot, Win32EnvironmentSnapshot):
            raise UiBackendError("ENV_SNAPSHOT_MISSING", "微信 UI 操作缺少环境快照")
        point = wintypes.POINT()
        if not self.user32.GetCursorPos(ctypes.byref(point)):
            raise UiBackendError("CURSOR_SNAPSHOT_FAILED", "无法复核鼠标位置")
        allowed_foregrounds = {snapshot.foreground_window}
        if window is not None:
            allowed_foregrounds.add(window)
        unchanged = (
            self._last_input_tick() == snapshot.last_input_tick
            and (int(point.x), int(point.y)) == snapshot.mouse_position
            and int(self.user32.GetClipboardSequenceNumber())
            == snapshot.clipboard_sequence_number
            and int(self.user32.GetForegroundWindow()) in allowed_foregrounds
        )
        if not unchanged:
            self._user_interaction_detected = True
            raise UiBackendError("USER_INTERACTION_DETECTED", "环境快照后检测到用户操作，停止接管微信")

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
        last_input_tick = self._last_input_tick()
        point = wintypes.POINT()
        if not self.user32.GetCursorPos(ctypes.byref(point)):
            raise UiBackendError("CURSOR_SNAPSHOT_FAILED", "无法读取鼠标位置")
        foreground_window = int(self.user32.GetForegroundWindow())
        mouse_position = (int(point.x), int(point.y))
        clipboard_sequence_number = int(self.user32.GetClipboardSequenceNumber())
        wechat_window = self._find_window(required=False)
        clipboard_formats = (
            self._snapshot_clipboard()
            if getattr(self, "attachment_input_mode", "file_picker") == "cf_hdrop"
            else ()
        )
        final_point = wintypes.POINT()
        stable = (
            self._last_input_tick() == last_input_tick
            and self.user32.GetCursorPos(ctypes.byref(final_point))
            and (int(final_point.x), int(final_point.y)) == mouse_position
            and int(self.user32.GetForegroundWindow()) == foreground_window
            and int(self.user32.GetClipboardSequenceNumber()) == clipboard_sequence_number
        )
        if not stable:
            self._user_interaction_detected = True
            raise UiBackendError("ENV_SNAPSHOT_UNSTABLE", "环境快照期间检测到用户操作")
        snapshot = Win32EnvironmentSnapshot(
            foreground_window=foreground_window,
            mouse_position=mouse_position,
            clipboard_formats=clipboard_formats,
            clipboard_sequence_number=clipboard_sequence_number,
            wechat_window=wechat_window,
            wechat_visible=bool(wechat_window and self.user32.IsWindowVisible(wechat_window)),
            wechat_iconic=bool(wechat_window and self.user32.IsIconic(wechat_window)),
            last_input_tick=last_input_tick,
        )
        self._snapshot = snapshot
        self._expected_mouse_position = snapshot.mouse_position
        self._owned_clipboard_sequence = None
        self._user_interaction_detected = False
        self._hidden_text_phase = False
        self._hidden_foreground_window = None
        self._hidden_last_input_tick = None
        self._hidden_clipboard_sequence = None
        self._displayed_wechat_window = None
        self._owned_wechat_window = None
        self._visible_started_at = None
        self._visible_duration_seconds = 0.0
        self._environment_observation = {
            "ui_mode": (
                "file_picker_low_disturbance"
                if getattr(self, "attachment_input_mode", "file_picker") == "file_picker"
                else "cf_hdrop_candidate"
            ),
            "foreground_unchanged_before_restore": None,
            "foreground_restored": None,
            "mouse_unchanged_before_restore": None,
            "mouse_restored": None,
            "clipboard_sequence_before": snapshot.clipboard_sequence_number,
            "clipboard_sequence_after": None,
            "clipboard_semantics_restored": None,
            "restore_skipped_user_interaction": False,
            "visible_window_count_before": self._visible_wechat_window_count(),
            "visible_window_count_after": None,
            "cf_hdrop_candidate": True,
            "cf_hdrop_enabled": False,
            "file_picker_fallback_used": (
                getattr(self, "attachment_input_mode", "file_picker") == "file_picker"
            ),
        }
        if snapshot.clipboard_formats:
            self._environment_observation["clipboard_semantics_before_sha256"] = (
                self._clipboard_digest(snapshot.clipboard_formats)
            )
        return snapshot

    def wake(self) -> None:
        snapshot = getattr(self, "_snapshot", None)
        if not isinstance(snapshot, Win32EnvironmentSnapshot):
            raise UiBackendError("ENV_SNAPSHOT_MISSING", "微信唤醒缺少环境快照")
        self._guard_pre_ui_takeover(snapshot.wechat_window)
        os.startfile("weixin://")
        deadline = time.monotonic() + 4.0
        tracked_window = snapshot.wechat_window
        while time.monotonic() < deadline:
            if tracked_window is None or not self.user32.IsWindow(tracked_window):
                tracked_window = self._find_window(required=False)
            if (
                tracked_window is not None
                and self.user32.IsWindowVisible(tracked_window)
                and not self.user32.IsIconic(tracked_window)
            ):
                self._displayed_wechat_window = tracked_window
                self._start_visible_interval()
            elif self._displayed_wechat_window == tracked_window:
                self._stop_visible_interval()
            remaining = deadline - time.monotonic()
            if remaining > 0:
                time.sleep(min(0.25, remaining))

    def locate_window(self) -> int:
        window = self._find_window(required=True)
        assert window is not None
        self._guard_pre_ui_takeover(window)
        self._displayed_wechat_window = window
        self._start_visible_interval()
        self.user32.ShowWindow(window, SW_RESTORE)
        self.user32.SetForegroundWindow(window)
        time.sleep(1)
        if int(self.user32.GetForegroundWindow()) != window:
            raise UiBackendError("WECHAT_FOCUS_FAILED", "无法把微信窗口置于前台")
        self._owned_wechat_window = window
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
        owned_clipboard_sequence = getattr(self, "_owned_clipboard_sequence", None)
        if (
            owned_clipboard_sequence is not None
            and int(self.user32.GetClipboardSequenceNumber()) != owned_clipboard_sequence
        ):
            self._user_interaction_detected = True
            raise UiBackendError("USER_INTERACTION_DETECTED", "附件粘贴前剪贴板已被用户改变")
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
        if getattr(self, "attachment_input_mode", "file_picker") == "file_picker":
            self._select_file_with_dialog(active_window, path)
        else:
            self._guard_snapshot_clipboard_unchanged()
            self._set_file_clipboard(path)
            self._hotkey(active_window, VK_CONTROL, VK_V)
        deadline = time.monotonic() + getattr(
            self, "draft_timeout_seconds", DEFAULT_DRAFT_TIMEOUT_SECONDS
        )
        rows: list[tuple[Any, Any]] = []
        data = b""
        while time.monotonic() < deadline:
            self._refresh()
            rows = self._draft_rows(route.username)
            if len(rows) > 1:
                raise UiBackendError(
                    "ATTACHMENT_DRAFT_ROUTE_AMBIGUOUS",
                    "微信草稿表出现多条目标 route 记录",
                )
            if len(rows) == 1:
                data = self._draft_bytes(rows[0][1])
                if data and self._contains_file_name(data, path.name):
                    break
            time.sleep(getattr(self, "database_poll_seconds", DEFAULT_DATABASE_POLL_SECONDS))
        else:
            code = (
                "ATTACHMENT_DRAFT_ROUTE_UNVERIFIED"
                if len(rows) != 1
                else "ATTACHMENT_DRAFT_CONTENT_UNVERIFIED"
            )
            raise UiBackendError(code, "微信草稿未在时限内获得精确 route 与附件证明")
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
        username = draft_handle.get("username") if isinstance(draft_handle, dict) else None
        if not isinstance(username, str):
            raise UiBackendError("ATTACHMENT_DRAFT_HANDLE_INVALID", "附件草稿句柄无效")
        deadline = time.monotonic() + getattr(
            self, "cleanup_timeout_seconds", DEFAULT_CLEANUP_TIMEOUT_SECONDS
        )
        while time.monotonic() < deadline:
            self._refresh()
            if not any(row[1] not in (None, b"", "") for row in self._draft_rows(username)):
                return
            time.sleep(getattr(self, "database_poll_seconds", DEFAULT_DATABASE_POLL_SECONDS))
        raise UiBackendError("ATTACHMENT_DRAFT_CLEANUP_FAILED", "附件草稿未在时限内被清理")

    def restore_environment(self, snapshot: object) -> None:
        if not isinstance(snapshot, Win32EnvironmentSnapshot):
            raise UiBackendError("ENV_SNAPSHOT_INVALID", "环境快照类型无效")
        errors: list[Exception] = []
        if not hasattr(self, "_environment_observation"):
            self._environment_observation = {}
        point = wintypes.POINT()
        mouse_read = bool(self.user32.GetCursorPos(ctypes.byref(point)))
        current_mouse = (int(point.x), int(point.y)) if mouse_read else None
        current_foreground = int(self.user32.GetForegroundWindow())
        hidden_text_phase = getattr(self, "_hidden_text_phase", False)
        owned_window = getattr(self, "_owned_wechat_window", None)
        displayed_window = getattr(self, "_displayed_wechat_window", None)
        if hidden_text_phase:
            expected_foregrounds = {getattr(self, "_hidden_foreground_window", None)}
        elif owned_window is not None:
            expected_foregrounds = {owned_window}
        elif displayed_window is not None:
            expected_foregrounds = {snapshot.foreground_window, displayed_window}
        else:
            expected_foregrounds = {snapshot.foreground_window}
        foreground_unchanged = current_foreground in expected_foregrounds
        mouse_unchanged = current_mouse == getattr(self, "_expected_mouse_position", None)
        expected_last_input_tick = (
            getattr(self, "_hidden_last_input_tick", None) if hidden_text_phase else None
        )
        last_input_tick_before_restore = (
            self._last_input_tick() if expected_last_input_tick is not None else None
        )
        last_input_unchanged = (
            expected_last_input_tick is None
            or last_input_tick_before_restore == expected_last_input_tick
        )
        self._environment_observation["foreground_unchanged_before_restore"] = foreground_unchanged
        self._environment_observation["mouse_unchanged_before_restore"] = mouse_unchanged
        self._environment_observation["last_input_tick_before_restore"] = (
            last_input_tick_before_restore
        )
        self._environment_observation["last_input_unchanged_before_restore"] = (
            last_input_unchanged
        )
        if not foreground_unchanged or not mouse_unchanged or not last_input_unchanged:
            self._user_interaction_detected = True
        clipboard_sequence = int(self.user32.GetClipboardSequenceNumber())
        if self._owned_clipboard_sequence is not None:
            if clipboard_sequence == self._owned_clipboard_sequence:
                try:
                    self._replace_clipboard(snapshot.clipboard_formats)
                except Exception as error:
                    errors.append(error)
            else:
                self._user_interaction_detected = True
        elif clipboard_sequence != snapshot.clipboard_sequence_number:
            self._user_interaction_detected = True
        if self._user_interaction_detected:
            self._stop_visible_interval()
            self._environment_observation["restore_skipped_user_interaction"] = True
            self._environment_observation["clipboard_sequence_after"] = clipboard_sequence
            displayed_window = getattr(self, "_displayed_wechat_window", None)
            displayed_window_unwound = False
            if (
                displayed_window is not None
                and displayed_window != current_foreground
                and self.user32.IsWindow(displayed_window)
            ):
                try:
                    if snapshot.wechat_window is None or not snapshot.wechat_visible:
                        self.user32.ShowWindow(displayed_window, SW_HIDE)
                        displayed_window_unwound = True
                    elif snapshot.wechat_iconic:
                        self.user32.ShowWindow(displayed_window, SW_MINIMIZE)
                        displayed_window_unwound = True
                except Exception:
                    displayed_window_unwound = False
            self._environment_observation["wechat_window_unwound_after_user_interaction"] = (
                displayed_window_unwound
            )
            self._environment_observation["visible_window_count_after"] = (
                self._visible_wechat_window_count()
            )
            self._snapshot = None
            self._expected_mouse_position = None
            self._owned_clipboard_sequence = None
            self._displayed_wechat_window = None
            self._owned_wechat_window = None
            self._hidden_text_phase = False
            self._hidden_foreground_window = None
            self._hidden_last_input_tick = None
            self._hidden_clipboard_sequence = None
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
        except Exception as error:
            errors.append(error)
        foreground_restore_request_result: bool | None = None
        try:
            if (
                int(self.user32.GetForegroundWindow()) != snapshot.foreground_window
                and snapshot.foreground_window
                and self.user32.IsWindow(snapshot.foreground_window)
            ):
                foreground_restore_request_result = bool(
                    self.user32.SetForegroundWindow(snapshot.foreground_window)
                )
        except Exception as error:
            errors.append(error)
        stable_foreground_samples = 0
        for _ in range(FOREGROUND_RESTORE_POLL_ATTEMPTS):
            if int(self.user32.GetForegroundWindow()) == snapshot.foreground_window:
                stable_foreground_samples += 1
                if stable_foreground_samples >= FOREGROUND_RESTORE_STABLE_SAMPLES:
                    break
            else:
                stable_foreground_samples = 0
            time.sleep(FOREGROUND_RESTORE_POLL_SECONDS)
        final_foreground = int(self.user32.GetForegroundWindow())
        foreground_restored = (
            stable_foreground_samples >= FOREGROUND_RESTORE_STABLE_SAMPLES
            and final_foreground == snapshot.foreground_window
        )
        last_input_tick_after_restore = (
            self._last_input_tick() if expected_last_input_tick is not None else None
        )
        last_input_unchanged_after_restore = (
            expected_last_input_tick is None
            or last_input_tick_after_restore == expected_last_input_tick
        )
        self._environment_observation["foreground_restore_request_result"] = (
            foreground_restore_request_result
        )
        self._environment_observation["foreground_restore_stable_samples"] = (
            stable_foreground_samples
        )
        self._environment_observation["last_input_tick_after_restore"] = (
            last_input_tick_after_restore
        )
        self._environment_observation["last_input_unchanged_after_restore"] = (
            last_input_unchanged_after_restore
        )
        if not last_input_unchanged_after_restore:
            self._user_interaction_detected = True
            self._environment_observation["restore_skipped_user_interaction"] = True
            foreground_restored = False
            errors.append(
                UiBackendError(
                    "ENV_RESTORE_SKIPPED_USER_INTERACTION",
                    "恢复前台窗口期间检测到新的用户输入",
                )
            )
        if not foreground_restored:
            errors.append(
                UiBackendError(
                    "ENV_FOREGROUND_RESTORE_FAILED",
                    "无法在时限内恢复原前台窗口",
                )
            )
        self._snapshot = None
        self._expected_mouse_position = None
        self._owned_clipboard_sequence = None
        self._displayed_wechat_window = None
        self._owned_wechat_window = None
        self._hidden_text_phase = False
        self._hidden_foreground_window = None
        self._hidden_last_input_tick = None
        self._hidden_clipboard_sequence = None
        self._stop_visible_interval()
        final_point = wintypes.POINT()
        final_mouse_read = bool(self.user32.GetCursorPos(ctypes.byref(final_point)))
        self._environment_observation["foreground_restored"] = foreground_restored
        self._environment_observation["mouse_restored"] = (
            final_mouse_read
            and (int(final_point.x), int(final_point.y)) == snapshot.mouse_position
        )
        final_clipboard_sequence = int(self.user32.GetClipboardSequenceNumber())
        self._environment_observation["clipboard_sequence_after"] = final_clipboard_sequence
        if snapshot.clipboard_formats:
            try:
                restored_formats = self._snapshot_clipboard()
                self._environment_observation["clipboard_semantics_restored"] = (
                    self._clipboard_digest(restored_formats)
                    == self._clipboard_digest(snapshot.clipboard_formats)
                )
            except Exception:
                self._environment_observation["clipboard_semantics_restored"] = False
        else:
            self._environment_observation["clipboard_semantics_restored"] = (
                final_clipboard_sequence == snapshot.clipboard_sequence_number
            )
        self._environment_observation["visible_window_count_after"] = (
            self._visible_wechat_window_count()
        )
        if errors:
            raise UiBackendError("ENV_RESTORE_FAILED", "无法完整恢复剪贴板、窗口或焦点")


class Win32WechatTextBackend(Win32WechatAttachmentBackend):
    def _guard_text_phase(self, window: object) -> int:
        if not getattr(self, "_hidden_text_phase", False):
            return self._guard(window)
        if not isinstance(window, int) or not self.user32.IsWindow(window):
            raise UiBackendError("WECHAT_WINDOW_LOST", "微信窗口已失效")
        if self.user32.IsWindowVisible(window):
            self._user_interaction_detected = True
            raise UiBackendError("USER_INTERACTION_DETECTED", "微信窗口在隐藏发送阶段意外显示")
        if int(self.user32.GetForegroundWindow()) != self._hidden_foreground_window:
            self._user_interaction_detected = True
            raise UiBackendError("USER_INTERACTION_DETECTED", "隐藏发送阶段前台窗口已变化")
        if self._expected_mouse_position is not None:
            point = wintypes.POINT()
            self.user32.GetCursorPos(ctypes.byref(point))
            if (int(point.x), int(point.y)) != self._expected_mouse_position:
                self._user_interaction_detected = True
                raise UiBackendError("USER_INTERACTION_DETECTED", "隐藏发送阶段鼠标位置已变化")
        if self._last_input_tick() != getattr(self, "_hidden_last_input_tick", None):
            self._user_interaction_detected = True
            raise UiBackendError("USER_INTERACTION_DETECTED", "隐藏发送阶段检测到新的键盘或鼠标输入")
        if int(self.user32.GetClipboardSequenceNumber()) != getattr(
            self, "_hidden_clipboard_sequence", None
        ):
            self._user_interaction_detected = True
            raise UiBackendError("USER_INTERACTION_DETECTED", "隐藏发送阶段剪贴板已变化")
        return window

    def _enter_hidden_text_phase(self, window: int) -> None:
        self._guard(window)
        hidden_last_input_tick = self._last_input_tick()
        hidden_clipboard_sequence = int(self.user32.GetClipboardSequenceNumber())
        self.user32.ShowWindow(window, SW_HIDE)
        time.sleep(0.25)
        if self.user32.IsWindowVisible(window):
            raise UiBackendError("WECHAT_HIDE_FAILED", "无法进入隐藏文字发送阶段")
        self._stop_visible_interval()
        self._hidden_text_phase = True
        self._hidden_foreground_window = int(self.user32.GetForegroundWindow())
        self._hidden_last_input_tick = hidden_last_input_tick
        self._hidden_clipboard_sequence = hidden_clipboard_sequence
        if (
            self._last_input_tick() != hidden_last_input_tick
            or int(self.user32.GetClipboardSequenceNumber()) != hidden_clipboard_sequence
        ):
            self._user_interaction_detected = True
            raise UiBackendError("USER_INTERACTION_DETECTED", "隐藏窗口期间检测到用户输入或剪贴板变化")

    def _restore_visible_text_control(self, window: int) -> None:
        if not getattr(self, "_hidden_text_phase", False):
            return
        self._guard_text_phase(window)
        self._displayed_wechat_window = window
        self._start_visible_interval()
        self.user32.ShowWindow(window, SW_RESTORE)
        self.user32.SetForegroundWindow(window)
        time.sleep(0.5)
        if int(self.user32.GetForegroundWindow()) != window:
            raise UiBackendError("WECHAT_FOCUS_FAILED", "无法恢复微信窗口用于安全清理")
        self._owned_wechat_window = window
        self._hidden_text_phase = False
        self._hidden_foreground_window = None
        self._hidden_last_input_tick = None
        self._hidden_clipboard_sequence = None

    def _send_window_message(self, window: int, message: int, wparam: int, lparam: int) -> None:
        self._guard_text_phase(window)
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

    def _window_end(self, window: int) -> None:
        scan = int(self.user32.MapVirtualKeyW(VK_END, 0))
        lparam_down = (scan << 16) | 1
        self._send_window_message(window, WM_KEYDOWN, VK_END, lparam_down)
        self._send_window_message(window, WM_KEYUP, VK_END, lparam_down | 0xC0000000)

    def _window_backspaces(self, window: int, delete_press_count: int) -> None:
        if not 0 < delete_press_count <= VISIBLE_TEXT_CODE_UNIT_LIMIT:
            raise UiBackendError("TEXT_DRAFT_HANDLE_INVALID", "文字草稿长度证明无效")
        for _ in range(delete_press_count):
            self._send_window_message(window, WM_CHAR, 0x08, 1)
            time.sleep(0.05)

    def snapshot_environment(self) -> Win32EnvironmentSnapshot:
        snapshot = super().snapshot_environment()
        self._environment_observation["ui_mode"] = "visible_navigation_then_hidden_text"
        self._environment_observation["file_picker_fallback_used"] = False
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
        if getattr(self, "hide_text_after_navigation", False):
            self._enter_hidden_text_phase(active_window)
        draft_handle["approved_text_sha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
        draft_handle["text"] = text
        self._text_draft_handle = draft_handle
        self._window_unicode_text(active_window, text)
        deadline = time.monotonic() + getattr(
            self, "draft_timeout_seconds", DEFAULT_DRAFT_TIMEOUT_SECONDS
        )
        rows: list[tuple[Any, Any]] = []
        data = b""
        while time.monotonic() < deadline:
            self._refresh()
            rows = self._draft_rows(draft_handle["username"])
            if len(rows) > 1:
                raise UiBackendError("TEXT_DRAFT_ROUTE_AMBIGUOUS", "微信草稿表出现多条目标 route 记录")
            if len(rows) == 1:
                data = self._draft_bytes(rows[0][1])
                if data and self._contains_text(data, text):
                    break
            time.sleep(getattr(self, "database_poll_seconds", DEFAULT_DATABASE_POLL_SECONDS))
        else:
            code = "TEXT_DRAFT_ROUTE_UNVERIFIED" if len(rows) != 1 else "TEXT_DRAFT_CONTENT_UNVERIFIED"
            raise UiBackendError(code, "微信草稿未在时限内获得精确 route 与批准正文证明")
        draft_handle["proof_sha256"] = hashlib.sha256(data).hexdigest()

    def focus_state(self, window: object, route: VerifiedRoute) -> FocusState:
        try:
            self._guard_text_phase(window)
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
            if proof is not None and (not isinstance(proof, str) or not proof):
                return FocusState.UNKNOWN
            text = handle.get("text")
            text_sha256 = handle.get("approved_text_sha256")
            if not isinstance(text, str) or not text:
                return FocusState.UNKNOWN
            if hashlib.sha256(text.encode("utf-8")).hexdigest() != text_sha256:
                return FocusState.UNKNOWN
            self._refresh()
            rows = self._draft_rows(route.username)
            if len(rows) != 1:
                return FocusState.UNKNOWN
            data = self._draft_bytes(rows[0][1])
            return FocusState.VERIFIED if self._contains_text(data, text) else FocusState.MISMATCH
        except Exception:
            return FocusState.UNKNOWN

    def send_owned_draft(self, window: object, draft_handle: object) -> None:
        active_window = self._guard_text_phase(window)
        if draft_handle is not getattr(self, "_text_draft_handle", None):
            raise UiBackendError("TEXT_DRAFT_HANDLE_INVALID", "文字草稿未获得 route 证明")
        if not isinstance(draft_handle, dict) or not draft_handle.get("proof_sha256"):
            raise UiBackendError("TEXT_DRAFT_HANDLE_INVALID", "文字草稿未获得数据库 route 证明")
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
        if not isinstance(window, int):
            raise UiBackendError("TEXT_DRAFT_HANDLE_INVALID", "文字草稿窗口无效")
        self._guard_text_phase(window)
        self._restore_visible_text_control(window)
        active_window = self._guard(window)
        if draft_handle is not getattr(self, "_text_draft_handle", None):
            raise UiBackendError("TEXT_DRAFT_HANDLE_INVALID", "文字草稿句柄无效")
        text = draft_handle.get("text")
        if not isinstance(text, str) or not text:
            raise UiBackendError("TEXT_DRAFT_HANDLE_INVALID", "文字草稿内容证明无效")
        username = draft_handle.get("username")
        self._refresh()
        rows = self._draft_rows(username)
        if len(rows) != 1 or not self._contains_text(self._draft_bytes(rows[0][1]), text):
            raise UiBackendError("TEXT_DRAFT_HANDLE_INVALID", "当前草稿不再匹配本次自有正文")
        self._focus_input(active_window)
        self._hotkey(active_window, VK_CONTROL, 0x41)
        self._press(active_window, VK_DELETE)
        deadline = time.monotonic() + getattr(
            self, "cleanup_timeout_seconds", DEFAULT_CLEANUP_TIMEOUT_SECONDS
        )
        while time.monotonic() < deadline:
            self._refresh()
            if not any(row[1] not in (None, b"", "") for row in self._draft_rows(username)):
                self._text_draft_handle = None
                return
            time.sleep(getattr(self, "database_poll_seconds", DEFAULT_DATABASE_POLL_SECONDS))
        raise UiBackendError("TEXT_DRAFT_CLEANUP_FAILED", "文字草稿未在时限内被清理")
