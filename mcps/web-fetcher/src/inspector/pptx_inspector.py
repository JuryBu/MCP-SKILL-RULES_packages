import json
import os
import sys
import traceback
from typing import Any, Dict, List, Optional

from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx import Presentation

from inspection_geometry import BoundedIssues, IDENTITY, PairBudget, contains, evidence, local_peer_groups, transform_rect
from pptx_evidence import assign_containers, paint_metadata, shape_transform, text_metadata


Rect = Dict[str, float]
SMALL_FONT_THRESHOLD_PT = 7.0
TITLE_TOP_VARIANCE_THRESHOLD_EMU = 180000.0
SIZE_VARIANCE_THRESHOLD_RATIO = 0.12
GAP_VARIANCE_THRESHOLD_RATIO = 0.35


def _rect_from_shape(shape: Any) -> Rect:
    return {
        "x0": float(shape.left),
        "y0": float(shape.top),
        "x1": float(shape.left + shape.width),
        "y1": float(shape.top + shape.height),
    }


def _rect_area(rect: Rect) -> float:
    return max(0.0, rect["x1"] - rect["x0"]) * max(0.0, rect["y1"] - rect["y0"])


def _overlap_area(a: Rect, b: Rect) -> float:
    width = min(a["x1"], b["x1"]) - max(a["x0"], b["x0"])
    height = min(a["y1"], b["y1"]) - max(a["y0"], b["y0"])
    return max(0.0, width) * max(0.0, height)


def _overlap_percent(a: Rect, b: Rect) -> float:
    smaller = min(_rect_area(a), _rect_area(b))
    if smaller <= 0:
        return 0.0
    return (_overlap_area(a, b) / smaller) * 100


def _shape_text(shape: Any) -> str:
    if not getattr(shape, "has_text_frame", False):
        return ""
    return (getattr(shape, "text", "") or "").strip()


def _shape_kind(shape: Any, text: str) -> str:
    if text:
        return "text"
    if getattr(shape, "shape_type", None) == MSO_SHAPE_TYPE.PICTURE:
        return "image"
    if getattr(shape, "shape_type", None) == MSO_SHAPE_TYPE.GROUP:
        return "group"
    if getattr(shape, "shape_type", None) == MSO_SHAPE_TYPE.TABLE:
        return "table"
    return "shape"


def _font_size(shape: Any) -> Optional[float]:
    if not getattr(shape, "has_text_frame", False):
        return None
    sizes = []
    for paragraph in shape.text_frame.paragraphs:
        if paragraph.font.size:
            sizes.append(float(paragraph.font.size.pt))
        for run in paragraph.runs:
            if run.font.size:
                sizes.append(float(run.font.size.pt))
    return max(sizes) if sizes else None


def _text_clipping_sides(element: Dict[str, Any]) -> List[str]:
    return list(element.get("metadata", {}).get("estimatedOverflowSides", []))


def _element_from_shape(shape: Any, z_order: int, page: int, parent=IDENTITY, parent_id=None) -> Dict[str, Any]:
    text = _shape_text(shape)
    kind = _shape_kind(shape, text)
    local_bounds, matrix, _ = shape_transform(shape, parent)
    element: Dict[str, Any] = {
        "type": kind,
        "name": getattr(shape, "name", f"shape-{z_order + 1}"),
        "text": text,
        "bounds": transform_rect(local_bounds, matrix),
        "zOrder": z_order,
        "source": "pptx",
        "page": page,
        "metadata": {
            "shapeType": str(getattr(shape, "shape_type", "unknown")),
            "shapeId": f"{parent_id or page}/{shape.shape_id}",
            "parentId": parent_id,
            "paintOrder": z_order,
            **paint_metadata(shape, kind, matrix),
        },
    }
    size = _font_size(shape)
    if size is not None:
        element["fontSize"] = size
    element["metadata"].update(text_metadata(shape, local_bounds, matrix, size))
    if getattr(shape, "is_placeholder", False):
        element["metadata"]["placeholderType"] = str(shape.placeholder_format.type)
    return element


