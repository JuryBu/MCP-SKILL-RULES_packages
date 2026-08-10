from __future__ import annotations

import json
import inspect
import time
from pathlib import Path

import pytest

from wechat_docs_mcp.image_key_manager import (
    ImageKeyManager,
    ImageKeyMaterial,
    WindowsWeixinImageKeyScanner,
)
from wechat_docs_mcp.ledger import LedgerError


OWNER_A = "a" * 64
OWNER_B = "b" * 64
AES_KEY = b"0123456789abcdef"


class FakeScanner:
    def __init__(self, candidate: bytes) -> None:
        self.candidate = candidate
        self.calls = 0

    def scan(self, resolve_candidate, timeout_seconds: float):
        self.calls += 1
        assert timeout_seconds > 0
        return resolve_candidate(self.candidate)


def material(owner: str, *, source: str = "fixture", xor_key: int = 0xD4) -> ImageKeyMaterial:
    return ImageKeyMaterial(AES_KEY, xor_key, source, owner)


def test_legacy_key_requires_target_validation_before_account_migration(tmp_path: Path) -> None:
    legacy = tmp_path / "legacy.json"
    legacy.write_text(
        json.dumps({"version": 1, "aes_key": AES_KEY.decode(), "xor_key": 0xD4}),
        encoding="utf-8",
    )
    manager = ImageKeyManager(tmp_path / "scoped", legacy_key_file=legacy)

    resolved = manager.resolve(
        OWNER_A,
        validate=lambda candidate: candidate.aes_key == AES_KEY and candidate.xor_key == 0xD4,
        resolve_scanned_aes=lambda _: None,
        validated_content_md5="1" * 32,
        allow_scan=False,
        scan_timeout_seconds=1,
    )

    assert resolved.source == "legacy_validated"
    scoped = tmp_path / "scoped" / f"{OWNER_A}.json"
    payload = json.loads(scoped.read_text(encoding="utf-8"))
    assert payload["owner_account_key_sha256"] == OWNER_A
    assert payload["validated_content_md5"] == "1" * 32


def test_invalid_legacy_key_stays_waiting_and_does_not_create_scope(tmp_path: Path) -> None:
    legacy = tmp_path / "legacy.json"
    legacy.write_text(
        json.dumps({"version": 1, "aes_key": AES_KEY.decode(), "xor_key": 0xD4}),
        encoding="utf-8",
    )
    manager = ImageKeyManager(tmp_path / "scoped", legacy_key_file=legacy)

    with pytest.raises(LedgerError) as raised:
        manager.resolve(
            OWNER_B,
            validate=lambda _: False,
            resolve_scanned_aes=lambda _: None,
            validated_content_md5="2" * 32,
            allow_scan=False,
            scan_timeout_seconds=1,
        )

    assert raised.value.code == "ATTACHMENT_IMAGE_KEY_WAITING"
    assert not (tmp_path / "scoped" / f"{OWNER_B}.json").exists()


def test_scanner_runs_only_when_caller_opens_new_image_window(tmp_path: Path) -> None:
    scanner = FakeScanner(AES_KEY)
    manager = ImageKeyManager(tmp_path / "scoped", scanner=scanner)

    with pytest.raises(LedgerError):
        manager.resolve(
            OWNER_A,
            validate=lambda _: False,
            resolve_scanned_aes=lambda candidate: material(OWNER_A) if candidate == AES_KEY else None,
            validated_content_md5="3" * 32,
            allow_scan=False,
            scan_timeout_seconds=1,
        )
    assert scanner.calls == 0

    resolved = manager.resolve(
        OWNER_A,
        validate=lambda candidate: candidate.aes_key == AES_KEY,
        resolve_scanned_aes=lambda candidate: material(OWNER_A) if candidate == AES_KEY else None,
        validated_content_md5="3" * 32,
        allow_scan=True,
        scan_timeout_seconds=1,
    )
    assert resolved.source == "fixture"
    assert scanner.calls == 1


def test_scoped_record_for_another_owner_is_never_loaded(tmp_path: Path) -> None:
    scoped = tmp_path / "scoped"
    scoped.mkdir()
    (scoped / f"{OWNER_A}.json").write_text(
        json.dumps(
            {
                "version": 2,
                "owner_account_key_sha256": OWNER_B,
                "aes_key": AES_KEY.decode(),
                "xor_key": 0xD4,
            }
        ),
        encoding="utf-8",
    )
    manager = ImageKeyManager(scoped)
    with pytest.raises(LedgerError) as raised:
        manager.resolve(
            OWNER_A,
            validate=lambda _: True,
            resolve_scanned_aes=lambda _: None,
            validated_content_md5="4" * 32,
            allow_scan=False,
            scan_timeout_seconds=1,
        )
    assert raised.value.code == "ATTACHMENT_IMAGE_KEY_WAITING"


def test_windows_scanner_source_is_read_only_and_has_no_ui_trigger() -> None:
    source = inspect.getsource(WindowsWeixinImageKeyScanner)
    assert "PROCESS_VM_READ" in source
    for forbidden in (
        "PROCESS_VM_WRITE",
        "PROCESS_VM_OPERATION",
        "WriteProcessMemory",
        "PostMessage",
        "SendInput",
        "ShowWindow",
    ):
        assert forbidden not in source


def test_scan_once_honors_deadline_inside_region_walk(monkeypatch: pytest.MonkeyPatch) -> None:
    scanner = WindowsWeixinImageKeyScanner()
    reads = 0

    class FakeKernel:
        @staticmethod
        def OpenProcess(*_args):
            return 1

        @staticmethod
        def CloseHandle(*_args):
            return True

    monkeypatch.setattr(scanner, "_process_ids", lambda _kernel: [1])
    monkeypatch.setattr(scanner, "_regions", lambda _kernel, _handle: iter((index, 1) for index in range(100)))

    def slow_read(*_args) -> bytes:
        nonlocal reads
        reads += 1
        time.sleep(0.01)
        return b""

    monkeypatch.setattr(scanner, "_read", slow_read)
    started = time.monotonic()
    resolved = scanner._scan_once(FakeKernel(), lambda _: None, set(), started + 0.025)
    elapsed = time.monotonic() - started

    assert resolved is None
    assert reads <= 3
    assert elapsed < 0.5
