import json
import math
import os
import sys
import tempfile
import traceback
from typing import Any, Dict, Iterable, List, Optional, Tuple

import fitz


Rect = Dict[str, float]
InspectElement = Dict[str, Any]
PageStructure = Dict[str, Any]
InspectIssue = Dict[str, Any]


def _rect_from_bbox(bbox: Iterable[float]) -> Rect:
    x0, y0, x1, y1 = [float(value) for value in bbox]
    return {
        "x0": min(x0, x1),
        "y0": min(y0, y1),
        "x1": max(x0, x1),
        "y1": max(y0, y1),
    }


def _fitz_rect(rect: Rect) -> fitz.Rect:
    return fitz.Rect(rect["x0"], rect["y0"], rect["x1"], rect["y1"])


def _rect_area(rect: Rect) -> float:
    return max(0.0, rect["x1"] - rect["x0"]) * max(0.0, rect["y1"] - rect["y0"])


def _overlap_rect(a: Rect, b: Rect) -> Optional[Rect]:
    rect = {
        "x0": max(a["x0"], b["x0"]),
        "y0": max(a["y0"], b["y0"]),
        "x1": min(a["x1"], b["x1"]),
        "y1": min(a["y1"], b["y1"]),
    }
    return rect if _rect_area(rect) > 0 else None


def _overlap_percent(a: Rect, b: Rect) -> float:
    overlap = _overlap_rect(a, b)
    if overlap is None:
        return 0.0
    smaller = min(_rect_area(a), _rect_area(b))
    return (100.0 * _rect_area(overlap) / smaller) if smaller > 0 else 0.0


def _union_rect(rects: Iterable[Rect]) -> Rect:
    items = list(rects)
    if not items:
        return {"x0": 0.0, "y0": 0.0, "x1": 0.0, "y1": 0.0}
    return {
        "x0": min(rect["x0"] for rect in items),
        "y0": min(rect["y0"] for rect in items),
        "x1": max(rect["x1"] for rect in items),
        "y1": max(rect["y1"] for rect in items),
    }


def _clamp_rect(rect: Rect, bounds: Rect) -> Rect:
    return {
        "x0": max(bounds["x0"], min(rect["x0"], bounds["x1"])),
        "y0": max(bounds["y0"], min(rect["y0"], bounds["y1"])),
        "x1": max(bounds["x0"], min(rect["x1"], bounds["x1"])),
        "y1": max(bounds["y0"], min(rect["y1"], bounds["y1"])),
    }


def _expand_rect(rect: Rect, page_bounds: Rect, scale: float) -> Rect:
    if not math.isfinite(scale) or scale <= 1:
        return _clamp_rect(rect, page_bounds)

    width = rect["x1"] - rect["x0"]
    height = rect["y1"] - rect["y0"]
    pad_x = (width * scale - width) / 2.0
    pad_y = (height * scale - height) / 2.0
    expanded = {
        "x0": rect["x0"] - pad_x,
        "y0": rect["y0"] - pad_y,
        "x1": rect["x1"] + pad_x,
        "y1": rect["y1"] + pad_y,
    }
    return _clamp_rect(expanded, page_bounds)


def _as_page_number(value: Any, default: Optional[int] = None) -> Optional[int]:
    if value is None:
        return default
    try:
        page = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"page must be an integer, got {value!r}") from exc
    if page < 1:
        raise ValueError(f"page must be >= 1, got {page}")
    return page


def _open_pdf(pdf_path: str) -> fitz.Document:
    if not pdf_path:
        raise ValueError("pdfPath is required")
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF file does not exist: {pdf_path}")

    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:
        raise ValueError(f"failed to open PDF: {exc}") from exc

    if doc.page_count == 0:
        doc.close()
        raise ValueError("PDF has no pages")
    if not doc.is_pdf:
        doc.close()
        raise ValueError(f"file is not a PDF: {pdf_path}")
    return doc


def _page_indices(doc: fitz.Document, page_num: Optional[int]) -> List[int]:
    if page_num is None:
        return list(range(doc.page_count))
    if page_num > doc.page_count:
        raise IndexError(f"page {page_num} is out of range; PDF has {doc.page_count} page(s)")
    return [page_num - 1]