def _slide_elements(slide: Any, page: int, width: float, height: float) -> List[Dict[str, Any]]:
    elements: List[Dict[str, Any]] = []

    def visit(shapes, parent=IDENTITY, parent_id=None):
        for shape in shapes:
            if float(getattr(shape, "width", 0) or 0) <= 0 or float(getattr(shape, "height", 0) or 0) <= 0:
                continue
            element = _element_from_shape(shape, len(elements), page, parent, parent_id)
            elements.append(element)
            if getattr(shape, "shape_type", None) == MSO_SHAPE_TYPE.GROUP:
                _, _, child_matrix = shape_transform(shape, parent)
                visit(shape.shapes, child_matrix, element["metadata"]["shapeId"])

    visit(slide.shapes)
    assign_containers(elements, width, height)
    return elements


def _union_rect(rects: List[Rect]) -> Rect:
    return {
        "x0": min(rect["x0"] for rect in rects),
        "y0": min(rect["y0"] for rect in rects),
        "x1": max(rect["x1"] for rect in rects),
        "y1": max(rect["y1"] for rect in rects),
    }


def _as_page_number(value: Any, default: Optional[int] = None) -> Optional[int]:
    if value is None:
        return default
    if isinstance(value, str) and value.lower() == "all":
        return None
    try:
        page = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"page must be an integer, got {value!r}") from exc
    if page < 1:
        raise ValueError(f"page must be >= 1, got {page}")
    return page


def _open_pptx(pptx_path: str) -> Presentation:
    if not pptx_path:
        raise ValueError("pptxPath is required")
    if not os.path.exists(pptx_path):
        raise FileNotFoundError(f"PPTX file does not exist: {pptx_path}")
    return Presentation(pptx_path)


def _slide_indices(prs: Presentation, slide_num: Optional[int]) -> List[int]:
    if slide_num is None:
        return list(range(len(prs.slides)))
    slide_index = slide_num - 1
    if slide_index < 0 or slide_index >= len(prs.slides):
        raise IndexError(f"slide {slide_num} is out of range; PPTX has {len(prs.slides)} slide(s)")
    return [slide_index]


def extract_structure(pptx_path: str, slide_num: Optional[int] = None) -> List[Dict[str, Any]]:
    prs = _open_pptx(pptx_path)
    results: List[Dict[str, Any]] = []

    for slide_index in _slide_indices(prs, slide_num):
        slide = prs.slides[slide_index]
        page = slide_index + 1
        elements = _slide_elements(slide, page, float(prs.slide_width), float(prs.slide_height))
        results.append({
            "page": page,
            "dimensions": {
                "width": float(prs.slide_width),
                "height": float(prs.slide_height),
                "unit": "EMU",
            },
            "elements": elements,
            "source": "pptx",
            "metadata": {
                "layoutName": slide.slide_layout.name,
                "inspectionLimitations": [
                    "Text line positions are estimates, not rendered font metrics; text collisions and clipping require visual review.",
                    "Inherited fonts/fills, complex paths, image alpha, tables/charts, master artwork and animation visibility are not fully resolved.",
                    "Group transforms are applied; arbitrary rotated bounds and unsupported vertical/multicolumn text remain candidates.",
                    "Translucent fills are not treated as opaque masks; local peer filtering does not prove equal-size or equal-spacing design intent.",
                    "Text estimates retain at most 512 lines per element; textLayoutLimited marks incomplete line evidence.",
                ],
            },
        })

    return results


def _overflow_sides(rect: Rect, width: float, height: float) -> List[str]:
    sides: List[str] = []
    if rect["x0"] < 0:
        sides.append("left")
    if rect["y0"] < 0:
        sides.append("top")
    if rect["x1"] > width:
        sides.append("right")
    if rect["y1"] > height:
        sides.append("bottom")
    return sides


