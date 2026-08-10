from __future__ import annotations

import ctypes
import json
import os
import re
import secrets
import time
from collections.abc import Callable, Iterator
from ctypes import wintypes
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .ledger import LedgerError, utc_now


OWNER_SCOPE_PATTERN = re.compile(r"[0-9a-f]{64}")
AES_KEY_PATTERN = re.compile(r"[A-Za-z0-9]{16}")
PROCESS_NAMES = {"weixin.exe", "wechatappex.exe"}
PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
TH32CS_SNAPPROCESS = 0x00000002
MEM_COMMIT = 0x1000
PAGE_NOACCESS = 0x01
PAGE_GUARD = 0x100
READABLE_PROTECTION = {0x02, 0x04, 0x08, 0x20, 0x40, 0x80}
MAX_REGION_BYTES = 32 * 1024 * 1024
READ_CHUNK_BYTES = 4 * 1024 * 1024
MAX_CANDIDATES_PER_SCAN = 50_000


@dataclass(frozen=True)
class ImageKeyMaterial:
    aes_key: bytes
    xor_key: int
    source: str
    owner_account_key_sha256: str

    def __post_init__(self) -> None:
        try:
            key_text = self.aes_key.decode("ascii")
        except UnicodeDecodeError as error:
            raise ValueError("AES key must be ASCII") from error
        if not AES_KEY_PATTERN.fullmatch(key_text) or not 0 <= self.xor_key <= 255:
            raise ValueError("invalid WeChat image key material")
        if not OWNER_SCOPE_PATTERN.fullmatch(self.owner_account_key_sha256):
            raise ValueError("invalid owner account scope")


class ImageKeyScanner(Protocol):
    def scan(
        self,
        resolve_candidate: Callable[[bytes], ImageKeyMaterial | None],
        timeout_seconds: float,
    ) -> ImageKeyMaterial | None: ...


class _ProcessEntry32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


