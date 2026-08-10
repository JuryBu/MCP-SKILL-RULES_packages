from __future__ import annotations

import base64
import hashlib
import io
import json
import random
import zipfile
from pathlib import Path

import pytest
from PIL import Image

from wechat_docs_mcp.attachment_reader import VisualAttachmentReader
from wechat_docs_mcp.attachments import AttachmentRegistry
from wechat_docs_mcp.ledger import EventLedger, LedgerError
from wechat_docs_mcp.office_converter import LocalOfficeConverter


def image_bytes(size: tuple[int, int] = (80, 60), format_name: str = "PNG") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, (44, 120, 200)).save(buffer, format=format_name)
    return buffer.getvalue()


def noisy_image_bytes(size: tuple[int, int]) -> bytes:
    width, height = size
    pixels = random.Random(20260810).randbytes(width * height * 3)
    buffer = io.BytesIO()
    Image.frombytes("RGB", size, pixels).save(buffer, format="PNG")
    return buffer.getvalue()


def pdf_bytes(page_count: int = 3, size: tuple[int, int] = (480, 640)) -> bytes:
    pages = [Image.new("RGB", size, (240 - index * 20, 245, 250)) for index in range(page_count)]
    buffer = io.BytesIO()
    pages[0].save(buffer, format="PDF", save_all=True, append_images=pages[1:])
    return buffer.getvalue()


class MappingMaterializer:
    def __init__(self, payloads: dict[str, bytes]) -> None:
        self.payloads = payloads
        self.calls: list[str] = []

    def materialize(self, attachment: dict[str, object], destination: Path) -> str:
        attachment_ref = str(attachment["attachment_ref"])
        self.calls.append(attachment_ref)
        destination.write_bytes(self.payloads[attachment_ref])
        return "test_materializer"


@pytest.fixture()
def reader_fixture(tmp_path: Path) -> tuple[VisualAttachmentReader, EventLedger, str, MappingMaterializer]:
    ledger = EventLedger(tmp_path / "events.sqlite3")
    ledger.register_route(
        "route-a",
        profile="test",
        identity={"chat_name": "sanitized", "chat_type": "group", "username": "room"},
        state="active",
    )
    ledger.register_subscription(
        "route-a",
        "conversation-a",
        1,
        subscription_id="subscription-a",
        policy_ref="test-policy",
    )
    registry = AttachmentRegistry(ledger, tmp_path / "intake", tmp_path / "upload")
    registry.intake_root.mkdir()
    registry.upload_root.mkdir()
    materializer = MappingMaterializer({})
    reader = VisualAttachmentReader(registry, materializer, tmp_path / "derived")
    return reader, ledger, "subscription-a", materializer


def add_attachment(
    ledger: EventLedger,
    materializer: MappingMaterializer,
    fingerprint: str,
    kind: str,
    file_name: str,
    data: bytes,
) -> tuple[str, str]:
    event = ledger.ingest_event(
        "route-a",
        fingerprint,
        kind,
        {
            "local_id": len(materializer.payloads) + 1,
            "server_id": 100 + len(materializer.payloads),
            "attachment_name": file_name,
            "attachment_size": len(data),
            "attachment_md5": hashlib.md5(data).hexdigest(),
        },
    )
    attachment_ref = ledger.list_pending("subscription-a")[-1]["payload"]["attachment_ref"]
    materializer.payloads[attachment_ref] = data
    return event["event_id"], attachment_ref


