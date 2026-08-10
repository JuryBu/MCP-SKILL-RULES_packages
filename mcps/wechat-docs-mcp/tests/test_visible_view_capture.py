from __future__ import annotations

import base64
import hashlib
import io
from pathlib import Path

import pytest
from PIL import Image

from wechat_docs_mcp.attachments import AttachmentRegistry
from wechat_docs_mcp.ledger import EventLedger, LedgerError
from wechat_docs_mcp.visible_view_capture import ViewerCandidate, VisibleViewCapture


class FakeViewerBackend:
    def __init__(self) -> None:
        self.candidates = [ViewerCandidate(10, "Image Viewer", "QtWindow", 20, "Weixin.exe")]
        self.foregrounds = [99, 99]
        buffer = io.BytesIO()
        Image.new("RGB", (320, 240), (20, 80, 160)).save(buffer, format="PNG")
        self.data = buffer.getvalue()

    def foreground_window(self) -> int:
        return self.foregrounds.pop(0)

    def find_candidates(self) -> list[ViewerCandidate]:
        return list(self.candidates)

    def capture_png(self, candidate: ViewerCandidate) -> tuple[bytes, int, int]:
        assert candidate == self.candidates[0]
        return self.data, 320, 240


@pytest.fixture()
def capture_fixture(tmp_path: Path) -> tuple[VisibleViewCapture, FakeViewerBackend, str, str]:
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
    event = ledger.ingest_event(
        "route-a",
        "visible-image",
        "image",
        {
            "local_id": 15,
            "server_id": "7483131382001875446",
            "attachment_name": "sample.png",
            "attachment_size": 1234,
            "attachment_md5": "0" * 32,
        },
    )
    attachment_ref = ledger.list_pending("subscription-a")[0]["payload"]["attachment_ref"]
    registry = AttachmentRegistry(ledger, tmp_path / "intake", tmp_path / "upload")
    backend = FakeViewerBackend()
    capture = VisibleViewCapture(registry, tmp_path / "derived", backend)
    return capture, backend, event["event_id"], attachment_ref


def test_visible_capture_is_explicit_human_assisted_preview(
    capture_fixture: tuple[VisibleViewCapture, FakeViewerBackend, str, str]
) -> None:
    capture, backend, event_id, attachment_ref = capture_fixture
    result = capture.capture("subscription-a", event_id, attachment_ref, "owner-confirmation")
    metadata = result.structured_content
    assert metadata["provenance"] == "human_assisted_visible_view_capture"
    assert metadata["quality"] == "viewport_preview"
    assert metadata["machine_verified_content_identity"] is False
    assert metadata["original_available"] is False
    assert metadata["viewport_complete"] is False
    assert metadata["focus_unchanged"] is True
    assert metadata["local_id"] == 15
    assert metadata["server_id"] == "7483131382001875446"
    assert metadata["returned_sha256"] == hashlib.sha256(backend.data).hexdigest()
    assert base64.b64decode(result.content[1].data) == backend.data
    assert Path(metadata["preview_path"]).is_file()


def test_visible_capture_rejects_missing_confirmation_event_mismatch_and_forged_ref(
    capture_fixture: tuple[VisibleViewCapture, FakeViewerBackend, str, str]
) -> None:
    capture, _, event_id, attachment_ref = capture_fixture
    with pytest.raises(LedgerError) as confirmation:
        capture.capture("subscription-a", event_id, attachment_ref, "")
    assert confirmation.value.code == "VISIBLE_VIEW_HUMAN_CONFIRMATION_REQUIRED"
    with pytest.raises(LedgerError) as mismatch:
        capture.capture("subscription-a", "wrong-event", attachment_ref, "confirmed")
    assert mismatch.value.code == "VISIBLE_VIEW_EVENT_MISMATCH"
    with pytest.raises(LedgerError) as forged:
        capture.capture("subscription-a", event_id, "att_forged", "confirmed")
    assert forged.value.code == "ATTACHMENT_REF_NOT_DELIVERED"


@pytest.mark.parametrize(
    ("candidate_count", "expected_code"),
    [(0, "VISIBLE_VIEW_NOT_FOUND"), (2, "VISIBLE_VIEW_AMBIGUOUS")],
)
def test_visible_capture_requires_one_viewer(
    capture_fixture: tuple[VisibleViewCapture, FakeViewerBackend, str, str],
    candidate_count: int,
    expected_code: str,
) -> None:
    capture, backend, event_id, attachment_ref = capture_fixture
    backend.candidates = backend.candidates * candidate_count
    with pytest.raises(LedgerError) as error:
        capture.capture("subscription-a", event_id, attachment_ref, "confirmed")
    assert error.value.code == expected_code


def test_visible_capture_rejects_focus_change_without_writing_preview(
    capture_fixture: tuple[VisibleViewCapture, FakeViewerBackend, str, str]
) -> None:
    capture, backend, event_id, attachment_ref = capture_fixture
    backend.foregrounds = [99, 100]
    with pytest.raises(LedgerError) as error:
        capture.capture("subscription-a", event_id, attachment_ref, "confirmed")
    assert error.value.code == "VISIBLE_VIEW_FOCUS_CHANGED"
    assert not capture.derived_root.exists()
