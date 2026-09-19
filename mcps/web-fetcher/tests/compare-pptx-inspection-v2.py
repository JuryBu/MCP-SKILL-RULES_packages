import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'inspector'))
import pptx_inspector


def digest(path):
    checksum = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def signature(issue):
    return issue['type'], tuple(sorted(element['name'] for element in issue['elements']))


def explain_old_issue(issue, detection):
    current = {element['name']: element for element in detection['structure'][0]['elements']}
    elements = [current[element['name']] for element in issue['elements'] if element['name'] in current]
    matching = [candidate for candidate in detection['issues'] if signature(candidate) == signature(issue)]
    if matching:
        return {'disposition': 'retained-as-candidate', 'reasonCodes': matching[0]['metadata']['reasonCodes'],
                'candidateConfidence': matching[0]['metadata']['confidence'], 'visualConclusion': 'unresolved'}
    if issue['type'] in ('inconsistent-size', 'uneven-spacing'):
        return {'disposition': 'not-reissued', 'reasonCodes': ['page_wide_name_or_row_group_rejected',
                'local_role_container_and_typography_required', 'equal_size_or_gap_intent_unproven'],
                'oldElementCount': len(elements), 'visualConclusion': 'unresolved'}
    if issue['type'] == 'clipped':
        metadata = elements[0]['metadata']
        return {'disposition': 'not-reissued', 'reasonCodes': ['unwrapped_character_count_replaced',
                'word_wrap_and_autofit_respected', 'font_metrics_still_estimated'],
                'layoutEvidence': {key: metadata.get(key) for key in ('wordWrap', 'autoFit', 'fontScale', 'textMetrics',
                    'margins', 'estimatedOverflowSides', 'estimatedLineCount', 'estimatedTextHeight', 'availableTextHeight')},
                'visualConclusion': 'unresolved', 'retainedLimitation': metadata['inspectionLimitations']}
    if issue['type'] == 'overlap':
        types = {element['type'] for element in elements}
        ordered = sorted(elements, key=lambda element: element['zOrder'])
        reasons = (['text_painted_after_shape', 'no_later_opaque_cover_of_text']
                   if types == {'text', 'shape'} and ordered[-1]['type'] == 'text'
                   else ['non_text_composition', 'bounding_box_not_filled_path'] if types == {'shape'}
                   else ['insufficient_content_intersection_evidence', 'rendered_metrics_required'])
        return {'disposition': 'not-reissued', 'reasonCodes': reasons,
                'paintEvidence': [{'name': element['name'], 'paintOrder': element['zOrder'],
                    'role': element['metadata'].get('role'), 'geometry': element['metadata'].get('geometry'),
                    'fillOpacity': element['metadata'].get('fillOpacity')} for element in ordered],
                'visualConclusion': 'unresolved'}
    return {'disposition': 'not-reissued', 'reasonCodes': ['content_role_filter'], 'visualConclusion': 'unresolved'}


def compare(baseline_root, output_root):
    baseline = json.loads((baseline_root / 'baseline.json').read_text(encoding='utf-8-sig'))
    original_map = {original['key']: original for original in baseline['originals']}
    before = {key: digest(original['path']) for key, original in original_map.items()}
    assert all(before[key] == original['sha256'] for key, original in original_map.items()), 'Baseline input identity changed'
    output_root.mkdir(parents=True, exist_ok=True)
    rows, mappings = [], []
    for page in baseline['pages']:
        original = original_map[page['key']]
        detection = pptx_inspector.detect_issues(original['path'], page['page'],
                                               checks=['overlap', 'overflow', 'readability', 'alignment'])
        output = output_root / f"candidate-{page['key']}-p{page['page']:02}.json"
        output.write_text(json.dumps(detection, ensure_ascii=False, indent=2), encoding='utf-8')
        old = json.loads(Path(page['rawDetect']).read_text(encoding='utf-8-sig'))['detection']
        current_signatures = {signature(issue) for issue in detection['issues']}
        old_signatures = {signature(issue) for issue in old['issues']}
        labels = {issue_number: group['label'] for group in page['manualGroups'] for issue_number in group['issueIds']}
        page_mappings = [{'oldIssueNumber': number, 'oldType': issue['type'],
                         'elements': [element['name'] for element in issue['elements']],
                         'baselineLabel': labels[number], 'candidateSignatureRetained': signature(issue) in current_signatures,
                         'explanation': explain_old_issue(issue, detection)}
                        for number, issue in enumerate(old['issues'], 1)]
        for mapping in page_mappings:
            if mapping['baselineLabel'] == 'normal_composition':
                mapping['explanation']['visualConclusion'] = 'baseline-normal-label-preserved'
        mappings.append({'key': page['key'], 'page': page['page'], 'oldIssues': page_mappings})
        row = {'key': page['key'], 'page': page['page'], 'oldIssues': len(old['issues']),
               'newIssues': len(detection['issues']), 'errors': detection['summary']['errors'],
               'candidate': sum(issue['metadata']['assessment'] == 'candidate' for issue in detection['issues']),
               'confirmed': sum(issue['metadata']['assessment'] == 'confirmed' for issue in detection['issues']),
               'oldLabelsRetained': dict(Counter(item['baselineLabel'] for item in page_mappings if item['candidateSignatureRetained'])),
               'oldLabelsNotReissued': dict(Counter(item['baselineLabel'] for item in page_mappings if not item['candidateSignatureRetained'])),
               'newSignatures': sum(signature(issue) not in old_signatures for issue in detection['issues']),
               'types': dict(Counter(issue['type'] for issue in detection['issues'])),
               'inspectionBudget': detection['structure'][0]['metadata'].get('inspectionBudget'),
               'reasons': dict(Counter(reason for issue in detection['issues'] for reason in issue['metadata']['reasonCodes'])),
               'candidatePath': str(output), 'baselineScreenshot': page['screenshot']}
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False))
    after = {key: digest(original['path']) for key, original in original_map.items()}
    assert before == after, 'Original files changed during read-only inspection'
    report = {'generatedAt': datetime.now(timezone.utc).isoformat(), 'baselineRoot': str(baseline_root),
              'comparisonMethod': 'Exact type plus sorted element-name signature; not stable issue IDs or proof of visual correctness.',
              'scope': 'Only the selected pages listed in the baseline; original manual labels remain unchanged.',
              'pages': rows, 'oldIssueMappings': mappings,
              'originals': [{**original, 'hashBefore': before[key], 'hashAfter': after[key]} for key, original in original_map.items()],
              'originalHashesUnchanged': before == after,
              'unresolvedBaselineCount': sum(item['baselineLabel'] == 'algorithm_only_suspicion'
                                            for page in mappings for item in page['oldIssues']),
              'unresolvedNotReissuedCount': sum(item['baselineLabel'] == 'algorithm_only_suspicion' and not item['candidateSignatureRetained']
                                               for page in mappings for item in page['oldIssues']),
              'limitations': ['No new browser, window, Office conversion or rendering performed.',
                              'Unselected pages, animation, exact font layout and content/chart semantics not verified.']}
    (output_root / 'comparison.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('TOTAL', json.dumps({key: sum(row[key] for row in rows) for key in ('oldIssues', 'newIssues', 'errors', 'candidate', 'confirmed')}, ensure_ascii=False))
    print('ORIGINAL_HASHES_UNCHANGED', before == after)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('baseline_root', type=Path)
    parser.add_argument('output_root', type=Path)
    arguments = parser.parse_args()
    compare(arguments.baseline_root.resolve(), arguments.output_root.resolve())
