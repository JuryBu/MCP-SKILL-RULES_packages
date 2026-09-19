import math
from typing import Any, Dict, List


IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
MAX_INSPECTION_ISSUES = 200
MAX_COMPARISON_PAIRS = 20000
MAX_AUTO_SCREENSHOTS = 8


class BoundedIssues(list):
    def __init__(self):
        super().__init__()
        self.limit_reached = False

    def full(self):
        if len(self) >= MAX_INSPECTION_ISSUES:
            self.limit_reached = True
            return True
        return False

    def append(self, issue):
        if not self.full():
            super().append(issue)

    def extend(self, issues):
        for issue in issues:
            if self.full():
                break
            self.append(issue)


class PairBudget:
    def __init__(self):
        self.checked = 0
        self.limit_reached = False

    def allow(self):
        if self.checked >= MAX_COMPARISON_PAIRS:
            self.limit_reached = True
            return False
        self.checked += 1
        return True

    def annotate(self, structures, issues):
        issues.full()
        incomplete = self.limit_reached or issues.limit_reached
        for structure in structures:
            metadata = structure.setdefault('metadata', {})
            detail_limited = any(any(element.get('metadata', {}).get(key) for key in
                                 ('glyphTraceTruncated', 'textComparisonLimited', 'layoutGroupingLimited', 'textLayoutLimited'))
                                 for element in structure['elements'])
            metadata['inspectionBudget'] = {'maxIssues': MAX_INSPECTION_ISSUES,
                'maxPairChecks': MAX_COMPARISON_PAIRS, 'pairChecksPerformed': self.checked,
                'pairLimitReached': self.limit_reached, 'issueLimitReached': issues.limit_reached,
                'notExhaustive': incomplete or detail_limited, 'detailLimitReached': detail_limited, 'scope': 'whole-request'}
            if incomplete or detail_limited:
                metadata.setdefault('inspectionLimitations', []).append(
                    'Detection budget reached; unexamined pairs/issues remain. An empty page issue list is not a clean result.')


def compose(outer, inner):
    aa, ab, ac, ad, ax, ay = outer
    ba, bb, bc, bd, bx, by = inner
    return (aa * ba + ac * bb, ab * ba + ad * bb,
            aa * bc + ac * bd, ab * bc + ad * bd,
            aa * bx + ac * by + ax, ab * bx + ad * by + ay)


def transform_rect(rect, matrix):
    xx, yx, xy, yy, tx, ty = matrix
    points = [(xx * left + xy * top + tx, yx * left + yy * top + ty)
              for left in (rect['x0'], rect['x1']) for top in (rect['y0'], rect['y1'])]
    return {'x0': min(point[0] for point in points), 'y0': min(point[1] for point in points),
            'x1': max(point[0] for point in points), 'y1': max(point[1] for point in points)}


def rotation_matrix(rect, degrees=0.0, flip_h=False, flip_v=False):
    angle = math.radians(degrees)
    cosine, sine = math.cos(angle), math.sin(angle)
    horizontal, vertical = (-1 if flip_h else 1), (-1 if flip_v else 1)
    center_x = (rect['x0'] + rect['x1']) / 2
    center_y = (rect['y0'] + rect['y1']) / 2
    xx, yx, xy, yy = cosine * horizontal, sine * horizontal, -sine * vertical, cosine * vertical
    return (xx, yx, xy, yy, center_x - xx * center_x - xy * center_y,
            center_y - yx * center_x - yy * center_y)


def axis_aligned(matrix):
    return ((abs(matrix[1]) < 1e-8 and abs(matrix[2]) < 1e-8)
            or (abs(matrix[0]) < 1e-8 and abs(matrix[3]) < 1e-8))


def contains(outer, inner, tolerance=0.0):
    return (outer['x0'] <= inner['x0'] + tolerance and outer['y0'] <= inner['y0'] + tolerance
            and outer['x1'] >= inner['x1'] - tolerance and outer['y1'] >= inner['y1'] - tolerance)


def evidence(kind, reasons, confidence='medium', confirmed=False):
    return {'confidence': confidence, 'assessment': 'confirmed' if confirmed else 'candidate',
            'evidenceKind': kind, 'reasonCodes': list(reasons)}


def local_peer_groups(elements: List[Dict[str, Any]], axis: str):
    groups = []
    compared = 0
    cross = 'y' if axis == 'x' else 'x'
    for element in sorted(elements, key=lambda item: item['bounds'][axis + '0']):
        metadata = element.get('metadata', {})
        if element.get('type') not in {'text', 'shape', 'image'} or metadata.get('role') == 'background':
            continue
        if element.get('type') == 'shape' and metadata.get('geometry') != 'rect':
            continue
        bounds = element['bounds']
        for group in groups:
            compared += 1
            if compared > MAX_COMPARISON_PAIRS:
                for remaining in elements:
                    remaining.setdefault('metadata', {})['layoutGroupingLimited'] = True
                return [peers for peers in groups if len(peers) >= 3]
            previous = group[-1]
            previous_meta = previous.get('metadata', {})
            reference = previous['bounds']
            if (element['type'], metadata.get('parentId'), metadata.get('layoutContainer'), metadata.get('geometry')) != (
                    previous['type'], previous_meta.get('parentId'), previous_meta.get('layoutContainer'), previous_meta.get('geometry')):
                continue
            extent = bounds[axis + '1'] - bounds[axis + '0']
            previous_extent = reference[axis + '1'] - reference[axis + '0']
            cross_extent = bounds[cross + '1'] - bounds[cross + '0']
            previous_cross = reference[cross + '1'] - reference[cross + '0']
            if min(extent, previous_extent, cross_extent, previous_cross) <= 0:
                continue
            if max(extent, previous_extent) > min(extent, previous_extent) * 2.2:
                continue
            if max(cross_extent, previous_cross) > min(cross_extent, previous_cross) * 1.25:
                continue
            if abs(bounds[cross + '0'] - reference[cross + '0']) > min(cross_extent, previous_cross) * .2:
                continue
            gap = bounds[axis + '0'] - reference[axis + '1']
            if gap < 0 or gap > min(extent, previous_extent) * 1.5:
                continue
            if element['type'] == 'text':
                size = element.get('fontSize')
                previous_size = previous.get('fontSize')
                if not size or not previous_size or max(size, previous_size) > min(size, previous_size) * 1.2:
                    continue
                length, previous_length = len(element.get('text', '')), len(previous.get('text', ''))
                if max(length, previous_length) > max(1, min(length, previous_length)) * 2.0:
                    continue
            group.append(element)
            break
        else:
            groups.append([element])
    return [group for group in groups if len(group) >= 3]
