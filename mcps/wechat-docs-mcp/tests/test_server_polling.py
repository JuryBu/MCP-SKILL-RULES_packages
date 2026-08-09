from __future__ import annotations

import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from wechat_docs_mcp import server


class ServerPollingTests(unittest.TestCase):
    def setUp(self) -> None:
        with server._poll_control_lock:
            server._poll_thread = None
            server._poll_stop = None
            server._poll_interval = 5.0
            server._poll_last_error = None
            server._poll_last_error_time = None
            server._poll_consecutive_failures = 0
            server._wake_last_error = None
            server._wake_last_attempt_time = None

    def tearDown(self) -> None:
        with server._poll_control_lock:
            stop_event = server._poll_stop
            poll_thread = server._poll_thread
            if stop_event is not None:
                stop_event.set()
        if poll_thread is not None and poll_thread.is_alive():
            poll_thread.join(timeout=2.0)
        with server._poll_control_lock:
            server._poll_thread = None
            server._poll_stop = None

    def test_concurrent_start_creates_one_poll_thread(self) -> None:
        start_barrier = threading.Barrier(3)
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
            start_barrier.wait()
            results.append(server.wechat_poll_start(2.0))

        with patch.object(server, "watcher", return_value=object()), patch.object(
            server, "_poll_loop", side_effect=fake_loop
        ):
            callers = [threading.Thread(target=call_start) for _ in range(2)]
            for caller in callers:
                caller.start()
            start_barrier.wait()
            for caller in callers:
                caller.join(timeout=2.0)
            self.assertTrue(entered.wait(timeout=1.0))
            self.assertCountEqual([result["status"] for result in results], ["started", "already_running"])
            self.assertEqual(entered_count, 1)
            self.assertEqual(server.wechat_poll_stop(timeout=2.0)["status"], "stopped")

    def test_stop_does_not_clear_replacement_thread(self) -> None:
        nested_results: list[dict[str, object]] = []

        class OldThread:
            def __init__(self) -> None:
                self.is_alive_calls = 0

            def is_alive(self) -> bool:
                self.is_alive_calls += 1
                if self.is_alive_calls == 1:
                    return True
                if self.is_alive_calls == 2:
                    nested_results.append(server.wechat_poll_start(3.0))
                return False

            def join(self, timeout: float | None = None) -> None:
                return None

        class ReplacementThread:
            def __init__(self) -> None:
                self.alive = False

            def start(self) -> None:
                self.alive = True

            def is_alive(self) -> bool:
                return self.alive

            def join(self, timeout: float | None = None) -> None:
                self.alive = False

        old_thread = OldThread()
        replacement_thread = ReplacementThread()
        with server._poll_control_lock:
            server._poll_thread = old_thread
            server._poll_stop = threading.Event()

        with patch.object(server, "watcher", return_value=object()), patch.object(
            server.threading, "Thread", return_value=replacement_thread
        ):
            result = server.wechat_poll_stop(timeout=1.0)

        self.assertEqual(result["status"], "stopped")
        self.assertEqual(nested_results[0]["status"], "started")
        self.assertIs(server._poll_thread, replacement_thread)
        self.assertTrue(replacement_thread.is_alive())

    def test_stop_timeout_preserves_live_thread(self) -> None:
        class BlockingThread:
            def __init__(self) -> None:
                self.join_timeout: float | None = None

            def is_alive(self) -> bool:
                return True

            def join(self, timeout: float | None = None) -> None:
                self.join_timeout = timeout

        poll_thread = BlockingThread()
        stop_event = threading.Event()
        with server._poll_control_lock:
            server._poll_thread = poll_thread
            server._poll_stop = stop_event

        result = server.wechat_poll_stop(timeout=-1.0)

        self.assertEqual(result["status"], "stopping")
        self.assertTrue(result["alive"])
        self.assertEqual(poll_thread.join_timeout, 0.0)
        self.assertTrue(stop_event.is_set())
        self.assertIs(server._poll_thread, poll_thread)

    def test_poll_loop_records_failure_then_recovers(self) -> None:
        class TwoCycleStop:
            def __init__(self) -> None:
                self.stopped = False
                self.wait_intervals: list[float] = []

            def is_set(self) -> bool:
                return self.stopped

            def wait(self, interval: float) -> None:
                self.wait_intervals.append(interval)
                if len(self.wait_intervals) >= 2:
                    self.stopped = True

        class FakeWatcher:
            def __init__(self) -> None:
                self.results = [SimpleNamespace(error="temporary failure"), SimpleNamespace(error=None)]

            def watch_once(self) -> SimpleNamespace:
                return self.results.pop(0)

        stop_event = TwoCycleStop()
        with patch.object(server, "watcher", return_value=FakeWatcher()), patch.object(
            server, "_submit_pending_wakes", return_value={"submitted_count": 0}
        ) as submit_wakes:
            server._poll_loop(stop_event, 1.25)

        self.assertEqual(stop_event.wait_intervals, [1.25, 1.25])
        self.assertIsNone(server._poll_last_error)
        self.assertIsNotNone(server._poll_last_error_time)
        self.assertEqual(server._poll_consecutive_failures, 0)
        self.assertEqual(2, submit_wakes.call_count)


if __name__ == "__main__":
    unittest.main()
