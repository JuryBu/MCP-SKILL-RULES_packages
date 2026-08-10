from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from mcp.types import CallToolResult, ImageContent, TextContent
from PIL import Image, ImageOps, UnidentifiedImageError

from .attachments import (
    ATTACHMENT_MATERIALIZATION_TTL_SECONDS,
    AttachmentMaterializer,
    AttachmentRegistry,
)
from .ledger import LedgerError
from .office_converter import DERIVED_CACHE_TTL_SECONDS, LocalOfficeConverter
from .wxgf_decoder import WXGF_MAGIC, WxgfDecoder


MAX_RETURN_IMAGES = 8
MAX_RETURN_PIXELS = 24_000_000
MAX_RETURN_BYTES = 8 * 1024 * 1024
DIRECT_ORIGINAL_MAX_BYTES = 4 * 1024 * 1024
DIRECT_ORIGINAL_MAX_PIXELS = 16_000_000
PREVIEW_MAX_EDGE = 4096
MIN_PREVIEW_EDGE = 192
PDF_RENDER_DPI = 160
MAX_PDF_RENDER_PIXELS = 32_000_000
JPEG_PREVIEW_QUALITY = 95
CURSOR_VERSION = 1


@dataclass(frozen=True)
class ReadBudget:
    images: int = MAX_RETURN_IMAGES
    pixels: int = MAX_RETURN_PIXELS
    bytes: int = MAX_RETURN_BYTES


