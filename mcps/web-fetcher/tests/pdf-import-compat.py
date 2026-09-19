import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]
INSPECTOR_PATH = ROOT / "src" / "inspector"
TARGET_MODULES = ("pdf_evidence", "pdf_inspector")
LEGACY_WARNING = "LEGACY_FITZ_STDOUT_WARNING"


class PdfImportCompat(unittest.TestCase):
    def run_import(self, module_name, modules):
        with tempfile.TemporaryDirectory(prefix="pdf-import-compat-") as temporary:
            module_root = Path(temporary)
            for name, source in modules.items():
                (module_root / name).write_text(textwrap.dedent(source).lstrip(), encoding="utf-8")

            script = """
import importlib
import json
import sys

module = importlib.import_module(sys.argv[1])
fitz = getattr(module, "fitz", None)
print(json.dumps({
    "module": sys.argv[1],
    "fitzModule": getattr(fitz, "__name__", None),
    "fitzMarker": getattr(fitz, "MARKER", None),
}))
"""
            env = os.environ.copy()
            env["PYTHONPATH"] = os.pathsep.join((str(module_root), str(INSPECTOR_PATH)))
            env["PYTHONNOUSERSITE"] = "1"
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            return subprocess.run(
                [sys.executable, "-S", "-c", script, module_name],
                cwd=str(ROOT),
                env=env,
                capture_output=True,
                text=True,
            )

    def parse_stdout_json(self, completed):
        self.assertEqual(
            completed.returncode,
            0,
            f"child import failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        return json.loads(completed.stdout)

    def test_prefers_canonical_pymupdf_without_importing_legacy_fitz_warning(self):
        modules = {
            "pymupdf.py": """
MARKER = "canonical"

class Rect:
    pass

class Document:
    pass
""",
            "fitz.py": f"""
print("{LEGACY_WARNING}")
MARKER = "legacy"

class Rect:
    pass

class Document:
    pass
""",
        }

        for module_name in TARGET_MODULES:
            with self.subTest(module=module_name):
                completed = self.run_import(module_name, modules)
                combined_output = completed.stdout + completed.stderr
                self.assertNotIn(LEGACY_WARNING, combined_output)
                payload = self.parse_stdout_json(completed)
                self.assertEqual(payload["fitzModule"], "pymupdf")
                self.assertEqual(payload["fitzMarker"], "canonical")

    def test_falls_back_to_legacy_fitz_when_pymupdf_module_is_absent(self):
        modules = {
            "fitz.py": """
MARKER = "legacy"

class Rect:
    pass

class Document:
    pass
""",
        }

        for module_name in TARGET_MODULES:
            with self.subTest(module=module_name):
                payload = self.parse_stdout_json(self.run_import(module_name, modules))
                self.assertEqual(payload["fitzModule"], "fitz")
                self.assertEqual(payload["fitzMarker"], "legacy")

    def test_internal_pymupdf_dependency_error_is_not_treated_as_absent_pymupdf(self):
        modules = {
            "pymupdf.py": """
raise ModuleNotFoundError(
    "No module named 'pymupdf._native'",
    name="pymupdf._native",
)
""",
            "fitz.py": f"""
print("{LEGACY_WARNING}")
MARKER = "legacy"

class Rect:
    pass

class Document:
    pass
""",
        }

        for module_name in TARGET_MODULES:
            with self.subTest(module=module_name):
                completed = self.run_import(module_name, modules)
                self.assertNotEqual(completed.returncode, 0)
                self.assertIn("pymupdf._native", completed.stderr)
                self.assertNotIn(LEGACY_WARNING, completed.stdout + completed.stderr)


if __name__ == "__main__":
    unittest.main()