def test_mixed_image_pdf_continuation_is_stable_and_complete(
    reader_fixture: tuple[VisualAttachmentReader, EventLedger, str, MappingMaterializer]
) -> None:
    reader, ledger, subscription_id, materializer = reader_fixture
    _, image_ref = add_attachment(ledger, materializer, "image", "image", "sample.png", image_bytes())
    _, pdf_ref = add_attachment(ledger, materializer, "pdf", "file", "sample.pdf", pdf_bytes(2))

    first = reader.read(subscription_id, [image_ref, pdf_ref], max_images=1)
    first_manifest = first.structured_content
    assert [item["unit_id"] for item in first_manifest["returned"]] == [f"{image_ref}:image"]
    assert first_manifest["remaining"] == [f"{pdf_ref}:page:1", f"{pdf_ref}:page:2"]
    assert first.content[1].type == "image"
    assert base64.b64decode(first.content[1].data).startswith(b"\x89PNG")

    second = reader.read(
        subscription_id,
        [image_ref, pdf_ref],
        continuation_cursor=first_manifest["continuation_cursor"],
        max_images=1,
    )
    repeated = reader.read(
        subscription_id,
        [image_ref, pdf_ref],
        continuation_cursor=first_manifest["continuation_cursor"],
        max_images=1,
    )
    assert second.structured_content["returned"][0]["unit_id"] == f"{pdf_ref}:page:1"
    assert second.content[1].data == repeated.content[1].data
    assert second.structured_content["continuation_cursor"] == repeated.structured_content["continuation_cursor"]
    assert materializer.calls.count(image_ref) == 1
    assert materializer.calls.count(pdf_ref) == 1


def test_page_ranges_select_exact_pages(
    reader_fixture: tuple[VisualAttachmentReader, EventLedger, str, MappingMaterializer]
) -> None:
    reader, ledger, subscription_id, materializer = reader_fixture
    _, pdf_ref = add_attachment(ledger, materializer, "pdf-ranges", "file", "sample.pdf", pdf_bytes(4))
    result = reader.read(
        subscription_id,
        [pdf_ref],
        pages={pdf_ref: [1]},
        page_ranges={pdf_ref: ["3-4"]},
    )
    assert [item["page_number"] for item in result.structured_content["returned"]] == [1, 3, 4]
    assert result.structured_content["remaining"] == []


def test_duplicate_and_forged_refs_are_rejected(
    reader_fixture: tuple[VisualAttachmentReader, EventLedger, str, MappingMaterializer]
) -> None:
    reader, ledger, subscription_id, materializer = reader_fixture
    _, image_ref = add_attachment(ledger, materializer, "image-ref", "image", "sample.png", image_bytes())
    with pytest.raises(LedgerError) as duplicate:
        reader.read(subscription_id, [image_ref, image_ref])
    assert duplicate.value.code == "ATTACHMENT_REF_DUPLICATE"
    with pytest.raises(LedgerError) as forged:
        reader.read(subscription_id, ["att_forged"])
    assert forged.value.code == "ATTACHMENT_REF_NOT_DELIVERED"