@dataclass(frozen=True)
class VisualUnit:
    attachment_ref: str
    source_path: Path
    source_sha256: str
    source_mime_type: str
    page_number: int | None
    page_count: int
    source_kind: str
    conversion: dict[str, Any] | None = None

    @property
    def stable_id(self) -> str:
        suffix = "image" if self.page_number is None else f"page:{self.page_number}"
        return f"{self.attachment_ref}:{suffix}"


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _wire_size(data: bytes) -> int:
    return 4 * ((len(data) + 2) // 3)


def _starts_with(path: Path, magic: bytes) -> bool:
    try:
        with path.open("rb") as stream:
            return stream.read(len(magic)) == magic
    except OSError:
        return False


def _cursor_encode(fingerprint: str, offset: int) -> str:
    payload = json.dumps(
        {"v": CURSOR_VERSION, "request": fingerprint, "offset": offset},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _cursor_decode(cursor: str, fingerprint: str, unit_count: int) -> int:
    if not cursor:
        return 0
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(cursor + padding))
        offset = int(payload["offset"])
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
        raise LedgerError("ATTACHMENT_CONTINUATION_INVALID", "continuation_cursor 格式无效") from error
    if payload.get("v") != CURSOR_VERSION or payload.get("request") != fingerprint:
        raise LedgerError("ATTACHMENT_CONTINUATION_MISMATCH", "continuation_cursor 不属于当前读取请求")
    if not 0 <= offset <= unit_count:
        raise LedgerError("ATTACHMENT_CONTINUATION_INVALID", "continuation_cursor 位置越界")
    return offset


def _parse_page_range(value: str) -> list[int]:
    pages: list[int] = []
    for part in value.split(","):
        token = part.strip()
        if not token:
            continue
        if "-" not in token:
            pages.append(int(token))
            continue
        start_text, end_text = token.split("-", 1)
        start, end = int(start_text), int(end_text)
        if start > end:
            raise ValueError(value)
        pages.extend(range(start, end + 1))
    return pages


class VisualAttachmentReader:
    def __init__(
        self,
        registry: AttachmentRegistry,
        materializer: AttachmentMaterializer,
        derived_root: str | Path,
        office_converter: LocalOfficeConverter | None = None,
        wxgf_decoder: WxgfDecoder | None = None,
    ) -> None:
        self.registry = registry
        self.materializer = materializer
        self.derived_root = Path(derived_root).resolve()
        self.office_converter = office_converter
        self.wxgf_decoder = wxgf_decoder

    @staticmethod
    def _budget(images: int, pixels: int, bytes_: int) -> ReadBudget:
        if not 1 <= images <= MAX_RETURN_IMAGES:
            raise LedgerError("ATTACHMENT_BUDGET_INVALID", f"max_images 必须为 1..{MAX_RETURN_IMAGES}")
        if not 1 <= pixels <= MAX_RETURN_PIXELS:
            raise LedgerError("ATTACHMENT_BUDGET_INVALID", f"max_pixels 必须为 1..{MAX_RETURN_PIXELS}")
        if not 1 <= bytes_ <= MAX_RETURN_BYTES:
            raise LedgerError("ATTACHMENT_BUDGET_INVALID", f"max_bytes 必须为 1..{MAX_RETURN_BYTES}")
        return ReadBudget(images=images, pixels=pixels, bytes=bytes_)

    @staticmethod
    def _selected_pages(
        attachment_ref: str,
        page_count: int,
        pages: dict[str, list[int]],
        page_ranges: dict[str, list[str]],
    ) -> list[int]:
        requested: list[int] = []
        requested.extend(pages.get(attachment_ref, []))
        for value in page_ranges.get(attachment_ref, []):
            try:
                requested.extend(_parse_page_range(value))
            except (TypeError, ValueError) as error:
                raise LedgerError("ATTACHMENT_PAGE_RANGE_INVALID", f"页码范围无效：{value}") from error
        if not requested:
            return list(range(1, page_count + 1))
        if len(requested) != len(set(requested)):
            raise LedgerError("ATTACHMENT_PAGE_DUPLICATE", "pages/page_ranges 含重复页码")
        if any(page < 1 or page > page_count for page in requested):
            raise LedgerError("ATTACHMENT_PAGE_OUT_OF_RANGE", "请求页码超出附件页数")
        return requested

    def _pdf_units(
        self,
        attachment_ref: str,
        source_path: Path,
        source_sha256: str,
        source_mime_type: str,
        pages: dict[str, list[int]],
        page_ranges: dict[str, list[str]],
        conversion: dict[str, Any] | None = None,
    ) -> list[VisualUnit]:
        try:
            document = pdfium.PdfDocument(source_path)
            page_count = len(document)
            document.close()
        except Exception as error:
            message = str(error).lower()
            code = "ATTACHMENT_PDF_ENCRYPTED" if "password" in message else "ATTACHMENT_PDF_CORRUPT"
            raise LedgerError(code, "PDF 无法读取；文件可能损坏或已加密") from error
        if page_count < 1:
            raise LedgerError("ATTACHMENT_PDF_CORRUPT", "PDF 没有可读取页面")
        return [
            VisualUnit(
                attachment_ref=attachment_ref,
                source_path=source_path,
                source_sha256=source_sha256,
                source_mime_type=source_mime_type,
                page_number=page_number,
                page_count=page_count,
                source_kind="pdf_page" if conversion is None else "office_pdf_page",
                conversion=conversion,
            )
            for page_number in self._selected_pages(
                attachment_ref, page_count, pages, page_ranges
            )
        ]

    def _units(
        self,
        subscription_id: str,
        attachment_refs: list[str],
        pages: dict[str, list[int]],
        page_ranges: dict[str, list[str]],
    ) -> tuple[list[VisualUnit], list[dict[str, Any]]]:
        if not attachment_refs:
            raise LedgerError("ATTACHMENT_REFS_REQUIRED", "attachment_refs 不能为空")
        if len(attachment_refs) != len(set(attachment_refs)):
            raise LedgerError("ATTACHMENT_REF_DUPLICATE", "attachment_refs 不允许重复")
        unknown_page_refs = (set(pages) | set(page_ranges)) - set(attachment_refs)
        if unknown_page_refs:
            raise LedgerError("ATTACHMENT_PAGE_REF_UNKNOWN", "页码参数含未请求的 attachment_ref")
        units: list[VisualUnit] = []
        originals: list[dict[str, Any]] = []
        for attachment_ref in attachment_refs:
            attachment, transfer = self.registry.ensure_downloaded(
                subscription_id, attachment_ref, self.materializer
            )
            source_path = Path(str(transfer["local_path"])).resolve()
            source_sha256 = str(transfer["sha256"])
            mime_type = str(transfer.get("mime_type") or "application/octet-stream")
            suffix = source_path.suffix.lower()
            original = {
                "attachment_ref": attachment_ref,
                "event_id": attachment["event_id"],
                "kind": attachment["kind"],
                "mime_type": mime_type,
                "byte_count": transfer["byte_count"],
                "sha256": source_sha256,
                "width": transfer.get("width"),
                "height": transfer.get("height"),
                "local_path": str(source_path),
            }
            originals.append(original)
            if attachment["kind"] == "image" and _starts_with(source_path, WXGF_MAGIC):
                if self.wxgf_decoder is None:
                    raise LedgerError("ATTACHMENT_WXGF_DECODER_MISSING", "wxgf 解码器未配置")
                conversion = self.wxgf_decoder.convert(attachment_ref, source_path, source_sha256)
                originals[-1]["storage_format"] = "wxgf"
                originals[-1]["conversion"] = {
                    key: value for key, value in conversion.items() if key != "derived_path"
                }
                requested_pages = self._selected_pages(attachment_ref, 1, pages, page_ranges)
                if requested_pages != [1]:
                    raise LedgerError("ATTACHMENT_PAGE_OUT_OF_RANGE", "普通图片只有第 1 页")
                units.append(
                    VisualUnit(
                        attachment_ref=attachment_ref,
                        source_path=Path(str(conversion["derived_path"])),
                        source_sha256=str(conversion["derived_sha256"]),
                        source_mime_type=str(conversion["derived_mime_type"]),
                        page_number=None,
                        page_count=1,
                        source_kind="wxgf_hevc_image",
                        conversion={
                            **conversion,
                            "original_attachment_sha256": source_sha256,
                        },
                    )
                )
            elif mime_type.startswith("image/"):
                requested_pages = self._selected_pages(attachment_ref, 1, pages, page_ranges)
                if requested_pages != [1]:
                    raise LedgerError("ATTACHMENT_PAGE_OUT_OF_RANGE", "普通图片只有第 1 页")
                units.append(
                    VisualUnit(
                        attachment_ref=attachment_ref,
                        source_path=source_path,
                        source_sha256=source_sha256,
                        source_mime_type=mime_type,
                        page_number=None,
                        page_count=1,
                        source_kind="image",
                    )
                )
            elif mime_type == "application/pdf" or suffix == ".pdf":
                units.extend(
                    self._pdf_units(
                        attachment_ref,
                        source_path,
                        source_sha256,
                        "application/pdf",
                        pages,
                        page_ranges,
                    )
                )
            elif suffix in {".docx", ".pptx"}:
                if self.office_converter is None:
                    raise LedgerError("ATTACHMENT_OFFICE_CONVERTER_MISSING", "Office 转换器未配置")
                conversion = self.office_converter.convert(
                    attachment_ref, source_path, source_sha256
                )
                originals[-1]["conversion"] = {
                    key: value
                    for key, value in conversion.items()
                    if key != "derived_pdf_path"
                }
                units.extend(
                    self._pdf_units(
                        attachment_ref,
                        Path(conversion["derived_pdf_path"]),
                        str(conversion["derived_pdf_sha256"]),
                        "application/pdf",
                        pages,
                        page_ranges,
                        conversion=conversion,
                    )
                )
            elif suffix in {".xlsx", ".xlsm", ".xlsb"}:
                raise LedgerError(
                    "ATTACHMENT_XLSX_VISUAL_UNSUPPORTED",
                    "XLSX 原件已保存，但不自动分页；请交给 spreadsheet 工具读取",
                )
            else:
                raise LedgerError(
                    "ATTACHMENT_VISUAL_UNSUPPORTED",
                    f"附件原件已保存，但 {mime_type} 不支持视觉读取",
                )
        return units, originals

    def _page_cache(self, unit: VisualUnit) -> Path:
        renderer_version = str(getattr(pdfium, "__version__", "pypdfium2"))
        key = hashlib.sha256(
            f"{unit.attachment_ref}\0{unit.source_sha256}\0{renderer_version}\0"
            f"{PDF_RENDER_DPI}\0{unit.page_number}".encode("utf-8")
        ).hexdigest()
        return self.derived_root / "pages" / key[:2] / f"{key}.png"

    def _render_pdf_page(self, unit: VisualUnit) -> Image.Image:
        cache = self._page_cache(unit)
        if cache.is_file():
            try:
                cached = Image.open(cache)
                cached.load()
                return cached.convert("RGBA") if "A" in cached.getbands() else cached.convert("RGB")
            except (OSError, UnidentifiedImageError):
                cache.unlink(missing_ok=True)
        try:
            document = pdfium.PdfDocument(unit.source_path)
            page = document[int(unit.page_number) - 1]
            width_points, height_points = page.get_size()
            scale = PDF_RENDER_DPI / 72
            pixel_count = width_points * height_points * scale * scale
            if pixel_count > MAX_PDF_RENDER_PIXELS:
                scale *= math.sqrt(MAX_PDF_RENDER_PIXELS / pixel_count)
            bitmap = page.render(scale=scale)
            image = bitmap.to_pil().convert("RGB")
            bitmap.close()
            page.close()
            document.close()
        except Exception as error:
            raise LedgerError("ATTACHMENT_PDF_RENDER_FAILED", "PDF 页面渲染失败") from error
        cache.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache.with_suffix(f".{os.getpid()}.tmp")
        image.save(temporary, format="PNG", optimize=True)
        temporary.replace(cache)
        return image

    @staticmethod
    def _open_image(unit: VisualUnit) -> tuple[Image.Image, int, int]:
        try:
            image = Image.open(unit.source_path)
            image.load()
            image = ImageOps.exif_transpose(image)
        except (OSError, UnidentifiedImageError) as error:
            raise LedgerError("ATTACHMENT_IMAGE_DECODE_FAILED", "图片原件无法解码") from error
        return image, image.width, image.height

    @staticmethod
    def _preview_format(image: Image.Image, source_mime_type: str) -> tuple[str, str]:
        has_alpha = "A" in image.getbands() or image.mode in {"LA", "PA"}
        if has_alpha or source_mime_type == "image/png":
            return "PNG", "image/png"
        return "JPEG", "image/jpeg"

    @staticmethod
    def _resize_for_limits(image: Image.Image, max_pixels: int, max_edge: int) -> Image.Image:
        scale = min(
            1.0,
            max_edge / max(image.width, image.height),
            math.sqrt(max_pixels / max(1, image.width * image.height)),
        )
        if scale >= 1:
            return image.copy()
        size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        return image.resize(size, Image.Resampling.LANCZOS)

    def _encode_preview(
        self,
        image: Image.Image,
        source_mime_type: str,
        remaining_pixels: int,
        remaining_bytes: int,
    ) -> tuple[bytes, str, int, int]:
        candidate = self._resize_for_limits(image, remaining_pixels, PREVIEW_MAX_EDGE)
        while True:
            output_format, mime_type = self._preview_format(candidate, source_mime_type)
            buffer = io.BytesIO()
            if output_format == "PNG":
                candidate.save(buffer, format="PNG", optimize=True)
            else:
                candidate.convert("RGB").save(
                    buffer,
                    format="JPEG",
                    quality=JPEG_PREVIEW_QUALITY,
                    optimize=True,
                    subsampling=0,
                )
            data = buffer.getvalue()
            if _wire_size(data) <= remaining_bytes:
                return data, mime_type, candidate.width, candidate.height
            if max(candidate.size) <= MIN_PREVIEW_EDGE:
                raise LedgerError(
                    "ATTACHMENT_IMAGE_EXCEEDS_BUDGET",
                    "图片即使缩放到最小高质量预览仍超过返回预算；原件已保留",
                )
            scale = min(0.85, math.sqrt(remaining_bytes / max(1, _wire_size(data))) * 0.95)
            target_long_edge = max(MIN_PREVIEW_EDGE, round(max(candidate.size) * scale))
            aspect_scale = target_long_edge / max(candidate.size)
            size = (
                max(1, round(candidate.width * aspect_scale)),
                max(1, round(candidate.height * aspect_scale)),
            )
            if size == candidate.size:
                raise LedgerError("ATTACHMENT_IMAGE_EXCEEDS_BUDGET", "图片预览无法满足返回预算")
            candidate = candidate.resize(size, Image.Resampling.LANCZOS)

    def _render_unit(
        self,
        unit: VisualUnit,
        mode: str,
        remaining_pixels: int,
        remaining_bytes: int,
    ) -> tuple[bytes, str, dict[str, Any]]:
        if unit.page_number is None:
            image, original_width, original_height = self._open_image(unit)
            source_bytes = unit.source_path.read_bytes()
            direct_allowed = (
                unit.source_mime_type in {"image/png", "image/jpeg", "image/webp", "image/gif"}
                and len(source_bytes) <= DIRECT_ORIGINAL_MAX_BYTES
                and original_width * original_height <= DIRECT_ORIGINAL_MAX_PIXELS
                and original_width * original_height <= remaining_pixels
                and _wire_size(source_bytes) <= remaining_bytes
            )
            if mode == "original" and not direct_allowed:
                raise LedgerError(
                    "ATTACHMENT_ORIGINAL_EXCEEDS_BUDGET",
                    "显式原图模式超过硬预算；原件已保留，请缩小范围或使用 auto",
                )
            if direct_allowed:
                data = source_bytes
                returned_mime = unit.source_mime_type
                returned_width, returned_height = original_width, original_height
                scaled = transcoded = False
            else:
                data, returned_mime, returned_width, returned_height = self._encode_preview(
                    image, unit.source_mime_type, remaining_pixels, remaining_bytes
                )
                scaled = (returned_width, returned_height) != (original_width, original_height)
                transcoded = returned_mime != unit.source_mime_type
        else:
            image = self._render_pdf_page(unit)
            original_width, original_height = image.size
            data, returned_mime, returned_width, returned_height = self._encode_preview(
                image, "image/png", remaining_pixels, remaining_bytes
            )
            scaled = (returned_width, returned_height) != (original_width, original_height)
            transcoded = False
        metadata = {
            "attachment_ref": unit.attachment_ref,
            "unit_id": unit.stable_id,
            "page_number": unit.page_number,
            "page_count": unit.page_count,
            "source_kind": unit.source_kind,
            "original_mime_type": unit.source_mime_type,
            "original_width": original_width,
            "original_height": original_height,
            "original_sha256": unit.source_sha256,
            "original_path": str(unit.source_path),
            "returned_mime_type": returned_mime,
            "returned_width": returned_width,
            "returned_height": returned_height,
            "returned_bytes": len(data),
            "returned_wire_bytes": _wire_size(data),
            "returned_sha256": _sha256_bytes(data),
            "scaled": scaled,
            "transcoded": transcoded,
        }
        if unit.conversion is not None:
            metadata["conversion"] = {
                key: value
                for key, value in unit.conversion.items()
                if key != "derived_pdf_path"
            }
        return data, returned_mime, metadata

    def cleanup_expired(
        self,
        max_age_seconds: int = DERIVED_CACHE_TTL_SECONDS,
        materialized_max_age_seconds: int = ATTACHMENT_MATERIALIZATION_TTL_SECONDS,
    ) -> dict[str, int]:
        threshold = time.time() - max_age_seconds
        page_root = self.derived_root / "pages"
        removed_pages = 0
        if page_root.is_dir():
            for page in page_root.rglob("*.png"):
                if page.is_file() and page.stat().st_mtime < threshold:
                    page.unlink()
                    removed_pages += 1
        removed_office = (
            self.office_converter.cleanup_expired(max_age_seconds)
            if self.office_converter is not None
            else 0
        )
        removed_wxgf = (
            self.wxgf_decoder.cleanup_expired(max_age_seconds)
            if self.wxgf_decoder is not None
            else 0
        )
        removed_intake = self.registry.cleanup_expired(materialized_max_age_seconds)
        return {
            "page_cache_files": removed_pages,
            "office_cache_entries": removed_office,
            "wxgf_cache_entries": removed_wxgf,
            **removed_intake,
        }

    def read(
        self,
        subscription_id: str,
        attachment_refs: list[str],
        *,
        pages: dict[str, list[int]] | None = None,
        page_ranges: dict[str, list[str]] | None = None,
        continuation_cursor: str = "",
        mode: str = "auto",
        max_images: int = MAX_RETURN_IMAGES,
        max_pixels: int = MAX_RETURN_PIXELS,
        max_bytes: int = MAX_RETURN_BYTES,
    ) -> CallToolResult:
        if mode not in {"auto", "original"}:
            raise LedgerError("ATTACHMENT_READ_MODE_INVALID", "mode 必须为 auto 或 original")
        self.cleanup_expired()
        budget = self._budget(max_images, max_pixels, max_bytes)
        page_map = pages or {}
        range_map = page_ranges or {}
        units, originals = self._units(
            subscription_id, attachment_refs, page_map, range_map
        )
        fingerprint_input = {
            "subscription_id": subscription_id,
            "attachment_refs": attachment_refs,
            "pages": page_map,
            "page_ranges": range_map,
            "mode": mode,
            "units": [
                {
                    "id": unit.stable_id,
                    "sha256": unit.source_sha256,
                    "page_count": unit.page_count,
                }
                for unit in units
            ],
        }
        fingerprint = hashlib.sha256(
            json.dumps(fingerprint_input, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        offset = _cursor_decode(continuation_cursor, fingerprint, len(units))
        returned: list[dict[str, Any]] = []
        image_blocks: list[ImageContent] = []
        used_pixels = used_bytes = 0
        next_offset = offset
        for unit in units[offset:]:
            if len(returned) >= budget.images:
                break
            remaining_pixels = budget.pixels - used_pixels
            remaining_bytes = budget.bytes - used_bytes
            if remaining_pixels < 1 or remaining_bytes < 1:
                break
            data, mime_type, metadata = self._render_unit(
                unit, mode, remaining_pixels, remaining_bytes
            )
            block_pixels = metadata["returned_width"] * metadata["returned_height"]
            block_bytes = metadata["returned_wire_bytes"]
            if block_pixels > remaining_pixels or block_bytes > remaining_bytes:
                raise LedgerError("ATTACHMENT_BUDGET_INTERNAL", "附件渲染结果超过已计算预算")
            returned.append(metadata)
            image_blocks.append(
                ImageContent(
                    type="image",
                    data=base64.b64encode(data).decode("ascii"),
                    mimeType=mime_type,
                    _meta=metadata,
                )
            )
            used_pixels += block_pixels
            used_bytes += block_bytes
            next_offset += 1
        if next_offset == offset and offset < len(units):
            raise LedgerError(
                "ATTACHMENT_BUDGET_EMPTY",
                "当前预算无法返回下一张图片或页面；原件已保留",
            )
        remaining = [unit.stable_id for unit in units[next_offset:]]
        next_cursor = _cursor_encode(fingerprint, next_offset) if remaining else None
        manifest = {
            "subscription_id": subscription_id,
            "request_fingerprint": fingerprint,
            "originals": originals,
            "returned": returned,
            "remaining": remaining,
            "continuation_cursor": next_cursor,
            "budget": {
                "max_images": budget.images,
                "max_pixels": budget.pixels,
                "max_bytes": budget.bytes,
                "used_images": len(returned),
                "used_pixels": used_pixels,
                "used_bytes": used_bytes,
            },
        }
        return CallToolResult(
            content=[
                TextContent(
                    type="text",
                    text=json.dumps(manifest, ensure_ascii=False, sort_keys=True),
                ),
                *image_blocks,
            ],
            structuredContent=manifest,
            isError=False,
        )