def _text_from_block(block: Dict[str, Any]) -> Tuple[str, Optional[float], Dict[str, Any]]:
    lines = block.get("lines", [])
    chunks: List[str] = []
    sizes: List[float] = []
    fonts: List[str] = []

    for line in lines:
        span_texts: List[str] = []
        for span in line.get("spans", []):
            text = span.get("text", "")
            if text:
                span_texts.append(text)
            size = span.get("size")
            if isinstance(size, (int, float)):
                sizes.append(float(size))
            font = span.get("font")
            if font and font not in fonts:
                fonts.append(str(font))
        line_text = "".join(span_texts).strip()
        if line_text:
            chunks.append(line_text)

    font_size = max(sizes) if sizes else None
    metadata: Dict[str, Any] = {
        "lineCount": len(lines),
        "spanCount": sum(len(line.get("spans", [])) for line in lines),
    }
    if sizes:
        metadata["minFontSize"] = min(sizes)
        metadata["maxFontSize"] = max(sizes)
    if fonts:
        metadata["fonts"] = fonts
    return "\n".join(chunks), font_size, metadata


def _page_structure(doc: fitz.Document, page_index: int) -> PageStructure:
    page = doc[page_index]
    page_rect = page.rect
    raw = page.get_text("dict")
    elements: List[InspectElement] = []

    for z_order, block in enumerate(raw.get("blocks", [])):
        bbox = block.get("bbox")
        if not bbox:
            continue

        block_type = block.get("type")
        bounds = _rect_from_bbox(bbox)
        page_number = page_index + 1

        if block_type == 0:
            text, font_size, metadata = _text_from_block(block)
            if not text:
                continue
            element: InspectElement = {
                "type": "text",
                "name": f"text-{page_number}-{z_order}",
                "text": text,
                "bounds": bounds,
                "zOrder": z_order,
                "fontSize": font_size,
                "page": page_number,
                "source": "pdf",
                "metadata": metadata,
            }
        elif block_type == 1:
            metadata = {
                "width": block.get("width"),
                "height": block.get("height"),
                "extension": block.get("ext"),
                "colorspace": block.get("colorspace"),
                "bitsPerComponent": block.get("bpc"),
                "xResolution": block.get("xres"),
                "yResolution": block.get("yres"),
            }
            element = {
                "type": "image",
                "name": f"image-{page_number}-{z_order}",
                "text": "",
                "bounds": bounds,
                "zOrder": z_order,
                "page": page_number,
                "source": "pdf",
                "metadata": {key: value for key, value in metadata.items() if value is not None},
            }
        else:
            continue

        elements.append(element)

    return {
        "page": page_index + 1,
        "dimensions": {"width": float(page_rect.width), "height": float(page_rect.height)},
        "elements": elements,
        "source": "pdf",
        "metadata": {"rotation": page.rotation},
    }


def extract_structure(pdf_path: str, page_num: Optional[int] = None) -> List[PageStructure]:
    doc = _open_pdf(pdf_path)
    try:
        return [_page_structure(doc, index) for index in _page_indices(doc, page_num)]
    finally:
        doc.close()


def _overflow_sides(bounds: Rect, page_bounds: Rect) -> List[str]:
    sides: List[str] = []
    if bounds["x0"] < page_bounds["x0"]:
        sides.append("left")
    if bounds["x1"] > page_bounds["x1"]:
        sides.append("right")
    if bounds["y0"] < page_bounds["y0"]:
        sides.append("top")
    if bounds["y1"] > page_bounds["y1"]:
        sides.append("bottom")
    return sides


def _overlap_severity(a: InspectElement, b: InspectElement, percent: float) -> str:
    types = {a.get("type"), b.get("type")}
    if "text" in types and percent >= 15:
        return "error"
    if "text" in types:
        return "warning"
    return "info" if percent < 25 else "warning"


def _issue_screenshot(
    pdf_path: str,
    issue: InspectIssue,
    scale: float,
    output_dir: str,
    index: int,
) -> str:
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f"pdf-issue-page{issue['page']}-{index}.png")
    region_screenshot(pdf_path, issue["page"], issue["bounds"], scale, output_path)
    return output_path


