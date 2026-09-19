import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'inspector'))

import fitz
import pdf_inspector as inspector


class PdfInspectionV2(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pdf-inspection-v2-')
        self.path = Path(self.temporary.name) / 'neutral.pdf'
        self.document = fitz.open()
        self.page = self.document.new_page(width=400, height=300)

    def tearDown(self):
        self.document.close()
        self.temporary.cleanup()

    def text(self, point=(50, 80), text='Neutral words'):
        self.page.insert_text(point, text, fontsize=18)

    def cover(self, opacity=1, overlay=True):
        self.page.draw_rect(fitz.Rect(40, 50, 250, 100), color=None,
                            fill=(1, 1, 1), fill_opacity=opacity, overlay=overlay)

    def detect(self, checks=None):
        self.document.save(self.path)
        return inspector.detect_issues(str(self.path), checks=checks or ['overlap', 'overflow', 'readability'])

    def test_later_opaque_cover_detected(self):
        self.text()
        self.cover()
        result = self.detect(['overlap'])
        self.assertEqual(result['summary']['errors'], 1)
        self.assertEqual(result['issues'][0]['metadata']['assessment'], 'confirmed')
        self.assertGreater(result['issues'][0]['metadata']['coveredGlyphCount'], 0)
        self.assertEqual(len(result['structure'][0]['elements']), 2)
        self.assertTrue(result['structure'][0]['metadata']['inspectionLimitations'])

    def test_background_and_text_preserved(self):
        self.cover()
        self.text()
        result = self.detect(['overlap'])
        self.assertEqual(result['issues'], [])
        self.assertEqual({element['type'] for element in result['structure'][0]['elements']}, {'text', 'shape'})

    def test_overlay_false_is_background(self):
        self.text()
        self.cover(overlay=False)
        self.assertEqual(self.detect(['overlap'])['issues'], [])

    def test_transparency_not_opaque_mask(self):
        self.text()
        self.cover(opacity=.4)
        self.assertEqual(self.detect(['overlap'])['issues'], [])

    def test_stroke_only_rectangle_not_mask(self):
        self.text()
        self.page.draw_rect(fitz.Rect(40, 50, 250, 100), color=(0, 0, 0), fill=None)
        self.assertEqual(self.detect(['overlap'])['issues'], [])

    def test_circle_not_opaque_rect(self):
        self.text()
        self.page.draw_circle((120, 80), 80, color=None, fill=(1, 1, 1))
        result = self.detect(['overlap'])
        self.assertEqual(result['summary']['errors'], 0)
        self.assertTrue(result['issues'])
        self.assertTrue(all(issue['metadata']['assessment'] == 'candidate' for issue in result['issues']))

    def test_circle_behind_text_is_not_an_occluder(self):
        self.page.draw_circle((120, 80), 80, color=None, fill=(1, 1, 1))
        self.text()
        self.assertEqual(self.detect(['overlap'])['issues'], [])

    def test_partial_glyph_cover_not_confirmed(self):
        self.text()
        self.page.draw_rect(fitz.Rect(50, 79, 250, 81), color=None, fill=(1, 1, 1))
        result = self.detect(['overlap'])
        self.assertEqual(result['summary']['errors'], 0)
        self.assertTrue(result['issues'])

    def test_text_overlap_detected_in_merged_blocks(self):
        self.text()
        self.text(point=(52, 82), text='Second words')
        issues = self.detect(['overlap'])['issues']
        self.assertTrue(issues)
        self.assertTrue(all(issue['metadata']['assessment'] == 'candidate' for issue in issues))

    def test_separate_text_no_collision(self):
        self.text()
        self.text(point=(50, 120), text='Another line')
        self.assertEqual(self.detect(['overlap'])['issues'], [])

    def test_rotated_page_cover(self):
        self.text()
        self.cover()
        self.page.set_rotation(90)
        result = self.detect()
        self.assertEqual(result['summary']['errors'], 1)
        self.assertFalse(any(issue['type'] == 'overflow' for issue in result['issues']))

    def test_hidden_ocr_text_not_cover_issue(self):
        self.page.insert_text((50, 80), 'Invisible OCR', fontsize=18, render_mode=3)
        self.cover()
        self.assertEqual(self.detect(['overlap'])['issues'], [])

    def test_clipped_away_rectangle_not_mask(self):
        self.text()
        self.cover()
        stream_id = self.page.get_contents()[-1]
        content = self.document.xref_stream(stream_id)
        self.document.update_stream(stream_id, b'q 0 0 10 10 re W n\n' + content + b'\nQ')
        self.assertEqual(self.detect(['overlap'])['issues'], [])

    def test_clip_that_keeps_cover_still_detected(self):
        self.text()
        self.cover()
        stream_id = self.page.get_contents()[-1]
        content = self.document.xref_stream(stream_id)
        self.document.update_stream(stream_id, b'q 0 0 400 300 re W n\n' + content + b'\nQ')
        self.assertEqual(self.detect(['overlap'])['summary']['errors'], 1)

    def test_compound_path_hole_not_strong_cover(self):
        self.text()
        drawing = self.page.new_shape()
        drawing.draw_rect(fitz.Rect(20, 20, 300, 150))
        drawing.draw_rect(fitz.Rect(30, 30, 290, 140))
        drawing.finish(fill=(1, 1, 1), color=None, even_odd=True)
        drawing.commit()
        self.assertEqual(self.detect(['overlap'])['summary']['errors'], 0)

    def insert_image(self):
        pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 4, 4), False)
        pixmap.clear_with(220)
        self.page.insert_image(fitz.Rect(30, 30, 280, 280), stream=pixmap.tobytes('png'))

    def test_background_image_not_text_collision(self):
        self.insert_image()
        self.text()
        self.assertEqual(self.detect(['overlap'])['issues'], [])

    def test_foreground_image_remains_alpha_candidate(self):
        self.text()
        self.insert_image()
        issues = self.detect(['overlap'])['issues']
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]['metadata']['assessment'], 'candidate')
        self.assertIn('later_image', issues[0]['metadata']['reasonCodes'])

    def test_cli_and_search_compatibility(self):
        self.text()
        self.document.save(self.path)
        request = {'action': 'detect_issues', 'pdfPath': str(self.path), 'page': 1}
        process = subprocess.run([sys.executable, str(Path(inspector.__file__))],
            input=json.dumps(request), text=True, encoding='utf-8', capture_output=True,
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1'}, timeout=20)
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        self.assertTrue(json.loads(process.stdout)['ok'])
        self.assertTrue(inspector.search_text_region(str(self.path), 'Neutral')['found'])

    def test_issue_limit_retains_partial_results(self):
        self.text()
        for index in range(8):
            self.cover()
        with patch('inspection_geometry.MAX_INSPECTION_ISSUES', 3):
            result = self.detect(['overlap'])
        self.assertEqual(len(result['issues']), 3)
        self.assertTrue(result['structure'][0]['metadata']['inspectionBudget']['issueLimitReached'])

    def test_pair_limit_marked_even_without_issues(self):
        for index in range(8):
            self.cover()
        with patch('inspection_geometry.MAX_COMPARISON_PAIRS', 4):
            result = self.detect(['overlap'])
        self.assertEqual(result['issues'], [])
        self.assertTrue(result['structure'][0]['metadata']['inspectionBudget']['pairLimitReached'])

    def test_auto_screenshot_count_cap_is_explicit(self):
        self.text()
        for index in range(10):
            self.cover()
        self.document.save(self.path)
        with patch.object(inspector, '_issue_screenshot', return_value='neutral.png') as screenshot:
            result = inspector.detect_issues(str(self.path), checks=['overlap'], auto_screenshot=True,
                                             screenshot_dir=self.temporary.name)
        self.assertEqual(screenshot.call_count, 8)
        self.assertEqual(len(result['issues']), 10)
        self.assertEqual(sum('screenshotPath' in issue for issue in result['issues']), 8)
        self.assertEqual(result['issues'][-1]['metadata']['screenshotOmittedReason'], 'auto_screenshot_budget_exceeded')
        self.assertEqual(result['issues'][-1]['metadata']['screenshotStatus'], 'budget_exceeded')
        self.assertFalse(result['issues'][-1]['metadata']['screenshotPending'])

    def test_auto_screenshot_pixel_cap_skips_render(self):
        issue = {'page': 1, 'bounds': {'x0': 0, 'y0': 0, 'x1': 10000, 'y1': 10000}}
        with patch.object(inspector, 'region_screenshot') as render:
            result = inspector._issue_screenshot(str(self.path), issue, 1.4, self.temporary.name, 1)
        self.assertIsNone(result)
        render.assert_not_called()
        self.assertEqual(issue['metadata']['screenshotOmittedReason'], 'auto_screenshot_pixel_budget_exceeded')
        self.assertEqual(issue['metadata']['screenshotStatus'], 'budget_exceeded')
        self.assertFalse(issue['metadata']['screenshotPending'])

    def test_glyph_trace_limit_is_not_silent(self):
        self.text()
        with patch('pdf_evidence.MAX_GLYPHS_PER_ELEMENT', 2):
            result = self.detect(['overlap'])
        metadata = result['structure'][0]['metadata']
        self.assertTrue(metadata['inspectionBudget']['detailLimitReached'])
        self.assertTrue(any('Glyph tracing capped' in item for item in metadata['inspectionLimitations']))

    def test_zero_opacity_text_not_confirmed_cover(self):
        self.page.insert_text((50, 80), 'Transparent', fontsize=18, fill_opacity=0)
        self.cover()
        self.assertEqual(self.detect(['overlap'])['issues'], [])

    def test_text_comparison_limit_remains_candidate(self):
        self.text()
        self.text(point=(51, 81), text='Another neutral line')
        with patch('pdf_evidence.MAX_TEXT_COMPARISONS', 1):
            result = self.detect(['overlap'])
        self.assertTrue(any('text_comparison_budget_exceeded' in issue['metadata']['reasonCodes'] for issue in result['issues']))
        self.assertTrue(result['structure'][0]['metadata']['inspectionBudget']['detailLimitReached'])


if __name__ == '__main__':
    unittest.main()