class _MemoryBasicInformation(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("PartitionId", wintypes.WORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


class WindowsWeixinImageKeyScanner:
    def __init__(self, poll_interval_seconds: float = 1.0) -> None:
        self.poll_interval_seconds = max(0.1, poll_interval_seconds)

    @staticmethod
    def _kernel32() -> ctypes.WinDLL:
        if os.name != "nt":
            raise LedgerError("ATTACHMENT_IMAGE_KEY_PLATFORM", "微信图片密钥扫描仅支持 Windows")
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessEntry32)]
        kernel32.Process32FirstW.restype = wintypes.BOOL
        kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ProcessEntry32)]
        kernel32.Process32NextW.restype = wintypes.BOOL
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.VirtualQueryEx.argtypes = [
            wintypes.HANDLE,
            ctypes.c_void_p,
            ctypes.POINTER(_MemoryBasicInformation),
            ctypes.c_size_t,
        ]
        kernel32.VirtualQueryEx.restype = ctypes.c_size_t
        kernel32.ReadProcessMemory.argtypes = [
            wintypes.HANDLE,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        kernel32.ReadProcessMemory.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        return kernel32

    def _process_ids(self, kernel32: ctypes.WinDLL) -> list[int]:
        snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
        if snapshot == wintypes.HANDLE(-1).value:
            return []
        entry = _ProcessEntry32()
        entry.dwSize = ctypes.sizeof(entry)
        pids: list[int] = []
        try:
            if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
                return []
            while True:
                if entry.szExeFile.casefold() in PROCESS_NAMES:
                    pids.append(int(entry.th32ProcessID))
                if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                    break
        finally:
            kernel32.CloseHandle(snapshot)
        return pids

    @staticmethod
    def _regions(kernel32: ctypes.WinDLL, handle: wintypes.HANDLE) -> Iterator[tuple[int, int]]:
        address = 0
        maximum = (1 << (ctypes.sizeof(ctypes.c_void_p) * 8)) - 1
        info = _MemoryBasicInformation()
        while address < maximum:
            queried = kernel32.VirtualQueryEx(
                handle,
                ctypes.c_void_p(address),
                ctypes.byref(info),
                ctypes.sizeof(info),
            )
            if not queried:
                break
            base = int(info.BaseAddress or 0)
            size = int(info.RegionSize)
            protection = int(info.Protect) & 0xFF
            if (
                info.State == MEM_COMMIT
                and protection != PAGE_NOACCESS
                and not (info.Protect & PAGE_GUARD)
                and protection in READABLE_PROTECTION
                and 0 < size <= MAX_REGION_BYTES
            ):
                yield base, size
            next_address = base + max(size, 0x1000)
            if next_address <= address:
                break
            address = next_address

    @staticmethod
    def _read(
        kernel32: ctypes.WinDLL,
        handle: wintypes.HANDLE,
        address: int,
        size: int,
    ) -> bytes:
        buffer = ctypes.create_string_buffer(size)
        read = ctypes.c_size_t()
        if not kernel32.ReadProcessMemory(
            handle,
            ctypes.c_void_p(address),
            buffer,
            size,
            ctypes.byref(read),
        ):
            return b""
        return buffer.raw[: read.value]

    @staticmethod
    def _candidates(data: bytes) -> Iterator[bytes]:
        for match in re.finditer(rb"(?<![A-Za-z0-9])[A-Za-z0-9]{32}(?![A-Za-z0-9])", data):
            yield match.group()[:16]
        for match in re.finditer(rb"(?<![A-Za-z0-9])[A-Za-z0-9]{16}(?![A-Za-z0-9])", data):
            yield match.group()

    def _scan_once(
        self,
        kernel32: ctypes.WinDLL,
        resolve_candidate: Callable[[bytes], ImageKeyMaterial | None],
        seen: set[bytes],
        deadline: float,
    ) -> ImageKeyMaterial | None:
        for process_id in self._process_ids(kernel32):
            if time.monotonic() >= deadline:
                return None
            handle = kernel32.OpenProcess(
                PROCESS_VM_READ | PROCESS_QUERY_INFORMATION,
                False,
                process_id,
            )
            if not handle:
                continue
            try:
                for base, region_size in self._regions(kernel32, handle):
                    if time.monotonic() >= deadline:
                        return None
                    overlap = b""
                    for offset in range(0, region_size, READ_CHUNK_BYTES):
                        if time.monotonic() >= deadline:
                            return None
                        block = self._read(
                            kernel32,
                            handle,
                            base + offset,
                            min(READ_CHUNK_BYTES, region_size - offset),
                        )
                        if not block:
                            overlap = b""
                            continue
                        combined = overlap + block
                        overlap = combined[-31:]
                        for candidate in self._candidates(combined):
                            if time.monotonic() >= deadline:
                                return None
                            if candidate in seen:
                                continue
                            seen.add(candidate)
                            if len(seen) > MAX_CANDIDATES_PER_SCAN:
                                return None
                            resolved = resolve_candidate(candidate)
                            if resolved is not None:
                                return resolved
            finally:
                kernel32.CloseHandle(handle)
        return None

    def scan(
        self,
        resolve_candidate: Callable[[bytes], ImageKeyMaterial | None],
        timeout_seconds: float,
    ) -> ImageKeyMaterial | None:
        if timeout_seconds <= 0:
            return None
        kernel32 = self._kernel32()
        deadline = time.monotonic() + timeout_seconds
        seen: set[bytes] = set()
        while time.monotonic() < deadline:
            resolved = self._scan_once(kernel32, resolve_candidate, seen, deadline)
            if resolved is not None:
                return resolved
            remaining = deadline - time.monotonic()
            if remaining > 0:
                time.sleep(min(self.poll_interval_seconds, remaining))
        return None


class ImageKeyManager:
    def __init__(
        self,
        key_root: str | Path,
        *,
        legacy_key_file: str | Path | None = None,
        scanner: ImageKeyScanner | None = None,
    ) -> None:
        self.key_root = Path(key_root).resolve()
        self.legacy_key_file = Path(legacy_key_file).resolve() if legacy_key_file else None
        self.scanner = scanner

    @staticmethod
    def _scope(owner_account_key_sha256: str) -> str:
        normalized = owner_account_key_sha256.strip().casefold()
        if not OWNER_SCOPE_PATTERN.fullmatch(normalized):
            raise LedgerError("ATTACHMENT_IMAGE_ACCOUNT_UNVERIFIED", "图片事件缺少可信账号作用域")
        return normalized

    def _path(self, owner_account_key_sha256: str) -> Path:
        return self.key_root / f"{self._scope(owner_account_key_sha256)}.json"

    @staticmethod
    def _load(path: Path, owner_scope: str, source: str) -> ImageKeyMaterial | None:
        if not path.is_file():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            recorded_scope = str(payload.get("owner_account_key_sha256") or "").casefold()
            if recorded_scope and recorded_scope != owner_scope:
                return None
            return ImageKeyMaterial(
                aes_key=str(payload["aes_key"]).encode("ascii"),
                xor_key=int(payload["xor_key"]),
                source=source,
                owner_account_key_sha256=owner_scope,
            )
        except (KeyError, TypeError, ValueError, UnicodeEncodeError, json.JSONDecodeError):
            return None

    def _persist(self, material: ImageKeyMaterial, validated_content_md5: str) -> Path:
        destination = self._path(material.owner_account_key_sha256)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.{secrets.token_hex(6)}.tmp")
        payload = {
            "version": 2,
            "owner_account_key_sha256": material.owner_account_key_sha256,
            "aes_key": material.aes_key.decode("ascii"),
            "xor_key": material.xor_key,
            "validated_content_md5": validated_content_md5.casefold(),
            "validated_at": utc_now(),
        }
        try:
            with temporary.open("x", encoding="utf-8", newline="\n") as stream:
                json.dump(payload, stream, ensure_ascii=False, sort_keys=True)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, destination)
            os.chmod(destination, 0o600)
        finally:
            temporary.unlink(missing_ok=True)
        return destination

    def resolve(
        self,
        owner_account_key_sha256: str,
        *,
        validate: Callable[[ImageKeyMaterial], bool],
        resolve_scanned_aes: Callable[[bytes], ImageKeyMaterial | None],
        validated_content_md5: str,
        allow_scan: bool,
        scan_timeout_seconds: float,
    ) -> ImageKeyMaterial:
        owner_scope = self._scope(owner_account_key_sha256)
        scoped = self._load(self._path(owner_scope), owner_scope, "account_cache")
        if scoped is not None and validate(scoped):
            return scoped
        if self.legacy_key_file is not None:
            legacy = self._load(self.legacy_key_file, owner_scope, "legacy_validated")
            if legacy is not None and validate(legacy):
                self._persist(legacy, validated_content_md5)
                return legacy
        if allow_scan and self.scanner is not None:
            scanned = self.scanner.scan(resolve_scanned_aes, scan_timeout_seconds)
            if scanned is not None and validate(scanned):
                self._persist(scanned, validated_content_md5)
                return scanned
        raise LedgerError(
            "ATTACHMENT_IMAGE_KEY_WAITING",
            "当前账号没有通过目标图片验证的密钥；等待下一张新图片到达后再读取",
        )

    def status(self, owner_account_key_sha256: str) -> dict[str, object]:
        owner_scope = self._scope(owner_account_key_sha256)
        scoped_path = self._path(owner_scope)
        return {
            "owner_account_key_sha256": owner_scope,
            "state": "CACHED_UNVERIFIED" if scoped_path.is_file() else "WAITING_FOR_KEY",
            "scoped_key_file_present": scoped_path.is_file(),
            "legacy_key_file_present": bool(self.legacy_key_file and self.legacy_key_file.is_file()),
            "scanner_available": self.scanner is not None and os.name == "nt",
        }