def _overlap_evidence(first: Dict[str, Any], second: Dict[str, Any]):
    if any(element['metadata'].get('visibleText') is False for element in (first, second)):
        return None
    if "group" in {first["type"], second["type"]}:
        return None
    behind, front = sorted((first, second), key=lambda item: item['zOrder'])
    front_meta, behind_meta = front['metadata'], behind['metadata']
    if behind['type'] in {'text', 'image', 'table'} and front_meta.get('opaqueRectangle'):
        frame_resolved = behind['type'] != 'text' or (
            behind_meta.get('autoFit') in {'none', 'shrink'} and behind_meta.get('textMetrics') == 'estimated'
            and not behind_meta.get('textLayoutLimited')
            and behind_meta.get('textRegions') and not behind_meta.get('estimatedOverflowSides')
            and all(contains(behind['bounds'], region, 1) for region in behind_meta['textRegions']))
        if contains(front['bounds'], behind['bounds'], 1) and frame_resolved:
            return evidence('paint-order-opaque-rectangle', ['later_opaque_rectangle', 'content_bounds_fully_covered'], 'high', True)
        regions = behind_meta.get('textRegions') if behind['type'] == 'text' else [behind['bounds']]
        if regions and any(_overlap_percent(region, front['bounds']) >= 15 for region in regions):
            return evidence('estimated-text-occlusion', ['later_opaque_rectangle', 'estimated_content_intersection'])
        if not regions:
            return evidence('unresolved-text-occlusion', ['later_opaque_rectangle', 'font_metrics_unresolved'], 'low')
    if first['type'] == second['type'] == 'text':
        first_regions = first['metadata'].get('textRegions', [])
        second_regions = second['metadata'].get('textRegions', [])
        if first_regions and second_regions:
            comparisons = 0
            for left in first_regions:
                for right in second_regions:
                    comparisons += 1
                    if comparisons > 4096:
                        first['metadata']['textComparisonLimited'] = True
                        return evidence('estimated-text-lines', ['text_comparison_budget_exceeded'], 'low')
                    if _overlap_percent(left, right) >= 15:
                        return evidence('estimated-text-lines', ['estimated_text_line_intersection'])
            return evidence('text-frame-intersection',
                            ['text_frames_intersect', 'estimated_lines_separate', 'rendered_metrics_required'], 'low')
        else:
            return evidence('text-frame-intersection', ['font_metrics_unresolved'], 'low')
    elif behind['type'] == 'text' and front['type'] in {'image', 'shape'}:
        if front['type'] == 'shape' and (front_meta.get('fillOpacity') == 0 or
                isinstance(front_meta.get('fillOpacity'), (float, int)) and front_meta['fillOpacity'] < 1):
            return None
        regions = behind_meta.get('textRegions', [])
        if regions and any(_overlap_percent(region, front['bounds']) >= 15 for region in regions):
            return evidence('unresolved-paint-intersection', ['later_paint', 'complex_geometry_or_alpha_unresolved'], 'low')
    return None


