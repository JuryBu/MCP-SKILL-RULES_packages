import fitz

from inspection_geometry import contains, evidence


MAX_GLYPHS_PER_ELEMENT = 2048
MAX_TEXT_COMPARISONS = 4096


def page_rect(bounds, page):
    rectangle = fitz.Rect(bounds) * page.rotation_matrix
    return {'x0': rectangle.x0, 'y0': rectangle.y0, 'x1': rectangle.x1, 'y1': rectangle.y1}


def area(rectangle):
    return max(0, rectangle['x1'] - rectangle['x0']) * max(0, rectangle['y1'] - rectangle['y0'])


def intersection(first, second):
    result = {'x0': max(first['x0'], second['x0']), 'y0': max(first['y0'], second['y0']),
              'x1': min(first['x1'], second['x1']), 'y1': min(first['y1'], second['y1'])}
    return result if area(result) > 0 else None


def _simple_rectangle(path):
    items = path.get('items', [])
    return len(items) == 1 and items[0][0] == 're'


def add_paint_evidence(page, elements):
    limitations = [
        'Glyph boxes and drawing order are native evidence, not pixel-level glyph contours.',
        'Complex paths, soft masks, optional-content layers and blend groups require visual review.',
        'Image alpha is unresolved; extracted content excludes some clipped or off-page text.',
        'Translucent fills are not opaque-mask evidence; contrast degradation is not assessed.',
    ]
    try:
        traces = page.get_texttrace()
        paths = page.get_drawings(extended=True)
        drawing_log = page.get_bboxlog()
    except (AttributeError, TypeError) as error:
        limitations.append('Native paint tracing unavailable: ' + str(error))
        return limitations
    image_paints = [(order, page_rect(entry[1], page)) for order, entry in enumerate(drawing_log) if entry[0] == 'fill-image']
    for element in elements:
        if element['type'] != 'image':
            continue
        matches = [(order, bounds) for order, bounds in image_paints
                   if all(abs(bounds[key] - element['bounds'][key]) < .1 for key in bounds)]
        if matches:
            order, bounds = matches[0]
            element['metadata']['paintOrder'] = order
            image_paints.remove((order, bounds))
    text_elements = [element for element in elements if element['type'] == 'text']
    for element in text_elements:
        element['metadata']['glyphRuns'] = []
        element['metadata']['glyphCount'] = 0
        element['metadata']['paintTraceResolved'] = False
    for trace in traces:
        characters = trace.get('chars', [])
        text = ''.join(chr(character[0]) for character in characters if 0 <= character[0] <= 0x10ffff)
        bounds = page_rect(trace['bbox'], page)
        candidates = [element for element in text_elements if intersection(bounds, element['bounds'])]
        if not candidates:
            continue
        element = max(candidates, key=lambda candidate: (
            text.strip() in candidate['text'],
            area(intersection(bounds, candidate['bounds'])) / max(1, area(bounds)),
            -len(candidate['metadata']['glyphRuns']),
        ))
        visible = trace.get('type') != 3 and trace.get('opacity', 1) > 0
        element['metadata']['paintTraceResolved'] = True
        if not visible:
            continue
        remaining = MAX_GLYPHS_PER_ELEMENT - element['metadata']['glyphCount']
        glyphs = []
        for character in characters:
            if not 0 <= character[0] <= 0x10ffff or chr(character[0]).isspace():
                continue
            if len(glyphs) >= remaining:
                element['metadata']['glyphTraceTruncated'] = True
                break
            glyphs.append(page_rect(character[3], page))
        element['metadata']['glyphCount'] += len(glyphs)
        if not glyphs:
            continue
        element['metadata']['glyphRuns'].append({'bounds': bounds, 'glyphBounds': glyphs,
            'paintOrder': trace.get('seqno'), 'opacity': trace.get('opacity', 1), 'text': text,
            'layer': trace.get('layer', '')})
    for element in text_elements:
        orders = [run['paintOrder'] for run in element['metadata']['glyphRuns'] if run['paintOrder'] is not None]
        element['metadata']['paintOrders'] = orders
        element['metadata']['visibleText'] = bool(orders) if element['metadata']['paintTraceResolved'] else None
    if any(element['metadata'].get('glyphTraceTruncated') for element in text_elements):
        limitations.append(f'Glyph tracing capped at {MAX_GLYPHS_PER_ELEMENT} glyphs per text element; remaining glyphs were not checked.')
    stack = []
    for path_index, path in enumerate(paths):
        level = path.get('level', 0)
        stack = [context for context in stack if context.get('level', 0) < level]
        kind = path.get('type')
        if kind in {'clip', 'group'}:
            stack.append(path)
            continue
        bounds = page_rect(path['rect'], page)
        opacity = path.get('fill_opacity')
        solid = kind in {'f', 'fs'} and path.get('fill') is not None
        simple = _simple_rectangle(path)
        opaque = solid and opacity is not None and opacity >= 1.0
        safe_context = True
        cover_bounds = dict(bounds)
        for context in stack:
            if context['type'] == 'clip':
                if _simple_rectangle(context):
                    clip_bounds = page_rect(context['items'][0][1], page)
                    cover_bounds = intersection(cover_bounds, clip_bounds) if cover_bounds else None
                else:
                    safe_context = False
            elif context.get('opacity', 1) < 1 or context.get('blendmode', 'Normal') not in ('Normal', None):
                safe_context = False
        if path.get('layer'):
            safe_context = False
        metadata = {'paintOrder': path.get('seqno'), 'geometry': 'rect' if simple else 'complex-path',
                    'fillOpacity': opacity if solid else 0, 'fill': path.get('fill'),
                    'strokeOpacity': path.get('stroke_opacity'), 'drawingType': kind,
                    'pathOperations': [item[0] for item in path.get('items', [])],
                    'opaqueRectangle': bool(opaque and simple and safe_context and cover_bounds),
                    'coverBounds': cover_bounds, 'clipContextResolved': safe_context,
                    'role': 'vector-paint'}
        elements.append({'type': 'shape', 'name': f'vector-{page.number + 1}-{path_index}', 'text': '',
                         'bounds': bounds, 'zOrder': path.get('seqno', len(elements)),
                         'page': page.number + 1, 'source': 'pdf', 'metadata': metadata})
    return limitations


