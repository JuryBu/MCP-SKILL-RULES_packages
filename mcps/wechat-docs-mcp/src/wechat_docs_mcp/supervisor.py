from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import urlopen


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


class SupervisorLock:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.handle: Any = None

    def __enter__(self) -> SupervisorLock:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = open(self.path, "a+b")
        self.handle.seek(0, os.SEEK_END)
        if self.handle.tell() == 0:
            self.handle.write(b"0")
            self.handle.flush()
        self.handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self.handle.close()
            self.handle = None
            raise RuntimeError("wechat-docs supervisor is already running") from error
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> None:
        if self.handle is None:
            return
        try:
            self.handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        finally:
            self.handle.close()
            self.handle = None


class BrokerHealthSupervisor:
    def __init__(
        self,
        data_root: str | Path,
        health_url: str = "http://127.0.0.1:14588/health?endpoint=wechat-docs&deep=1",
        interval_seconds: float = 30.0,
        timeout_seconds: float = 20.0,
    ) -> None:
        self.data_root = Path(data_root)
        self.health_url = health_url
        self.interval_seconds = max(5.0, interval_seconds)
        self.timeout_seconds = max(1.0, timeout_seconds)
        self.state_dir = self.data_root / "state"
        self.runtime_path = self.state_dir / "supervisor-runtime.json"
        self.lock_path = self.state_dir / "supervisor.lock"
        self.stop_path = self.state_dir / "supervisor.stop"
        self.log_path = self.data_root / "logs" / "supervisor.jsonl"
        self.started_at = utc_now()
        self.consecutive_failures = 0
        self.stop_event = Event()
        if (urlparse(health_url).hostname or "").lower() not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("supervisor health URL must use loopback")

    def run_once(self) -> dict[str, Any]:
        result: dict[str, Any]
        try:
            with urlopen(self.health_url, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if payload.get("healthy") is not True:
                raise RuntimeError("backend reported unhealthy")
            self.consecutive_failures = 0
            result = {
                "healthy": True,
                "errorCode": None,
                "backendPid": payload.get("backend", {}).get("pid"),
                "backendGeneration": payload.get("backend", {}).get("generation"),
                "toolCount": payload.get("toolCount"),
            }
        except HTTPError as error:
            self.consecutive_failures += 1
            result = {"healthy": False, "errorCode": f"HTTP_{error.code}"}
        except (URLError, TimeoutError):
            self.consecutive_failures += 1
            result = {"healthy": False, "errorCode": "BROKER_UNREACHABLE"}
        except (json.JSONDecodeError, RuntimeError):
            self.consecutive_failures += 1
            result = {"healthy": False, "errorCode": "BROKER_HEALTH_INVALID"}
        state = {
            "schemaVersion": 1,
            "pid": os.getpid(),
            "startedAt": self.started_at,
            "updatedAt": utc_now(),
            "healthUrl": self.health_url,
            "intervalSeconds": self.interval_seconds,
            "consecutiveFailures": self.consecutive_failures,
            **result,
        }
        atomic_write_json(self.runtime_path, state)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.log_path, "a", encoding="utf-8") as log_file:
            log_file.write(json.dumps(state, ensure_ascii=False, separators=(",", ":")) + "\n")
        return state

    def run_forever(self) -> None:
        with SupervisorLock(self.lock_path):
            while not self.stop_event.is_set() and not self.stop_path.exists():
                self.run_once()
                self.stop_event.wait(self.interval_seconds)
            final_state = {
                "schemaVersion": 1,
                "pid": os.getpid(),
                "startedAt": self.started_at,
                "updatedAt": utc_now(),
                "healthy": False,
                "stopped": True,
                "errorCode": None,
                "consecutiveFailures": self.consecutive_failures,
            }
            atomic_write_json(self.runtime_path, final_state)

    def request_stop(self, _signum: int | None = None, _frame: object = None) -> None:
        self.stop_event.set()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Keep the WeChat Docs broker backend healthy")
    parser.add_argument(
        "--data-root",
        default=str(Path.home() / ".codex-toolkit" / "wechat-docs-mcp"),
    )
    parser.add_argument(
        "--health-url",
        default="http://127.0.0.1:14588/health?endpoint=wechat-docs&deep=1",
    )
    parser.add_argument("--interval", type=float, default=30.0)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--once", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    supervisor = BrokerHealthSupervisor(args.data_root, args.health_url, args.interval, args.timeout)
    if args.once:
        return 0 if supervisor.run_once()["healthy"] else 1
    signal.signal(signal.SIGINT, supervisor.request_stop)
    signal.signal(signal.SIGTERM, supervisor.request_stop)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, supervisor.request_stop)
    try:
        supervisor.run_forever()
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