def detect_issues(
    pptx_path: str,
    slide_num: Optional[int] = None,
    checks: Optional[List[str]] = None,
    thresholds: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    active_checks = set(checks or ["overlap", "overflow"])
    thresholds = thresholds or {}
    structures = extract_structure(pptx_path, slide_num)
    issues = BoundedIssues()
    pair_budget = PairBudget()

    for structure in structures:
        if issues.full():
            break
        page = structure["page"]
        width = float(structure["dimensions"]["width"])
        height = float(structure["dimensions"]["height"])
        elements = structure["elements"]

        if "overflow" in active_checks:
            for element in elements:
                if issues.full():
                    break
                if element['metadata'].get('visibleText') is False:
                    continue
                if element['type'] in {'shape', 'group'}:
                    continue
                sides = _overflow_sides(element["bounds"], width, height)
                if not sides:
                    continue
                if element['type'] == 'text':
                    regions = element['metadata'].get('textRegions', [])
                    if regions and not any(_overflow_sides(region, width, height) for region in regions):
                        continue
                confirmed = element['type'] in {'image', 'table'}
                issues.append({
                    "type": "overflow",
                    "severity": "error" if confirmed else "warning",
                    "page": page,
                    "description": f"{element['name']} 超出幻灯片边界: {', '.join(sides)}",
                    "elements": [element],
                    "bounds": element["bounds"],
                    "metadata": {"sides": sides, "source": "pptx-native", **evidence(
                        'page-boundary', ['content_outside_page'] if confirmed else ['estimated_text_outside_page'],
                        'high' if confirmed else 'medium', confirmed)},
                })

        if "overlap" in active_checks:
            for i, first in enumerate(elements):
                if issues.full() or pair_budget.limit_reached:
                    break
                for second in elements[i + 1:]:
                    if issues.full() or not pair_budget.allow():
                        break
                    percent = _overlap_percent(first["bounds"], second["bounds"])
                    if percent < 2:
                        continue
                    assessment = _overlap_evidence(first, second)
                    if assessment is None:
                        continue
                    issues.append({
                        "type": "overlap",
                        "severity": "error" if assessment['assessment'] == 'confirmed' else "info" if assessment['confidence'] == 'low' else "warning",
                        "page": page,
                        "description": f"{first['name']} 与 {second['name']} {'遮挡' if assessment['assessment'] == 'confirmed' else '疑似内容相交，需视觉复核'}（外框交叠 {percent:.1f}%）",
                        "elements": [first, second],
                        "bounds": _union_rect([first["bounds"], second["bounds"]]),
                        "metadata": {
                            "overlapPercent": round(percent, 2),
                            "source": "pptx-native",
                            **assessment,
                        },
                    })

        if "readability" in active_checks:
            small_font_threshold = float(thresholds.get("smallFontPt") or SMALL_FONT_THRESHOLD_PT)
            for element in elements:
                if issues.full():
                    break
                if element['metadata'].get('visibleText') is False:
                    continue
                if element.get("type") != "text":
                    continue
                font_size = element.get("fontSize")
                if isinstance(font_size, (int, float)) and float(font_size) < small_font_threshold:
                    issues.append({
                        "type": "small-font",
                        "severity": "warning",
                        "page": page,
                        "description": f"{element['name']} 字号 {float(font_size):.1f}pt 低于 {small_font_threshold:.1f}pt",
                        "elements": [element],
                        "bounds": element["bounds"],
                        "metadata": {
                            "check": "small-font",
                            "fontSize": float(font_size),
                            "threshold": small_font_threshold,
                            "source": "pptx-native",
                        },
                    })
                clipping_sides = _text_clipping_sides(element)
                if clipping_sides:
                    issues.append({
                        "type": "clipped",
                        "severity": "warning",
                        "page": page,
                        "description": f"{element['name']} 文本可能超出文本框: {', '.join(clipping_sides)}",
                        "elements": [element],
                        "bounds": element["bounds"],
                        "metadata": {
                            "check": "text-clipping",
                            "sides": clipping_sides,
                            "source": "pptx-native",
                        },
                    })

    if "alignment" in active_checks and not issues.full():
        issues.extend(_detect_title_alignment(
            structures,
            float(thresholds.get("titleTopVarianceEmu") or TITLE_TOP_VARIANCE_THRESHOLD_EMU),
        ))
        issues.extend(_detect_size_consistency(
            structures,
            float(thresholds.get("sizeVarianceRatio") or SIZE_VARIANCE_THRESHOLD_RATIO),
        ))
        issues.extend(_detect_uneven_spacing(
            structures,
            float(thresholds.get("gapVarianceRatio") or GAP_VARIANCE_THRESHOLD_RATIO),
        ))

    pair_budget.annotate(structures, issues)
    for issue in issues:
        metadata = issue.setdefault('metadata', {})
        if 'assessment' not in metadata:
            metadata.update(evidence(
                'estimated-text-layout' if issue['type'] == 'clipped' else 'local-layout-heuristic',
                ['font_metrics_estimated'] if issue['type'] == 'clipped' else [metadata.get('check', issue['type'])],
            ))
    errors = sum(1 for issue in issues if issue["severity"] == "error")
    warnings = sum(1 for issue in issues if issue["severity"] == "warning")
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


def _candidate_title(structure: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    text_elements = [element for element in structure["elements"] if element.get("type") == "text" and element.get("text")]
    if not text_elements:
        return None
    candidates = [element for element in text_elements
                  if element.get('metadata', {}).get('placeholderType') == 'TITLE (1)']
    if not candidates:
        return None
    return sorted(
        candidates,
        key=lambda element: (
            float(element["bounds"]["y0"]),
            -float(element.get("fontSize") or 0),
            float(element["bounds"]["x0"]),
        ),
    )[0]


def _detect_title_alignment(structures: List[Dict[str, Any]], threshold: float) -> List[Dict[str, Any]]:
    layouts = {structure.get('metadata', {}).get('layoutName') for structure in structures}
    if len(layouts) > 1:
        return [issue for layout in layouts for issue in _detect_title_alignment(
            [structure for structure in structures if structure.get('metadata', {}).get('layoutName') == layout], threshold)]
    titles = [title for title in (_candidate_title(structure) for structure in structures) if title]
    if len(titles) < 2:
        return []
    top_values = [float(title["bounds"]["y0"]) for title in titles]
    min_top = min(top_values)
    max_top = max(top_values)
    if max_top - min_top <= threshold:
        return []
    reference = sorted(top_values)[len(top_values) // 2]
    off_titles = [
        title for title in titles
        if abs(float(title["bounds"]["y0"]) - reference) > threshold
    ] or titles
    return [{
        "type": "misalignment",
        "severity": "warning",
        "page": int(off_titles[0].get("page") or 1),
        "description": f"跨页标题 top 位置差异 {max_top - min_top:.0f} EMU，超过阈值 {threshold:.0f} EMU",
        "elements": off_titles,
        "bounds": _union_rect([title["bounds"] for title in off_titles]),
        "metadata": {
            "check": "title-top-alignment",
            "minTop": min_top,
            "maxTop": max_top,
            "referenceTop": reference,
            "threshold": threshold,
            "source": "pptx-native",
        },
    }]


def _detect_size_consistency(structures: List[Dict[str, Any]], threshold: float) -> List[Dict[str, Any]]:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for structure in structures:
        if len(structure['elements']) > 500:
            continue
        for axis in ('x', 'y'):
            for index, peers in enumerate(local_peer_groups(structure['elements'], axis)):
                groups[f"page-{structure['page']}:{axis}:{index}"] = peers

    issues = BoundedIssues()
    for group, elements in groups.items():
        if issues.full():
            break
        if len(elements) < 2:
            continue
        widths = [float(element["bounds"]["x1"] - element["bounds"]["x0"]) for element in elements]
        heights = [float(element["bounds"]["y1"] - element["bounds"]["y0"]) for element in elements]
        avg_w = sum(widths) / len(widths)
        avg_h = sum(heights) / len(heights)
        width_ratio = ((max(widths) - min(widths)) / avg_w) if avg_w else 0
        height_ratio = ((max(heights) - min(heights)) / avg_h) if avg_h else 0
        axis = group.split(':')[1]
        tiled = all(abs(right['bounds'][axis + '0'] - left['bounds'][axis + '1']) <= 2
                    for left, right in zip(elements, elements[1:]))
        compared_dimensions = ['height' if axis == 'x' else 'width'] if tiled else ['width', 'height']
        compared_ratios = [width_ratio if dimension == 'width' else height_ratio for dimension in compared_dimensions]
        if max(compared_ratios) <= threshold:
            continue
        issues.append({
            "type": "inconsistent-size",
            "severity": "warning",
            "page": int(elements[0].get("page") or 1),
            "description": f"{group} 同类元素尺寸差异超过 {threshold:.0%}",
            "elements": elements,
            "bounds": _union_rect([element["bounds"] for element in elements]),
            "metadata": {
                "check": "size-consistency",
                "group": group,
                "widthVarianceRatio": round(width_ratio, 3),
                "heightVarianceRatio": round(height_ratio, 3),
                "comparedDimensions": compared_dimensions,
                "threshold": threshold,
                "source": "pptx-native",
            },
        })
    return issues


def _detect_uneven_spacing(structures: List[Dict[str, Any]], threshold: float) -> List[Dict[str, Any]]:
    issues = BoundedIssues()
    for structure in structures:
        if issues.full():
            break
        if len(structure['elements']) > 500:
            continue
        groups = [(axis, group) for axis in ('x', 'y') for group in local_peer_groups(structure['elements'], axis)]
        for bucket, (axis, row) in enumerate(groups):
            if issues.full():
                break
            if len(row) < 3:
                continue
            ordered = sorted(row, key=lambda element: float(element["bounds"][axis + '0']))
            gaps = [
                float(right["bounds"][axis + '0'] - left["bounds"][axis + '1'])
                for left, right in zip(ordered, ordered[1:])
                if right["bounds"][axis + '0'] >= left["bounds"][axis + '1']
            ]
            if len(gaps) < 2:
                continue
            avg_gap = sum(gaps) / len(gaps)
            if avg_gap <= 0:
                continue
            variance = (max(gaps) - min(gaps)) / avg_gap
            if variance <= threshold:
                continue
            issues.append({
                "type": "uneven-spacing",
                "severity": "info",
                "page": int(structure["page"]),
                "description": f"第 {structure['page']} 页局部同类元素间距差异 {variance:.2f}，超过阈值 {threshold:.2f}，需复核布局意图",
                "elements": ordered,
                "bounds": _union_rect([element["bounds"] for element in ordered]),
                "metadata": {
                    "check": "row-gap-consistency",
                    "rowBucket": bucket,
                    "axis": axis,
                    "gaps": [round(gap, 2) for gap in gaps],
                    "varianceRatio": round(variance, 3),
                    "threshold": threshold,
                    "source": "pptx-native",
                },
            })
    return issues


def search_text_region(pptx_path: str, target: str, slide_num: Optional[int] = None) -> Dict[str, Any]:
    if not target or not str(target).strip():
        raise ValueError("target is required")

    prs = _open_pptx(pptx_path)
    target_text = str(target).strip().lower()
    slide_indices = _slide_indices(prs, slide_num)

    for slide_index in slide_indices:
        if slide_index < 0 or slide_index >= len(prs.slides):
            raise IndexError(f"slide {slide_index + 1} is out of range; PPTX has {len(prs.slides)} slide(s)")
        slide = prs.slides[slide_index]
        matches: List[Rect] = []
        names: List[str] = []
        for element in _slide_elements(slide, slide_index + 1, float(prs.slide_width), float(prs.slide_height)):
            text = element.get('text', '')
            if target_text not in text.lower():
                continue
            matches.append(element['bounds'])
            names.append(element['name'])

        if matches:
            return {
                "found": True,
                "target": target,
                "page": slide_index + 1,
                "rect": _union_rect(matches),
                "matches": len(matches),
                "elements": names,
                "dimensions": {
                    "width": float(prs.slide_width),
                    "height": float(prs.slide_height),
                    "unit": "EMU",
                },
            }

    return {
        "found": False,
        "target": target,
        "page": slide_num,
        "rect": None,
        "matches": 0,
        "elements": [],
        "dimensions": {
            "width": float(prs.slide_width),
            "height": float(prs.slide_height),
            "unit": "EMU",
        },
    }


def _params(payload: Dict[str, Any]) -> Dict[str, Any]:
    params = dict(payload.get("params") or {})
    for key, value in payload.items():
        if key not in {"action", "params"} and key not in params:
            params[key] = value
    return params


def _dispatch(payload: Dict[str, Any]) -> Any:
    action = payload.get("action")
    params = _params(payload)
    pptx_path = params.get("pptxPath") or params.get("pptx_path") or params.get("path")
    page_num = _as_page_number(params.get("page") or params.get("pageNum") or params.get("page_num"))

    if action == "search_text_region":
        return search_text_region(pptx_path, str(params.get("target") or ""), page_num)
    if action == "extract_structure":
        return extract_structure(pptx_path, page_num)
    if action == "detect_issues":
        return detect_issues(
            pptx_path,
            page_num,
            list(params.get("checks") or ["overlap", "overflow"]),
            params.get("thresholds"),
        )

    raise ValueError(f"unknown action: {action!r}")


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            raise ValueError("stdin JSON payload is required")
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("stdin JSON payload must be an object")
        result = _dispatch(payload)
        print(json.dumps({"ok": True, "action": payload.get("action"), "result": result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "error": {
                "type": exc.__class__.__name__,
                "message": str(exc),
                "traceback": traceback.format_exc(),
            },
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