def detect_issues(
    pdf_path: str,
    page_num: Optional[int] = None,
    checks: Optional[List[str]] = None,
    auto_screenshot: bool = False,
    screenshot_dir: Optional[str] = None,
    screenshot_scale: float = 1.4,
    thresholds: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    active_checks = set(checks or ["overlap", "overflow"])
    thresholds = thresholds or {}
    structures = extract_structure(pdf_path, page_num)
    issues: List[InspectIssue] = []
    min_overlap_area = 4.0
    min_overlap_percent = 1.0

    for structure in structures:
        page = structure["page"]
        dimensions = structure["dimensions"]
        page_bounds = {"x0": 0.0, "y0": 0.0, "x1": dimensions["width"], "y1": dimensions["height"]}
        elements = structure["elements"]

        if "overflow" in active_checks:
            for element in elements:
                sides = _overflow_sides(element["bounds"], page_bounds)
                if not sides:
                    continue
                issues.append(
                    {
                        "type": "overflow",
                        "severity": "warning",
                        "page": page,
                        "description": f"{element['name']} overflows page bounds on {', '.join(sides)}",
                        "elements": [element],
                        "bounds": _union_rect([element["bounds"]]),
                        "metadata": {"sides": sides, "pageBounds": page_bounds},
                    }
                )

        if "overlap" in active_checks:
            for left_index, left in enumerate(elements):
                for right in elements[left_index + 1 :]:
                    overlap = _overlap_rect(left["bounds"], right["bounds"])
                    if overlap is None or _rect_area(overlap) < min_overlap_area:
                        continue
                    percent = _overlap_percent(left["bounds"], right["bounds"])
                    if percent < min_overlap_percent:
                        continue
                    union = _union_rect([left["bounds"], right["bounds"]])
                    issues.append(
                        {
                            "type": "overlap",
                            "severity": _overlap_severity(left, right, percent),
                            "page": page,
                            "description": f"{left['name']} overlaps {right['name']} by {percent:.1f}%",
                            "elements": [left, right],
                            "bounds": union,
                            "metadata": {
                                "overlapBounds": overlap,
                                "overlapArea": _rect_area(overlap),
                                "overlapPercent": percent,
                            },
                        }
                    )

        if "readability" in active_checks:
            min_font_threshold = float(thresholds.get("smallFontPt") or 7.0)
            for element in elements:
                if element.get("type") != "text":
                    continue
                metadata = element.get("metadata") or {}
                font_size = metadata.get("minFontSize") or element.get("fontSize")
                if not isinstance(font_size, (int, float)) or float(font_size) >= min_font_threshold:
                    continue
                issues.append(
                    {
                        "type": "small-font",
                        "severity": "warning",
                        "page": page,
                        "description": f"{element['name']} font size {float(font_size):.1f}pt is below {min_font_threshold:.1f}pt",
                        "elements": [element],
                        "bounds": _union_rect([element["bounds"]]),
                        "metadata": {
                            "check": "small-font",
                            "fontSize": float(font_size),
                            "threshold": min_font_threshold,
                            "source": "pdf",
                        },
                    }
                )

    if auto_screenshot and issues:
        output_dir = screenshot_dir or tempfile.mkdtemp(prefix="pdf-inspector-")
        for index, issue in enumerate(issues, start=1):
            issue["screenshotPath"] = _issue_screenshot(pdf_path, issue, screenshot_scale, output_dir, index)

    warnings = sum(1 for issue in issues if issue.get("severity") == "warning")
    errors = sum(1 for issue in issues if issue.get("severity") == "error")
    return {
        "summary": {
            "pages": len(structures),
            "elements": sum(len(structure["elements"]) for structure in structures),
            "issues": len(issues),
            "warnings": warnings,
            "errors": errors,
        },
        "issues": issues,
        "structure": structures,
    }


def region_screenshot(
    pdf_path: str,
    page_num: int,
    rect: Rect,
    scale: float = 1.0,
    output_path: Optional[str] = None,
) -> Dict[str, Any]:
    doc = _open_pdf(pdf_path)
    try:
        page_number = _as_page_number(page_num)
        if page_number is None:
            raise ValueError("page is required")
        page_index = _page_indices(doc, page_number)[0]
        page = doc[page_index]
        page_bounds = {"x0": 0.0, "y0": 0.0, "x1": float(page.rect.width), "y1": float(page.rect.height)}
        clipped = _expand_rect(_rect_from_bbox([rect["x0"], rect["y0"], rect["x1"], rect["y1"]]), page_bounds, scale)
        if _rect_area(clipped) <= 0:
            raise ValueError(f"rect has no drawable area after clipping: {rect!r}")

        target_path = output_path or os.path.join(tempfile.mkdtemp(prefix="pdf-inspector-"), "region.png")
        os.makedirs(os.path.dirname(os.path.abspath(target_path)), exist_ok=True)
        pixmap = page.get_pixmap(clip=_fitz_rect(clipped), dpi=200, alpha=False)
        pixmap.save(target_path)
        return {
            "path": target_path,
            "page": page_number,
            "rect": clipped,
            "scale": scale,
            "width": pixmap.width,
            "height": pixmap.height,
        }
    finally:
        doc.close()


def search_text_region(
    pdf_path: str,
    target: str,
    page_num: Optional[int] = None,
) -> Dict[str, Any]:
    if not target or not str(target).strip():
        raise ValueError("target is required")

    doc = _open_pdf(pdf_path)
    try:
        target_text = str(target).strip()
        for page_index in _page_indices(doc, page_num):
            page = doc[page_index]
            matches = [_rect_from_bbox(rect) for rect in page.search_for(target_text)]
            if not matches:
                continue
            return {
                "found": True,
                "target": target_text,
                "page": page_index + 1,
                "rect": _union_rect(matches),
                "matches": len(matches),
            }

        return {
            "found": False,
            "target": target_text,
            "page": page_num,
            "rect": None,
            "matches": 0,
        }
    finally:
        doc.close()


def _params(payload: Dict[str, Any]) -> Dict[str, Any]:
    params = dict(payload.get("params") or {})
    for key, value in payload.items():
        if key not in {"action", "params"} and key not in params:
            params[key] = value
    return params


def _dispatch(payload: Dict[str, Any]) -> Any:
    action = payload.get("action")
    params = _params(payload)
    pdf_path = params.get("pdfPath") or params.get("pdf_path") or params.get("path")
    page_num = _as_page_number(params.get("page") or params.get("pageNum") or params.get("page_num"))

    if action == "extract_structure":
        return extract_structure(pdf_path, page_num)
    if action == "detect_issues":
        return detect_issues(
            pdf_path,
            page_num,
            checks=params.get("checks"),
            auto_screenshot=bool(params.get("autoScreenshot") or params.get("auto_screenshot")),
            screenshot_dir=params.get("screenshotDir") or params.get("screenshot_dir") or params.get("outputDir"),
            screenshot_scale=float(params.get("scale") or params.get("screenshotScale") or 1.4),
            thresholds=params.get("thresholds"),
        )
    if action == "region_screenshot":
        rect = params.get("rect")
        if not isinstance(rect, dict):
            raise ValueError("rect is required for region_screenshot")
        output_path = params.get("outputPath") or params.get("output_path")
        return region_screenshot(
            pdf_path,
            page_num if page_num is not None else 1,
            rect,
            float(params.get("scale") or 1.0),
            output_path,
        )
    if action == "search_text_region":
        return search_text_region(
            pdf_path,
            str(params.get("target") or ""),
            page_num,
        )

    raise ValueError(f"unknown action: {action!r}")


def main() -> int:
    try:
        stdin_buffer = getattr(sys.stdin, "buffer", None)
        if stdin_buffer is not None:
            raw = stdin_buffer.read().decode("utf-8-sig")
        else:
            raw = sys.stdin.read().lstrip("\ufeff")
        if not raw.strip():
            raise ValueError("stdin JSON payload is required")
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("stdin JSON payload must be an object")
        result = _dispatch(payload)
        print(json.dumps({"ok": True, "action": payload.get("action"), "result": result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "type": exc.__class__.__name__,
                        "message": str(exc),
                        "traceback": traceback.format_exc(),
                    },
                },
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
