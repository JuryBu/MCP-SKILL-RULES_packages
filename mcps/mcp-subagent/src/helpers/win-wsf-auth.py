#!/usr/bin/env python3
"""
Windows-only helper for mcp-subagent Stage A.

Actions:
  token      Print the decrypted Devin/Windsurf access token as JSON.
  discover   Print candidate language_server_windows_x64.exe processes,
             CSRF tokens, and listening ports as JSON.

The helper intentionally performs no LS writes and logs no full token unless the
Node caller requests action=token and consumes it from stdout.
"""

import argparse
import base64
import ctypes
import json
import os
import re
import sqlite3
import struct
import subprocess
import sys
from ctypes import wintypes
from pathlib import Path

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except Exception as exc:  # pragma: no cover - surfaced in JSON below
    AESGCM = None
    AESGCM_IMPORT_ERROR = exc
else:
    AESGCM_IMPORT_ERROR = None


PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010


class DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


class ProcessBasicInformation(ctypes.Structure):
    _fields_ = [
        ("reserved1", ctypes.c_void_p),
        ("peb_base_address", ctypes.c_void_p),
        ("reserved2", ctypes.c_void_p * 2),
        ("unique_process_id", ctypes.c_void_p),
        ("reserved3", ctypes.c_void_p),
    ]


def emit(payload, code=0):
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(code)


def dpapi_unprotect(data):
    in_blob = DataBlob(
        len(data),
        ctypes.cast(ctypes.create_string_buffer(data, len(data)), ctypes.POINTER(ctypes.c_char)),
    )
    out_blob = DataBlob()
    ok = ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)
    )
    if not ok:
        raise OSError("CryptUnprotectData failed")
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)


def read_process_memory(handle, address, size):
    buffer = ctypes.create_string_buffer(size)
    bytes_read = ctypes.c_size_t(0)
    ok = ctypes.windll.kernel32.ReadProcessMemory(
        handle, ctypes.c_void_p(address), buffer, size, ctypes.byref(bytes_read)
    )
    if not ok:
        return b""
    return buffer.raw[: bytes_read.value]


def csrf_of(pid):
    handle = ctypes.windll.kernel32.OpenProcess(
        PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, int(pid)
    )
    if not handle:
        return None
    try:
        pbi = ProcessBasicInformation()
        ret_len = ctypes.c_ulong(0)
        ctypes.windll.ntdll.NtQueryInformationProcess(
            handle, 0, ctypes.byref(pbi), ctypes.sizeof(pbi), ctypes.byref(ret_len)
        )
        peb = read_process_memory(handle, pbi.peb_base_address, 0x80)
        if len(peb) < 0x28:
            return None
        process_parameters = struct.unpack_from("<Q", peb, 0x20)[0]
        params = read_process_memory(handle, process_parameters, 0x88)
        if len(params) < 0x88:
            return None
        env_ptr = struct.unpack_from("<Q", params, 0x80)[0]
        env_data = read_process_memory(handle, env_ptr, 262144)
        env_text = env_data.decode("utf-16-le", "ignore")
        for var in env_text.split("\x00"):
            upper = var.upper()
            if "CSRF" in upper and "=" in var:
                return var.split("=", 1)[1]
        return None
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def powershell_json(script):
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or f"PowerShell exited {completed.returncode}")
    text = completed.stdout.strip()
    if not text:
        return []
    data = json.loads(text)
    if isinstance(data, dict):
        return [data]
    if not isinstance(data, list):
        return [data]
    return data


