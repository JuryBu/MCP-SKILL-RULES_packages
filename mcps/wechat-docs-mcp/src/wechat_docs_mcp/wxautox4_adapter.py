from __future__ import annotations

import json
import msvcrt
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence


class WxAutoError(RuntimeError):
    def __init__(self, code: str, message: str, exit_code: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


class WxAutoAdapter:
    def __init__(self, executable: str | Path, lock_path: str | Path) -> None:
        self.executable = Path(executable)
        self.lock_path = Path(lock_path)
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def serialized(self, timeout_seconds: float = 30) -> Iterator[None]:
        started = time.monotonic()
        with self.lock_path.open("a+b") as lock_file:
            if lock_file.tell() == 0:
                lock_file.write(b"0")
                lock_file.flush()
            while True:
                try:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError as error:
                    if time.monotonic() - started >= timeout_seconds:
                        raise WxAutoError("WX_UI_LOCK_TIMEOUT", "微信 UI 串行锁等待超时") from error
                    time.sleep(0.1)
            try:
                yield
            finally:
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)

    def run_json(self, arguments: Sequence[str], timeout_seconds: float = 60) -> dict[str, Any]:
        if not self.executable.is_file():
            raise WxAutoError("WXAUTO_NOT_INSTALLED", f"wxautox4 executable 不存在：{self.executable}")
        with self.serialized(timeout_seconds):
            completed = subprocess.run(
                [str(self.executable), *arguments],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_seconds,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        if completed.returncode != 0:
            raise WxAutoError(
                "WXAUTO_COMMAND_FAILED",
                f"wxautox4 命令失败，退出码 {completed.returncode}",
                completed.returncode,
            )
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise WxAutoError("WXAUTO_INVALID_JSON", "wxautox4 stdout 不是有效 JSON") from error

    def auth_status(self) -> dict[str, Any]:
        result = self.run_json(["auth", "check", "--json"])
        return {"active": bool(result.get("active")), "operation": result.get("operation")}

    def status(self) -> dict[str, Any]:
        result = self.run_json(["status", "--json"])
        return {
            "online": bool(result.get("online") or result.get("is_online")),
            "authorized": True,
            "available_fields": sorted(result.keys()),
        }

    def chat_info(self, exact_title: str) -> dict[str, Any]:
        return self.run_json(["chat", "info", "--chat", exact_title, "--json"])

    def send_text(self, exact_title: str, text: str) -> dict[str, Any]:
        return self.run_json(["message", "send", text, "--chat", exact_title, "--json"], 120)
