from __future__ import annotations

import base64
import ctypes
import hashlib
import io
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from ctypes import wintypes
from mcp.types import CallToolResult, ImageContent, TextContent
from PIL import Image, ImageStat

from .attachments import AttachmentRegistry
from .ledger import LedgerError


PW_RENDERFULLCONTENT = 0x00000002
BI_RGB = 0
DIB_RGB_COLORS = 0


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


@dataclass(frozen=True)
class ViewerCandidate:
    window: int
    title: str
    class_name: str
    process_id: int
    process_name: str


class VisibleViewerBackend(Protocol):
    def foreground_window(self) -> int: ...

    def find_candidates(self) -> list[ViewerCandidate]: ...

    def capture_png(self, candidate: ViewerCandidate) -> tuple[bytes, int, int]: ...


class Win32VisibleViewerBackend:
    def __init__(
        self,
        *,
        viewer_titles: tuple[str, ...] = ("图片和视频",),
        process_names: tuple[str, ...] = ("weixin.exe",),
    ) -> None:
        if os.name != "nt":
            raise LedgerError("VISIBLE_VIEW_PLATFORM_UNSUPPORTED", "visible_view_capture 仅支持 Windows")
        self.viewer_titles = {title.strip() for title in viewer_titles if title.strip()}
        self.process_names = {name.lower() for name in process_names}
        self.user32 = ctypes.windll.user32
        self.gdi32 = ctypes.windll.gdi32
        self.kernel32 = ctypes.windll.kernel32
        self._configure_apis()

    def _configure_apis(self) -> None:
        self.user32.GetForegroundWindow.restype = wintypes.HWND
        self.user32.GetWindowDC.argtypes = [wintypes.HWND]
        self.user32.GetWindowDC.restype = wintypes.HDC
        self.user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
        self.user32.ReleaseDC.restype = ctypes.c_int
        self.user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
        self.user32.PrintWindow.restype = wintypes.BOOL
        self.gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
        self.gdi32.CreateCompatibleDC.restype = wintypes.HDC
        self.gdi32.CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
        self.gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
        self.gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
        self.gdi32.SelectObject.restype = wintypes.HGDIOBJ
        self.gdi32.GetDIBits.argtypes = [
            wintypes.HDC,
            wintypes.HBITMAP,
            wintypes.UINT,
            wintypes.UINT,
            ctypes.c_void_p,
            ctypes.POINTER(BITMAPINFO),
            wintypes.UINT,
        ]
        self.gdi32.GetDIBits.restype = ctypes.c_int
        self.gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
        self.gdi32.DeleteObject.restype = wintypes.BOOL
        self.gdi32.DeleteDC.argtypes = [wintypes.HDC]
        self.gdi32.DeleteDC.restype = wintypes.BOOL
        self.kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel32.OpenProcess.restype = wintypes.HANDLE
        self.kernel32.QueryFullProcessImageNameW.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.LPWSTR,
            ctypes.POINTER(wintypes.DWORD),
        ]
        self.kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
        self.kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel32.CloseHandle.restype = wintypes.BOOL

    def foreground_window(self) -> int:
        return int(self.user32.GetForegroundWindow())

    def _process_name(self, process_id: int) -> str:
        process_query_limited_information = 0x1000
        handle = self.kernel32.OpenProcess(process_query_limited_information, False, process_id)
        if not handle:
            return ""
        try:
            size = wintypes.DWORD(32768)
            buffer = ctypes.create_unicode_buffer(size.value)
            if not self.kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                return ""
            return Path(buffer.value).name
        finally:
            self.kernel32.CloseHandle(handle)

    def find_candidates(self) -> list[ViewerCandidate]:
        found: list[ViewerCandidate] = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        @callback_type
        def callback(window: int, _: int) -> bool:
            if not self.user32.IsWindowVisible(window) or self.user32.IsIconic(window):
                return True
            title_length = self.user32.GetWindowTextLengthW(window)
            title_buffer = ctypes.create_unicode_buffer(title_length + 1)
            self.user32.GetWindowTextW(window, title_buffer, len(title_buffer))
            if title_buffer.value not in self.viewer_titles:
                return True
            class_buffer = ctypes.create_unicode_buffer(256)
            self.user32.GetClassNameW(window, class_buffer, len(class_buffer))
            if "QWindowIcon" not in class_buffer.value:
                return True
            process_id = wintypes.DWORD()
            self.user32.GetWindowThreadProcessId(window, ctypes.byref(process_id))
            process_name = self._process_name(int(process_id.value))
            if process_name.lower() not in self.process_names:
                return True
            found.append(
                ViewerCandidate(
                    window=int(window),
                    title=title_buffer.value,
                    class_name=class_buffer.value,
                    process_id=int(process_id.value),
                    process_name=process_name,
                )
            )
            return True

        self.user32.EnumWindows(callback, 0)
        return found

    def capture_png(self, candidate: ViewerCandidate) -> tuple[bytes, int, int]:
        rectangle = wintypes.RECT()
        if not self.user32.GetWindowRect(candidate.window, ctypes.byref(rectangle)):
            raise LedgerError("VISIBLE_VIEW_GEOMETRY_FAILED", "无法读取图片查看器窗口尺寸")
        width = int(rectangle.right - rectangle.left)
        height = int(rectangle.bottom - rectangle.top)
        if width < 64 or height < 64 or width * height > 80_000_000:
            raise LedgerError("VISIBLE_VIEW_GEOMETRY_INVALID", "图片查看器窗口尺寸异常")
        window_dc = self.user32.GetWindowDC(candidate.window)
        if not window_dc:
            raise LedgerError("VISIBLE_VIEW_CAPTURE_FAILED", "无法读取图片查看器窗口")
        memory_dc = self.gdi32.CreateCompatibleDC(window_dc)
        bitmap = self.gdi32.CreateCompatibleBitmap(window_dc, width, height)
        previous = self.gdi32.SelectObject(memory_dc, bitmap)
        try:
            if not self.user32.PrintWindow(candidate.window, memory_dc, PW_RENDERFULLCONTENT):
                raise LedgerError("VISIBLE_VIEW_CAPTURE_FAILED", "PrintWindow 未返回图片查看器内容")
            info = BITMAPINFO()
            info.bmiHeader = BITMAPINFOHEADER(
                biSize=ctypes.sizeof(BITMAPINFOHEADER),
                biWidth=width,
                biHeight=-height,
                biPlanes=1,
                biBitCount=32,
                biCompression=BI_RGB,
                biSizeImage=width * height * 4,
            )
            buffer = ctypes.create_string_buffer(width * height * 4)
            lines = self.gdi32.GetDIBits(
                memory_dc,
                bitmap,
                0,
                height,
                buffer,
                ctypes.byref(info),
                DIB_RGB_COLORS,
            )
            if lines != height:
                raise LedgerError("VISIBLE_VIEW_CAPTURE_FAILED", "图片查看器像素读取不完整")
            image = Image.frombuffer("RGBA", (width, height), buffer, "raw", "BGRA", 0, 1).convert("RGB")
            extrema = ImageStat.Stat(image.convert("L")).extrema[0]
            if extrema[1] - extrema[0] < 4:
                raise LedgerError("VISIBLE_VIEW_CAPTURE_BLANK", "图片查看器预览为空白或不可读取")
            output = io.BytesIO()
            image.save(output, format="PNG", optimize=True)
            return output.getvalue(), width, height
        finally:
            self.gdi32.SelectObject(memory_dc, previous)
            self.gdi32.DeleteObject(bitmap)
            self.gdi32.DeleteDC(memory_dc)
            self.user32.ReleaseDC(candidate.window, window_dc)