def overlap_evidence(first, second):
    types = {first['type'], second['type']}
    if 'text' not in types:
        return None
    if types == {'text'}:
        first_runs = first['metadata'].get('glyphRuns', [])
        second_runs = second['metadata'].get('glyphRuns', [])
        if first['metadata'].get('visibleText') is False or second['metadata'].get('visibleText') is False:
            return None
        if first_runs and second_runs:
            collision, limited = _runs_collision(first_runs, second_runs)
            if limited:
                first['metadata']['textComparisonLimited'] = True
            if limited or first['metadata'].get('glyphTraceTruncated') or second['metadata'].get('glyphTraceTruncated'):
                return evidence('native-glyph-boxes', ['text_comparison_budget_exceeded'], 'low')
            if collision:
                return evidence('native-glyph-boxes', ['glyph_box_intersection', 'glyph_contours_unresolved'])
            return None
        return evidence('text-block-intersection', ['paint_trace_unresolved'], 'low')
    text = first if first['type'] == 'text' else second
    cover = second if first['type'] == 'text' else first
    if text['metadata'].get('visibleText') is False:
        return None
    if cover['type'] != 'shape':
        order = cover['metadata'].get('paintOrder')
        runs = text['metadata'].get('glyphRuns', [])
        if order is not None and runs:
            if not any(run['paintOrder'] is not None and run['paintOrder'] < order
                       and any(intersection(cover['bounds'], glyph) for glyph in run['glyphBounds']) for run in runs):
                return None
            return evidence('image-text-intersection', ['later_image', 'image_alpha_unresolved'], 'low')
        return evidence('image-text-intersection', ['image_alpha_and_paint_order_unresolved'], 'low')
    metadata = cover['metadata']
    if isinstance(metadata.get('fillOpacity'), (float, int)) and metadata['fillOpacity'] < 1:
        return None
    order = metadata.get('paintOrder')
    runs = text['metadata'].get('glyphRuns', [])
    eligible = [run for run in runs if order is not None and run['paintOrder'] is not None and run['paintOrder'] < order]
    if not eligible:
        return None
    cover_bounds = metadata.get('coverBounds')
    if cover_bounds is None:
        return None
    covered = [glyph for run in eligible for glyph in run['glyphBounds'] if contains(cover_bounds, glyph)]
    if covered and metadata.get('opaqueRectangle') and all(not run.get('layer') for run in eligible):
        return {**evidence('native-paint-order-glyph-cover',
                ['later_opaque_rectangle', 'native_glyph_bounds_fully_covered'], 'high', True),
                'coveredGlyphCount': len(covered), 'coverPaintOrder': order}
    if any(intersection(cover_bounds, glyph) for run in eligible for glyph in run['glyphBounds']):
        return evidence('native-paint-intersection', ['later_paint', 'partial_glyph_or_complex_path'])
    return None


def _runs_collision(first_runs, second_runs, internal=False):
    checked = 0
    for first_index, first in enumerate(first_runs):
        for second in second_runs[first_index + 1:] if internal else second_runs:
            checked += 1
            if checked > MAX_TEXT_COMPARISONS:
                return False, True
            if first['paintOrder'] == second['paintOrder'] or not intersection(first['bounds'], second['bounds']):
                continue
            for left in first['glyphBounds']:
                for right in second['glyphBounds']:
                    checked += 1
                    if checked > MAX_TEXT_COMPARISONS:
                        return False, True
                    overlap = intersection(left, right)
                    if overlap and area(overlap) > min(area(left), area(right)) * .2:
                        return True, False
    return False, False


def internal_text_collisions(element):
    runs = element.get('metadata', {}).get('glyphRuns', [])
    collision, limited = _runs_collision(runs, runs, internal=True)
    if limited:
        element['metadata']['textComparisonLimited'] = True
    return collision or limited
