from __future__ import annotations

import threading
from pathlib import Path
from unittest.mock import patch

from wechat_docs_mcp import server


def reset_tdocs_poll_state() -> None:
    with server._tdocs_poll_control_lock:
        server._tdocs_poll_thread = None
        server._tdocs_poll_stop = None
        server._tdocs_poll_interval = 60.0
        server._tdocs_poll_last_error = None
        server._tdocs_poll_last_error_time = None
        server._tdocs_poll_consecutive_failures = 0


def test_concurrent_tdocs_poll_start_creates_one_thread(
    monkeypatch, tmp_path: Path
) -> None:
    reset_tdocs_poll_state()
    token = tmp_path / "token"
    token.write_text("private", encoding="utf-8")
    monkeypatch.setattr(server, "TOKEN_FILE", token)
    barrier = threading.Barrier(3)
    entered = threading.Event()
    entered_count = 0
    entered_lock = threading.Lock()
    results: list[dict[str, object]] = []

    def fake_loop(stop_event: threading.Event, interval: float) -> None:
        nonlocal entered_count
        with entered_lock:
            entered_count += 1
        entered.set()
        stop_event.wait(timeout=2.0)

    def call_start() -> None:
        barrier.wait()
        results.append(server.tdocs_monitor_poll_start(15.0))

    with patch.object(server, "_tdocs_poll_loop", side_effect=fake_loop):
        callers = [threading.Thread(target=call_start) for _ in range(2)]
        for caller in callers:
            caller.start()
        barrier.wait()
        for caller in callers:
            caller.join(timeout=2.0)
        assert entered.wait(timeout=1.0)
        assert entered_count == 1
        assert sorted(result["status"] for result in results) == [
            "already_running",
            "started",
        ]
        assert server.tdocs_monitor_poll_stop(2.0)["status"] == "stopped"
    reset_tdocs_poll_state()


def test_tdocs_poll_stop_timeout_preserves_thread_and_blocks_restart(
    monkeypatch, tmp_path: Path
) -> None:
    reset_tdocs_poll_state()
    token = tmp_path / "token"
    token.write_text("private", encoding="utf-8")
    monkeypatch.setattr(server, "TOKEN_FILE", token)
    entered = threading.Event()
    release = threading.Event()

    def fake_loop(stop_event: threading.Event, interval: float) -> None:
        entered.set()
        release.wait(timeout=2.0)

    with patch.object(server, "_tdocs_poll_loop", side_effect=fake_loop):
        assert server.tdocs_monitor_poll_start(15.0)["status"] == "started"
        assert entered.wait(timeout=1.0)
        result = server.tdocs_monitor_poll_stop(0.01)
        assert result == {"status": "stopping", "alive": True}
        with server._tdocs_poll_control_lock:
            thread = server._tdocs_poll_thread
            stop_event = server._tdocs_poll_stop
        assert thread is not None and thread.is_alive()
        assert stop_event is not None and stop_event.is_set()
        assert server.tdocs_monitor_poll_start(15.0)["status"] == "already_running"
        release.set()
        thread.join(timeout=1.0)
        assert server.tdocs_monitor_poll_stop(0.1)["status"] == "not_running"
    reset_tdocs_poll_state()
