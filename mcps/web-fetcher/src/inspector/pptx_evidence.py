import re
import unicodedata

from inspection_geometry import IDENTITY, axis_aligned, compose, contains, rotation_matrix, transform_rect


EMU_PER_PT = 12700.0
MAX_TEXT_LINES = 512


def shape_transform(shape, parent=IDENTITY):
    bounds = {'x0': float(shape.left), 'y0': float(shape.top),
              'x1': float(shape.left + shape.width), 'y1': float(shape.top + shape.height)}
    transforms = shape._element.xpath('./p:spPr/a:xfrm | ./p:grpSpPr/a:xfrm')
    transform = transforms[0] if transforms else None
    rotation = float(transform.get('rot', 0)) / 60000 if transform is not None else 0
    matrix = compose(parent, rotation_matrix(bounds, rotation,
                     transform is not None and transform.get('flipH') in ('1', 'true'),
                     transform is not None and transform.get('flipV') in ('1', 'true')))
    child_matrix = matrix
    if transform is not None:
        children = {node.tag.rsplit('}', 1)[-1]: node for node in transform}
        if 'chOff' in children and 'chExt' in children:
            offset, extent = children['chOff'], children['chExt']
            scale_x = float(shape.width) / max(1, float(extent.get('cx', 0)))
            scale_y = float(shape.height) / max(1, float(extent.get('cy', 0)))
            child_matrix = compose(matrix, (scale_x, 0, 0, scale_y,
                                   float(shape.left) - float(offset.get('x', 0)) * scale_x,
                                   float(shape.top) - float(offset.get('y', 0)) * scale_y))
    return bounds, matrix, child_matrix


def paint_metadata(shape, kind, matrix):
    properties = shape._element.xpath('./p:spPr')
    geometry, fill_kind, opacity = 'unknown', 'inherited', None
    if properties:
        properties = properties[0]
        for node in properties:
            tag = node.tag.rsplit('}', 1)[-1]
            if tag == 'prstGeom':
                geometry = node.get('prst', 'unknown')
            if tag == 'noFill':
                fill_kind, opacity = 'none', 0.0
            elif tag == 'solidFill':
                fill_kind, opacity = 'solid', 1.0
                for child in node.iter():
                    child_tag = child.tag.rsplit('}', 1)[-1]
                    if child_tag == 'alpha':
                        opacity = float(child.get('val', 100000)) / 100000
                    elif child_tag == 'alphaMod':
                        opacity *= float(child.get('val', 100000)) / 100000
                    elif child_tag == 'alphaOff':
                        opacity += float(child.get('val', 0)) / 100000
                opacity = min(1.0, max(0.0, opacity))
            elif tag in ('gradFill', 'pattFill', 'blipFill', 'grpFill'):
                fill_kind, opacity = tag, None
    if geometry == 'unknown' and shape._element.xpath('./p:nvSpPr/p:cNvSpPr[@txBox="1"]'):
        geometry = 'rect'
        if fill_kind == 'inherited':
            fill_kind, opacity = 'none', 0.0
    return {'geometry': geometry, 'fillKind': fill_kind, 'fillOpacity': opacity,
            'axisAligned': axis_aligned(matrix), 'role': kind if kind != 'shape' else 'decoration',
            'opaqueRectangle': geometry == 'rect' and fill_kind == 'solid' and opacity == 1.0 and axis_aligned(matrix)}


def _paragraph_size(paragraph, fallback):
    sizes = [float(run.font.size.pt) for run in paragraph.runs if run.font.size is not None]
    if paragraph.font.size is not None:
        sizes.append(float(paragraph.font.size.pt))
    return max(sizes) if sizes else fallback


def _advance(text, size):
    total = 0.0
    for character in text:
        if unicodedata.combining(character):
            continue
        if character.isspace():
            factor = .28
        elif unicodedata.east_asian_width(character) in ('W', 'F'):
            factor = 1.0
        elif character in 'ilI.,:;!|':
            factor = .28
        elif character in 'MW@%':
            factor = .85
        else:
            factor = .53
        total += factor * size * EMU_PER_PT
    return total


def _wrap_widths(text, size, width, wrap):
    if not wrap or width <= 0:
        return [_advance(text, size)]
    widths, current = [], 0.0
    for token in re.findall(r'[\u2e80-\uffff]|[^\S\n]+|[^\s\u2e80-\uffff]+', text):
        token_width = _advance(token, size)
        if token_width > width:
            for character in token:
                advance = _advance(character, size)
                if current and current + advance > width:
                    widths.append(current)
                    current = 0.0
                current += advance
        else:
            if current and current + token_width > width:
                widths.append(current)
                current = 0.0
            if current or not token.isspace():
                current += token_width
    widths.append(current)
    return widths