def test_corrupt_and_encrypted_pdf_fail_explicitly(
    reader_fixture: tuple[VisualAttachmentReader, EventLedger, str, MappingMaterializer],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reader, ledger, subscription_id, materializer = reader_fixture
    _, corrupt_ref = add_attachment(
        ledger, materializer, "bad-pdf", "file", "bad.pdf", b"%PDF-corrupt"
    )
    with pytest.raises(LedgerError) as corrupt:
        reader.read(subscription_id, [corrupt_ref])
    assert corrupt.value.code == "ATTACHMENT_PDF_CORRUPT"

    _, encrypted_ref = add_attachment(
        ledger, materializer, "encrypted-pdf", "file", "encrypted.pdf", b"%PDF-encrypted"
    )
    monkeypatch.setattr(
        "wechat_docs_mcp.attachment_reader.pdfium.PdfDocument",
        lambda path: (_ for _ in ()).throw(RuntimeError("password required")),
    )
    with pytest.raises(LedgerError) as encrypted:
        reader.read(subscription_id, [encrypted_ref])
    assert encrypted.value.code == "ATTACHMENT_PDF_ENCRYPTED"


def test_pixel_and_wire_byte_budgets_are_reported(
    reader_fixture: tuple[VisualAttachmentReader, EventLedger, str, MappingMaterializer]
) -> None:
    reader, ledger, subscription_id, materializer = reader_fixture
    _, image_ref = add_attachment(
        ledger,
        materializer,
        "large-image",
        "image",
        "large.jpg",
        image_bytes((1200, 900), "JPEG"),
    )
    result = reader.read(
        subscription_id,
        [image_ref],
        max_pixels=160_000,
        max_bytes=300_000,
    )
    manifest = result.structured_content
    assert manifest["budget"]["used_pixels"] <= 160_000
    assert manifest["budget"]["used_bytes"] <= 300_000
    assert manifest["returned"][0]["scaled"] is True


def test_preview_rescaling_preserves_extreme_aspect_ratio(
    reader_fixture: tuple[VisualAttachmentReader, EventLedger, str, MappingMaterializer]
) -> None:
    reader, ledger, subscription_id, materializer = reader_fixture
    _, image_ref = add_attachment(
        ledger,
        materializer,
        "panorama",
        "image",
        "panorama.png",
        noisy_image_bytes((1200, 60)),
    )
    result = reader.read(
        subscription_id,
        [image_ref],
        max_pixels=70_000,
        max_bytes=20_000,
    )
    item = result.structured_content["returned"][0]
    assert item["scaled"] is True
    assert item["returned_height"] < 192
    assert item["returned_width"] / item["returned_height"] == pytest.approx(20, rel=0.06)


def test_original_mode_rejects_oversize_without_dropping_original(
    reader_fixture: tuple[VisualAttachmentReader, EventLedger, str, MappingMaterializer]
) -> None:
    reader, ledger, subscription_id, materializer = reader_fixture
    _, image_ref = add_attachment(
        ledger,
        materializer,
        "original-too-large",
        "image",
        "large.png",
        image_bytes((1200, 900)),
    )
    with pytest.raises(LedgerError) as error:
        reader.read(subscription_id, [image_ref], mode="original", max_pixels=100_000)
    assert error.value.code == "ATTACHMENT_ORIGINAL_EXCEEDS_BUDGET"
    transfer = reader.registry._verified_download(subscription_id, image_ref)
    assert transfer is not None
    assert Path(transfer["local_path"]).is_file()


def test_duplicate_and_out_of_range_pages_are_rejected(
    reader_fixture: tuple[VisualAttachmentReader, EventLedger, str, MappingMaterializer]
) -> None:
    reader, ledger, subscription_id, materializer = reader_fixture
    _, pdf_ref = add_attachment(ledger, materializer, "page-errors", "file", "sample.pdf", pdf_bytes(2))
    with pytest.raises(LedgerError) as duplicate:
        reader.read(subscription_id, [pdf_ref], pages={pdf_ref: [1]}, page_ranges={pdf_ref: ["1-2"]})
    assert duplicate.value.code == "ATTACHMENT_PAGE_DUPLICATE"
    with pytest.raises(LedgerError) as out_of_range:
        reader.read(subscription_id, [pdf_ref], pages={pdf_ref: [3]})
    assert out_of_range.value.code == "ATTACHMENT_PAGE_OUT_OF_RANGE"


def write_openxml(path: Path, *, macro: bool = False, external: bool = False) -> None:
    relationship = (
        '<Relationship Id="rId1" Target="https://invalid.example/" TargetMode="External"/>'
        if external
        else '<Relationship Id="rId1" Target="word/document.xml"/>'
    )
    content_type = "application/vnd.ms-word.document.macroEnabled.main+xml" if macro else "application/xml"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            f'<Types><Override PartName="/word/document.xml" ContentType="{content_type}"/></Types>',
        )
        archive.writestr("_rels/.rels", f"<Relationships>{relationship}</Relationships>")
        archive.writestr("word/document.xml", "<document/>")
        if macro:
            archive.writestr("word/vbaProject.bin", b"macro")


class FakeOfficeConverter(LocalOfficeConverter):
    def _converter_version(self) -> str:
        return "LibreOffice Test 1.0"

    def _invoke(self, source: Path, output_dir: Path, profile: Path) -> dict[str, object]:
        (output_dir / "source.pdf").write_bytes(pdf_bytes(2))
        return {"returncode": 0, "diagnostics_sha256": "0" * 64, "warning_codes": []}


class FailingOfficeConverter(FakeOfficeConverter):
    def _invoke(self, source: Path, output_dir: Path, profile: Path) -> dict[str, object]:
        return {"returncode": 1, "diagnostics_sha256": "f" * 64, "warning_codes": []}