class VisibleViewCapture:
    def __init__(
        self,
        registry: AttachmentRegistry,
        derived_root: str | Path,
        backend: VisibleViewerBackend,
    ) -> None:
        self.registry = registry
        self.derived_root = Path(derived_root).resolve()
        self.backend = backend

    def capture(
        self,
        subscription_id: str,
        event_id: str,
        attachment_ref: str,
        human_assisted_confirmation_ref: str,
    ) -> CallToolResult:
        if not human_assisted_confirmation_ref.strip():
            raise LedgerError(
                "VISIBLE_VIEW_HUMAN_CONFIRMATION_REQUIRED",
                "必须由人确认当前查看器正显示目标附件",
            )
        attachment = self.registry.attachment_for_ref(subscription_id, attachment_ref)
        if attachment["event_id"] != event_id:
            raise LedgerError("VISIBLE_VIEW_EVENT_MISMATCH", "event_id 与 attachment_ref 不匹配")
        if attachment["kind"] not in {"image", "sticker"}:
            raise LedgerError("VISIBLE_VIEW_KIND_UNSUPPORTED", "visible_view_capture 仅支持图片或表情")
        candidates = self.backend.find_candidates()
        if len(candidates) != 1:
            code = "VISIBLE_VIEW_NOT_FOUND" if not candidates else "VISIBLE_VIEW_AMBIGUOUS"
            raise LedgerError(code, "无法唯一定位由主人打开的微信图片查看器")
        foreground_before = self.backend.foreground_window()
        candidate = candidates[0]
        data, width, height = self.backend.capture_png(candidate)
        foreground_after = self.backend.foreground_window()
        if foreground_after != foreground_before:
            raise LedgerError("VISIBLE_VIEW_FOCUS_CHANGED", "抓取期间前台窗口变化，预览已拒绝")
        capture_sha256 = hashlib.sha256(data).hexdigest()
        destination = self.derived_root / "visible-previews" / event_id / f"{capture_sha256}.png"
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            temporary = destination.with_suffix(f".{os.getpid()}.tmp")
            temporary.write_bytes(data)
            temporary.replace(destination)
        payload = attachment["payload"]
        metadata = {
            "subscription_id": subscription_id,
            "route_id": attachment["route_id"],
            "event_id": event_id,
            "attachment_ref": attachment_ref,
            "local_id": payload.get("local_id"),
            "server_id": payload.get("server_id"),
            "provenance": "human_assisted_visible_view_capture",
            "quality": "viewport_preview",
            "human_assisted": True,
            "machine_verified_content_identity": False,
            "original_available": False,
            "viewport_complete": False,
            "returned_mime_type": "image/png",
            "returned_width": width,
            "returned_height": height,
            "returned_bytes": len(data),
            "returned_sha256": capture_sha256,
            "preview_path": str(destination),
            "viewer_title": candidate.title,
            "viewer_class": candidate.class_name,
            "viewer_process_name": candidate.process_name,
            "focus_unchanged": True,
            "human_assisted_confirmation_ref_sha256": hashlib.sha256(
                human_assisted_confirmation_ref.encode("utf-8")
            ).hexdigest(),
            "limitations": [
                "preview hash is not the original attachment hash",
                "the client cannot machine-bind viewer pixels to event/local/server identifiers",
                "the viewport may omit off-screen parts of the original image",
            ],
        }
        return CallToolResult(
            content=[
                TextContent(type="text", text=json.dumps(metadata, ensure_ascii=False, sort_keys=True)),
                ImageContent(
                    type="image",
                    data=base64.b64encode(data).decode("ascii"),
                    mimeType="image/png",
                    _meta=metadata,
                ),
            ],
            structuredContent=metadata,
            isError=False,
        )