def text_metadata(shape, local_bounds, matrix, font_size):
    if not getattr(shape, 'has_text_frame', False) or not shape.text.strip():
        return {}
    frame = shape.text_frame
    visible_runs = []
    for paragraph in frame.paragraphs:
        for run in paragraph.runs:
            if not run.text.strip():
                continue
            properties = run._r.xpath('./a:rPr/a:solidFill | ./a:rPr/a:noFill')
            if not properties:
                properties = paragraph._p.xpath('./a:pPr/a:defRPr/a:solidFill | ./a:pPr/a:defRPr/a:noFill')
            if not properties:
                visible_runs.append(None)
            else:
                fill = properties[0]
                alpha = fill.xpath('.//a:alpha')
                visible_runs.append(not (fill.tag.endswith('noFill') or alpha and float(alpha[-1].get('val', 100000)) == 0))
    body = frame._txBody.bodyPr
    body_tags = {child.tag.rsplit('}', 1)[-1]: child for child in body}
    auto_fit = 'shrink' if 'normAutofit' in body_tags else 'expand' if 'spAutoFit' in body_tags else 'none' if 'noAutofit' in body_tags else 'inherited'
    scale = float(body_tags['normAutofit'].get('fontScale', 100000)) / 100000 if auto_fit == 'shrink' else 1.0
    inner = {'x0': local_bounds['x0'] + float(frame.margin_left),
             'y0': local_bounds['y0'] + float(frame.margin_top),
             'x1': local_bounds['x1'] - float(frame.margin_right),
             'y1': local_bounds['y1'] - float(frame.margin_bottom)}
    available_width = max(0.0, inner['x1'] - inner['x0'])
    available_height = max(0.0, inner['y1'] - inner['y0'])
    metadata = {'textBounds': transform_rect(inner, matrix), 'wordWrap': frame.word_wrap,
                'visibleText': False if visible_runs and all(value is False for value in visible_runs) else None,
                'autoFit': auto_fit, 'fontScale': scale, 'textRegions': [], 'estimatedOverflowSides': [],
                'inspectionLimitations': ['Text wrapping, glyph widths and clipping are estimates; an empty overflow list is not rendered-fit confirmation.'],
                'textMetrics': 'estimated', 'margins': {'left': float(frame.margin_left), 'right': float(frame.margin_right),
                'top': float(frame.margin_top), 'bottom': float(frame.margin_bottom)}}
    if body.get('vert', 'horz') != 'horz' or int(body.get('numCol', 1)) != 1:
        metadata['textMetrics'] = 'unsupported-writing-mode'
        return metadata
    lines, cursor = [], 0.0
    for paragraph in frame.paragraphs:
        size = _paragraph_size(paragraph, font_size)
        if size is None:
            metadata['textMetrics'] = 'inherited-font-unresolved'
            return metadata
        size *= scale
        spacing = paragraph.line_spacing
        line_height = float(spacing) if isinstance(spacing, int) else size * EMU_PER_PT * (spacing if isinstance(spacing, float) else 1.2)
        cursor += float(paragraph.space_before or 0)
        for hard_line in paragraph.text.split('\v'):
            for line_width in _wrap_widths(hard_line, size, available_width, frame.word_wrap is not False):
                alignment = str(paragraph.alignment or '')
                offset = max(0.0, available_width - line_width)
                left = inner['x0'] + (offset / 2 if 'CENTER' in alignment else offset if 'RIGHT' in alignment else 0)
                if hard_line.strip():
                    if len(lines) < MAX_TEXT_LINES:
                        lines.append({'x0': left, 'y0': inner['y0'] + cursor,
                                      'x1': left + line_width, 'y1': inner['y0'] + cursor + size * EMU_PER_PT})
                    else:
                        metadata['textLayoutLimited'] = True
                cursor += max(1.0, line_height)
        cursor += float(paragraph.space_after or 0)
    text_height = max((line['y1'] - inner['y0'] for line in lines), default=0)
    if metadata.get('textLayoutLimited'):
        text_height = cursor
        metadata['inspectionLimitations'].append(f'Only the first {MAX_TEXT_LINES} estimated text lines are retained for pair comparison.')
    spare = max(0.0, available_height - text_height)
    anchor = body.get('anchor', 't')
    vertical_shift = spare / 2 if anchor == 'ctr' else spare if anchor == 'b' else 0
    for line in lines:
        line['y0'] += vertical_shift
        line['y1'] += vertical_shift
    metadata['textRegions'] = [transform_rect(line, matrix) for line in lines]
    metadata['estimatedLineCount'] = len(lines)
    metadata['estimatedTextHeight'] = text_height
    metadata['availableTextHeight'] = available_height
    if auto_fit not in ('shrink', 'expand'):
        if any(line['x1'] > inner['x1'] + max(1, available_width * .12) for line in lines):
            metadata['estimatedOverflowSides'].append('right')
        if text_height > available_height * 1.12:
            metadata['estimatedOverflowSides'].append('bottom')
    return metadata


def assign_containers(elements, width, height):
    if len(elements) > 500:
        for element in elements:
            element['metadata']['layoutGroupingLimited'] = True
        return
    for element in elements:
        metadata = element['metadata']
        bounds = element['bounds']
        if element['type'] == 'shape' and metadata['opaqueRectangle'] and contains(bounds, {'x0': 0, 'y0': 0, 'x1': width, 'y1': height}, 1):
            metadata['role'] = 'background'
        containers = [candidate for candidate in elements if candidate is not element and candidate['type'] == 'shape'
                      and candidate['metadata']['geometry'] in ('rect', 'roundRect')
                      and candidate['zOrder'] < element['zOrder']
                      and contains(candidate['bounds'], bounds, 1)]
        if containers:
            container = min(containers, key=lambda item: (item['bounds']['x1'] - item['bounds']['x0']) * (item['bounds']['y1'] - item['bounds']['y0']))
            metadata['layoutContainer'] = container['metadata']['shapeId']