def test_office_conversion_cache_and_policy(tmp_path: Path) -> None:
    source = tmp_path / "sample.docx"
    write_openxml(source)
    source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    converter = FakeOfficeConverter(tmp_path / "derived", tmp_path / "soffice.exe")
    first = converter.convert("att_docx", source, source_sha)
    second = converter.convert("att_docx", source, source_sha)
    assert first["page_count"] == 2
    assert first["cache_hit"] is False
    assert second["cache_hit"] is True
    assert first["derived_pdf_sha256"] == second["derived_pdf_sha256"]
    assert Path(first["derived_pdf_path"]).is_file()

    macro = tmp_path / "macro.docx"
    write_openxml(macro, macro=True)
    with pytest.raises(LedgerError) as macro_error:
        converter.convert("att_macro", macro, hashlib.sha256(macro.read_bytes()).hexdigest())
    assert macro_error.value.code == "ATTACHMENT_OFFICE_MACRO"

    external = tmp_path / "external.docx"
    write_openxml(external, external=True)
    with pytest.raises(LedgerError) as external_error:
        converter.convert("att_external", external, hashlib.sha256(external.read_bytes()).hexdigest())
    assert external_error.value.code == "ATTACHMENT_OFFICE_EXTERNAL_RELATIONSHIP"


def test_pptx_cache_corrupt_xlsx_and_conversion_failure(tmp_path: Path) -> None:
    pptx = tmp_path / "sample.pptx"
    write_openxml(pptx)
    source_sha = hashlib.sha256(pptx.read_bytes()).hexdigest()
    converter = FakeOfficeConverter(tmp_path / "derived", tmp_path / "soffice.exe")
    first = converter.convert("att_pptx", pptx, source_sha)
    second = converter.convert("att_pptx", pptx, source_sha)
    assert first["document_kind"] == "pptx"
    assert first["page_count"] == 2
    assert second["cache_hit"] is True
    assert first["font_substitution_detected"] is None
    assert first["layout_warning_detected"] is None

    corrupt = tmp_path / "corrupt.docx"
    corrupt.write_bytes(b"not-an-openxml-package")
    with pytest.raises(LedgerError) as corrupt_error:
        converter.convert("att_corrupt", corrupt, hashlib.sha256(corrupt.read_bytes()).hexdigest())
    assert corrupt_error.value.code == "ATTACHMENT_OFFICE_CORRUPT"

    xlsx = tmp_path / "sheet.xlsx"
    xlsx.write_bytes(b"download-only")
    with pytest.raises(LedgerError) as xlsx_error:
        converter.convert("att_xlsx", xlsx, hashlib.sha256(xlsx.read_bytes()).hexdigest())
    assert xlsx_error.value.code == "ATTACHMENT_XLSX_VISUAL_UNSUPPORTED"

    failing = FailingOfficeConverter(tmp_path / "failed-derived", tmp_path / "soffice.exe")
    with pytest.raises(LedgerError) as conversion_error:
        failing.convert("att_failure", pptx, source_sha)
    assert conversion_error.value.code == "ATTACHMENT_OFFICE_CONVERSION_FAILED"


def test_converter_version_uses_files_without_launching_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    program = tmp_path / "program"
    program.mkdir()
    executable = program / "soffice.exe"
    executable.write_bytes(b"offline-converter-fixture")
    (program / "version.ini").write_text("[Version]\nbuildid=fixture-build\n", encoding="utf-8")
    monkeypatch.setattr(
        "wechat_docs_mcp.office_converter.subprocess.run",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("must not launch")),
    )
    version = LocalOfficeConverter(tmp_path / "derived", executable)._converter_version()
    assert "buildid=fixture-build" in version
    assert hashlib.sha256(executable.read_bytes()).hexdigest() in version


def test_continuation_rejects_changed_request(
    reader_fixture: tuple[VisualAttachmentReader, EventLedger, str, MappingMaterializer]
) -> None:
    reader, ledger, subscription_id, materializer = reader_fixture
    _, pdf_ref = add_attachment(ledger, materializer, "cursor", "file", "sample.pdf", pdf_bytes(2))
    first = reader.read(subscription_id, [pdf_ref], max_images=1)
    with pytest.raises(LedgerError) as mismatch:
        reader.read(
            subscription_id,
            [pdf_ref],
            pages={pdf_ref: [2]},
            continuation_cursor=first.structured_content["continuation_cursor"],
            max_images=1,
        )
    assert mismatch.value.code == "ATTACHMENT_CONTINUATION_MISMATCH"