def discover_processes():
    process_script = r"""
$items = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'language_server_windows_x64.exe' } |
  Select-Object ProcessId,CommandLine
$items | ConvertTo-Json -Depth 4
"""
    processes = powershell_json(process_script)
    candidates = []
    for proc in processes:
        command_line = proc.get("CommandLine") or ""
        if "Devin" not in command_line and "windsurf" not in command_line.lower():
            continue
        pid = int(proc["ProcessId"])
        ext_match = re.search(r"--extension_server_port\s+(\d+)", command_line)
        extension_port = int(ext_match.group(1)) if ext_match else None
        port_script = (
            f"Get-NetTCPConnection -OwningProcess {pid} -State Listen -EA SilentlyContinue | "
            "Select-Object -ExpandProperty LocalPort | ConvertTo-Json"
        )
        try:
            ports_raw = powershell_json(port_script)
        except Exception:
            ports_raw = []
        ports = []
        for item in ports_raw:
            try:
                port = int(item)
            except Exception:
                continue
            if extension_port is not None and port == extension_port:
                continue
            if port not in ports:
                ports.append(port)
        candidates.append(
            {
                "pid": pid,
                "csrf": csrf_of(pid),
                "ports": ports,
                "extensionPort": extension_port,
                "isDevin": "Devin" in command_line,
                "isWindsurf": "windsurf" in command_line.lower(),
                "workspaceHints": sorted(set(re.findall(r"[A-F0-9]{2}(?:_[A-F0-9]{2}){2,}", command_line))),
            }
        )
    return candidates


def local_state_paths():
    appdata = Path(os.environ.get("APPDATA", ""))
    return [
        appdata / "Devin" / "Local State",
        appdata / "Windsurf" / "Local State",
    ]


def state_db_paths():
    appdata = Path(os.environ.get("APPDATA", ""))
    return [
        appdata / "Devin" / "User" / "globalStorage" / "state.vscdb",
        appdata / "Windsurf" / "User" / "globalStorage" / "state.vscdb",
    ]


def decode_buffer_json(raw_value):
    parsed = json.loads(raw_value)
    if isinstance(parsed, dict) and "data" in parsed:
        return bytes(parsed["data"])
    if isinstance(parsed, list):
        return bytes(parsed)
    raise ValueError("unsupported encrypted buffer format")


def decrypt_access_token():
    if AESGCM is None:
        raise RuntimeError(f"cryptography AESGCM unavailable: {AESGCM_IMPORT_ERROR}")

    local_state = next((p for p in local_state_paths() if p.exists()), None)
    state_db = next((p for p in state_db_paths() if p.exists()), None)
    if local_state is None:
        raise FileNotFoundError("Devin/Windsurf Local State not found")
    if state_db is None:
        raise FileNotFoundError("Devin/Windsurf state.vscdb not found")

    local_state_json = json.loads(local_state.read_text(encoding="utf-8"))
    encrypted_key = base64.b64decode(local_state_json["os_crypt"]["encrypted_key"])
    master_key = dpapi_unprotect(encrypted_key[5:])

    secret_key = 'secret://{"extensionId":"codeium.windsurf","key":"windsurf_auth.sessions"}'
    connection = sqlite3.connect(f"file:{state_db}?mode=ro&immutable=1", uri=True)
    try:
        row = connection.cursor().execute(
            "SELECT value FROM ItemTable WHERE key=?", (secret_key,)
        ).fetchone()
    finally:
        connection.close()
    if not row:
        raise KeyError("windsurf_auth.sessions not found in state.vscdb")

    blob = decode_buffer_json(row[0])
    if blob[:3] != b"v10":
        raise ValueError("unexpected safeStorage blob prefix")
    plaintext = AESGCM(master_key).decrypt(blob[3:15], blob[15:], None)
    sessions = json.loads(plaintext.decode("utf-8"))
    if not sessions or not sessions[0].get("accessToken"):
        raise KeyError("accessToken not found in sessions")
    return {
        "accessToken": sessions[0]["accessToken"],
        "accountLabel": ((sessions[0].get("account") or {}).get("label")),
        "localStatePath": str(local_state),
        "stateDbPath": str(state_db),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["token", "discover"])
    args = parser.parse_args()
    try:
        if args.action == "token":
            token = decrypt_access_token()
            emit({"ok": True, **token})
        if args.action == "discover":
            emit({"ok": True, "candidates": discover_processes()})
    except Exception as exc:
        emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, code=1)


if __name__ == "__main__":
    main()
