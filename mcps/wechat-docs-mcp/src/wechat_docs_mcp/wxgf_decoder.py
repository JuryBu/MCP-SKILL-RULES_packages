from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable

from PIL import Image, UnidentifiedImageError

from .ledger import LedgerError
from .office_converter import DERIVED_CACHE_TTL_SECONDS


WXGF_MAGIC = b"wxgf"
HEVC_START_CODES = (b"\x00\x00\x00\x01", b"\x00\x00\x01")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _hidden_subprocess_kwargs() -> dict[str, object]:
    if os.name != "nt":
        return {}
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = subprocess.SW_HIDE
    return {"creationflags": subprocess.CREATE_NO_WINDOW, "startupinfo": startupinfo}


class WxgfDecoder:
    def __init__(
        self,
        derived_root: str | Path,
        ffmpeg_path: str | Path,
        *,
        runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    ) -> None:
        self.derived_root = Path(derived_root).resolve()
        self.ffmpeg_path = Path(ffmpeg_path).resolve()
        self.runner = runner

    def _converter_version(self) -> str:
        if not self.ffmpeg_path.is_file():
            return "missing"
        stat = self.ffmpeg_path.stat()
        return hashlib.sha256(
            f"{self.ffmpeg_path}\0{stat.st_size}\0{stat.st_mtime_ns}".encode("utf-8")
        ).hexdigest()

    @staticmethod
    def _extract_hevc(payload: bytes) -> bytes:
        if not payload.startswith(WXGF_MAGIC):
            raise LedgerError("ATTACHMENT_WXGF_FORMAT", "附件不是 wxgf 图片")
        starts = [index for code in HEVC_START_CODES if (index := payload.find(code, 4)) >= 0]
        if not starts:
            raise LedgerError("ATTACHMENT_WXGF_HEVC_NOT_FOUND", "wxgf 中没有可识别的 HEVC 裸流")
        return payload[min(starts) :]

    def convert(self, attachment_ref: str, source_path: Path, source_sha256: str) -> dict[str, Any]:
        if not self.ffmpeg_path.is_file():
            raise LedgerError("ATTACHMENT_FFMPEG_MISSING", "ffmpeg 未配置，无法读取 wxgf 图片")
        payload = source_path.read_bytes()
        hevc = self._extract_hevc(payload)
        converter_version = self._converter_version()
        cache_key = hashlib.sha256(
            f"{attachment_ref}\0{source_sha256}\0{converter_version}".encode("utf-8")
        ).hexdigest()
        cache_root = self.derived_root / "wxgf" / cache_key[:2] / cache_key
        output = cache_root / "image.png"
        if output.is_file():
            try:
                with Image.open(output) as image:
                    image.verify()
                return self._result(output, converter_version, cache_hit=True)
            except (OSError, UnidentifiedImageError):
                shutil.rmtree(cache_root, ignore_errors=True)

        cache_root.mkdir(parents=True, exist_ok=True)
        hevc_path = cache_root / "source.h265"
        temporary_output = cache_root / f"image.{os.getpid()}.tmp.png"
        try:
            with hevc_path.open("xb") as stream:
                stream.write(hevc)
                stream.flush()
                os.fsync(stream.fileno())
            command = [
                str(self.ffmpeg_path),
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-f",
                "hevc",
                "-i",
                str(hevc_path),
                "-frames:v",
                "1",
                str(temporary_output),
            ]
            result = self.runner(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=30,
                **_hidden_subprocess_kwargs(),
            )
            if result.returncode != 0 or not temporary_output.is_file():
                raise LedgerError("ATTACHMENT_WXGF_DECODE_FAILED", "ffmpeg 未能解码 wxgf/HEVC 图片")
            with Image.open(temporary_output) as image:
                image.load()
                if image.width < 1 or image.height < 1:
                    raise LedgerError("ATTACHMENT_WXGF_DECODE_FAILED", "wxgf 解码结果尺寸无效")
            temporary_output.replace(output)
            return self._result(output, converter_version, cache_hit=False)
        except Exception:
            if not output.is_file():
                shutil.rmtree(cache_root, ignore_errors=True)
            raise
        finally:
            temporary_output.unlink(missing_ok=True)

    @staticmethod
    def _result(path: Path, converter_version: str, *, cache_hit: bool) -> dict[str, Any]:
        with Image.open(path) as image:
            image.load()
            width, height = image.size
        return {
            "converter": "ffmpeg-hevc",
            "converter_version": converter_version,
            "derived_path": str(path),
            "derived_sha256": _sha256(path),
            "derived_mime_type": "image/png",
            "width": width,
            "height": height,
            "cache_hit": cache_hit,
        }

    def cleanup_expired(self, max_age_seconds: int = DERIVED_CACHE_TTL_SECONDS) -> int:
        root = self.derived_root / "wxgf"
        if not root.is_dir():
            return 0
        threshold = __import__("time").time() - max_age_seconds
        removed = 0
        for leaf in sorted(root.glob("*/*")):
            if leaf.is_dir() and leaf.stat().st_mtime < threshold:
                shutil.rmtree(leaf, ignore_errors=True)
                removed += 1
        return removed
