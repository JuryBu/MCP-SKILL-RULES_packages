from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

import pypdfium2 as pdfium

from .ledger import LedgerError, utc_now


MAX_OPENXML_FILES = 20_000
MAX_OPENXML_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
OFFICE_CONVERSION_TIMEOUT_SECONDS = 120
DERIVED_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


class LocalOfficeConverter:
    def __init__(
        self,
        derived_root: str | Path,
        soffice_path: str | Path,
        *,
        timeout_seconds: int = OFFICE_CONVERSION_TIMEOUT_SECONDS,
    ) -> None:
        self.derived_root = Path(derived_root).resolve()
        self.soffice_path = Path(soffice_path).resolve()
        self.timeout_seconds = timeout_seconds

    def _launcher_path(self) -> Path:
        if os.name == "nt" and self.soffice_path.suffix.lower() == ".com":
            gui_launcher = self.soffice_path.with_suffix(".exe")
            if gui_launcher.is_file():
                return gui_launcher
            raise LedgerError(
                "ATTACHMENT_OFFICE_GUI_LAUNCHER_REQUIRED",
                "Windows 上必须使用不会创建控制台窗口的 soffice.exe",
            )
        return self.soffice_path

    @staticmethod
    def _hidden_subprocess_options() -> dict[str, Any]:
        if os.name != "nt":
            return {}
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE
        return {
            "creationflags": subprocess.CREATE_NO_WINDOW,
            "startupinfo": startupinfo,
        }

    @staticmethod
    def _validate_openxml(source: Path) -> str:
        suffix = source.suffix.lower()
        if suffix not in {".docx", ".pptx"}:
            if suffix in {".xlsx", ".xlsm", ".xlsb"}:
                raise LedgerError(
                    "ATTACHMENT_XLSX_VISUAL_UNSUPPORTED",
                    "XLSX 不自动分页；请下载原件后交给 spreadsheet 工具读取",
                )
            raise LedgerError(
                "ATTACHMENT_OFFICE_UNSUPPORTED",
                "仅 DOCX/PPTX 支持受控转 PDF",
            )
        try:
            with zipfile.ZipFile(source) as archive:
                entries = archive.infolist()
                if len(entries) > MAX_OPENXML_FILES:
                    raise LedgerError("ATTACHMENT_OFFICE_ZIP_BOMB", "Office 文件条目数超过安全上限")
                if any(entry.flag_bits & 0x1 for entry in entries):
                    raise LedgerError("ATTACHMENT_OFFICE_ENCRYPTED", "加密 Office 文件不支持转换")
                total_size = sum(entry.file_size for entry in entries)
                if total_size > MAX_OPENXML_UNCOMPRESSED_BYTES:
                    raise LedgerError("ATTACHMENT_OFFICE_ZIP_BOMB", "Office 解压后大小超过安全上限")
                if archive.testzip() is not None:
                    raise LedgerError("ATTACHMENT_OFFICE_CORRUPT", "Office 压缩包校验失败")
                lowered = {entry.filename.lower() for entry in entries}
                if any(name.endswith("vbaproject.bin") for name in lowered):
                    raise LedgerError("ATTACHMENT_OFFICE_MACRO", "含宏的 Office 文件拒绝转换")
                content_types = archive.read("[Content_Types].xml").decode("utf-8", errors="replace")
                if "macroenabled" in content_types.lower():
                    raise LedgerError("ATTACHMENT_OFFICE_MACRO", "宏启用的 Office 文件拒绝转换")
                for entry in entries:
                    if not entry.filename.lower().endswith(".rels"):
                        continue
                    try:
                        root = ET.fromstring(archive.read(entry))
                    except ET.ParseError as error:
                        raise LedgerError("ATTACHMENT_OFFICE_CORRUPT", "Office 关系文件损坏") from error
                    for relationship in root.iter():
                        if relationship.attrib.get("TargetMode", "").lower() == "external":
                            raise LedgerError(
                                "ATTACHMENT_OFFICE_EXTERNAL_RELATIONSHIP",
                                "Office 文件含外部关系，离线转换拒绝访问网络资源",
                            )
        except LedgerError:
            raise
        except (KeyError, OSError, zipfile.BadZipFile) as error:
            raise LedgerError("ATTACHMENT_OFFICE_CORRUPT", "Office 文件不是有效 OpenXML 包") from error
        return "docx" if suffix == ".docx" else "pptx"

    def _converter_version(self) -> str:
        launcher = self._launcher_path()
        if not launcher.is_file():
            raise LedgerError("ATTACHMENT_OFFICE_CONVERTER_MISSING", "LibreOffice 转换器不存在")
        build_id = "unknown"
        version_file = launcher.with_name("version.ini")
        try:
            if version_file.is_file():
                for line in version_file.read_text(encoding="utf-8", errors="replace").splitlines():
                    if line.lower().startswith("buildid="):
                        build_id = line.split("=", 1)[1].strip() or "unknown"
                        break
            executable_sha256 = _sha256(launcher)
        except OSError as error:
            raise LedgerError("ATTACHMENT_OFFICE_CONVERTER_FAILED", "无法读取 LibreOffice 安装身份") from error
        return f"LibreOffice buildid={build_id} executable_sha256={executable_sha256}"

    @staticmethod
    def _write_isolated_profile(profile: Path) -> None:
        user = profile / "user"
        user.mkdir(parents=True, exist_ok=True)
        (user / "registrymodifications.xcu").write_text(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
            "<oor:items xmlns:oor=\"http://openoffice.org/2001/registry\">"
            "<item oor:path=\"/org.openoffice.Office.Security/Scripting\">"
            "<prop oor:name=\"MacroSecurityLevel\" oor:op=\"fuse\"><value>3</value></prop>"
            "</item></oor:items>",
            encoding="utf-8",
        )

    def _invoke(self, source: Path, output_dir: Path, profile: Path) -> dict[str, Any]:
        self._write_isolated_profile(profile)
        environment = os.environ.copy()
        environment.pop("PYTHONHOME", None)
        environment.pop("PYTHONPATH", None)
        environment.update(
            {
                "HTTP_PROXY": "http://127.0.0.1:9",
                "HTTPS_PROXY": "http://127.0.0.1:9",
                "ALL_PROXY": "http://127.0.0.1:9",
                "NO_PROXY": "",
            }
        )
        command = [
            str(self._launcher_path()),
            "--headless",
            "--invisible",
            "--nologo",
            "--nodefault",
            "--nolockcheck",
            "--norestore",
            f"-env:UserInstallation={profile.as_uri()}",
            "--convert-to",
            "pdf",
            "--outdir",
            str(output_dir),
            str(source),
        ]
        try:
            result = subprocess.run(
                command,
                cwd=output_dir,
                env=environment,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.timeout_seconds,
                check=False,
                **self._hidden_subprocess_options(),
            )
        except subprocess.TimeoutExpired as error:
            raise LedgerError("ATTACHMENT_OFFICE_CONVERSION_TIMEOUT", "Office 转 PDF 超时") from error
        except OSError as error:
            raise LedgerError("ATTACHMENT_OFFICE_CONVERTER_FAILED", "LibreOffice 启动失败") from error
        diagnostics = "\n".join(part for part in (result.stdout, result.stderr) if part)
        return {
            "returncode": result.returncode,
            "diagnostics_sha256": hashlib.sha256(diagnostics.encode("utf-8")).hexdigest(),
            "warning_codes": [
                code
                for code, marker in (
                    ("FONT_WARNING_PRESENT", "font"),
                    ("LAYOUT_WARNING_PRESENT", "layout"),
                )
                if marker in diagnostics.lower()
            ],
        }

    @staticmethod
    def _page_count(path: Path) -> int:
        try:
            document = pdfium.PdfDocument(path)
            count = len(document)
            document.close()
        except Exception as error:
            raise LedgerError("ATTACHMENT_OFFICE_DERIVED_PDF_INVALID", "派生 PDF 无法读取") from error
        if count < 1:
            raise LedgerError("ATTACHMENT_OFFICE_DERIVED_PDF_INVALID", "派生 PDF 没有页面")
        return count

    def convert(self, attachment_ref: str, source: str | Path, source_sha256: str) -> dict[str, Any]:
        source_path = Path(source).resolve()
        if not source_path.is_file() or _sha256(source_path) != source_sha256:
            raise LedgerError("ATTACHMENT_SOURCE_INTEGRITY", "Office 原件不存在或 SHA-256 不匹配")
        document_kind = self._validate_openxml(source_path)
        converter_version = self._converter_version()
        cache_key = hashlib.sha256(
            f"{attachment_ref}\0{source_sha256}\0{converter_version}".encode("utf-8")
        ).hexdigest()
        cache_root = self.derived_root / "office" / cache_key
        derived_pdf = cache_root / "derived.pdf"
        metadata_path = cache_root / "metadata.json"
        if derived_pdf.is_file() and metadata_path.is_file():
            try:
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                metadata = {}
            if (
                metadata.get("source_sha256") == source_sha256
                and metadata.get("converter_version") == converter_version
                and metadata.get("derived_pdf_sha256") == _sha256(derived_pdf)
            ):
                return {**metadata, "derived_pdf_path": str(derived_pdf), "cache_hit": True}

        self.derived_root.mkdir(parents=True, exist_ok=True)
        work_root = Path(tempfile.mkdtemp(prefix="office-convert-"))
        try:
            source_copy = work_root / f"source{source_path.suffix.lower()}"
            shutil.copyfile(source_path, source_copy)
            output_dir = work_root / "output"
            output_dir.mkdir()
            diagnostics = self._invoke(source_copy, output_dir, work_root / "profile")
            converted = output_dir / "source.pdf"
            if diagnostics["returncode"] != 0 or not converted.is_file():
                raise LedgerError("ATTACHMENT_OFFICE_CONVERSION_FAILED", "LibreOffice 未生成 PDF")
            with converted.open("rb") as stream:
                if stream.read(5) != b"%PDF-":
                    raise LedgerError("ATTACHMENT_OFFICE_DERIVED_PDF_INVALID", "派生文件不是 PDF")
            page_count = self._page_count(converted)
            pdf_sha256 = _sha256(converted)
            staged = work_root / f"cache-{uuid.uuid4().hex}"
            staged.mkdir()
            shutil.copyfile(converted, staged / "derived.pdf")
            metadata = {
                "attachment_ref": attachment_ref,
                "document_kind": document_kind,
                "source_sha256": source_sha256,
                "converter": "LibreOffice headless",
                "converter_version": converter_version,
                "derived_pdf_sha256": pdf_sha256,
                "page_count": page_count,
                "font_substitution_detected": None,
                "layout_warning_detected": None,
                "diagnostics_complete": False,
                "warning_codes": diagnostics["warning_codes"],
                "diagnostics_sha256": diagnostics["diagnostics_sha256"],
                "created_at": utc_now(),
            }
            (staged / "metadata.json").write_text(
                json.dumps(metadata, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            cache_root.parent.mkdir(parents=True, exist_ok=True)
            if cache_root.exists():
                shutil.rmtree(cache_root)
            staged.replace(cache_root)
            return {**metadata, "derived_pdf_path": str(derived_pdf), "cache_hit": False}
        finally:
            shutil.rmtree(work_root, ignore_errors=True)

    def cleanup_expired(self, max_age_seconds: int = DERIVED_CACHE_TTL_SECONDS) -> int:
        office_root = (self.derived_root / "office").resolve()
        if not office_root.is_dir() or not _inside(office_root, self.derived_root):
            return 0
        threshold = time.time() - max_age_seconds
        removed = 0
        for candidate in office_root.iterdir():
            metadata = candidate / "metadata.json"
            if not candidate.is_dir() or not metadata.is_file() or metadata.stat().st_mtime >= threshold:
                continue
            if _inside(candidate, office_root):
                shutil.rmtree(candidate)
                removed += 1
        return removed
