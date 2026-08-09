from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from wechat_docs_mcp.supervisor import BrokerHealthSupervisor


class SupervisorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _server(self, status_code: int, payload: dict[str, object]) -> tuple[ThreadingHTTPServer, threading.Thread]:
        response_body = json.dumps(payload).encode("utf-8")

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(status_code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(response_body)))
                self.end_headers()
                self.wfile.write(response_body)

            def log_message(self, format: str, *args: object) -> None:
                return None

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, thread

    def test_run_once_records_healthy_backend(self) -> None:
        server, thread = self._server(
            200,
            {"healthy": True, "toolCount": 12, "backend": {"pid": 123, "generation": 4}},
        )
        try:
            supervisor = BrokerHealthSupervisor(
                self.root,
                f"http://127.0.0.1:{server.server_port}/health?endpoint=wechat-docs&deep=1",
            )
            state = supervisor.run_once()
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        self.assertTrue(state["healthy"])
        self.assertEqual(123, state["backendPid"])
        self.assertEqual(12, state["toolCount"])
        persisted = json.loads((self.root / "state" / "supervisor-runtime.json").read_text(encoding="utf-8"))
        self.assertEqual(0, persisted["consecutiveFailures"])

    def test_run_once_records_http_failure_without_body(self) -> None:
        server, thread = self._server(503, {"error": "private details must not be logged"})
        try:
            supervisor = BrokerHealthSupervisor(
                self.root,
                f"http://127.0.0.1:{server.server_port}/health?endpoint=wechat-docs&deep=1",
            )
            state = supervisor.run_once()
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        self.assertFalse(state["healthy"])
        self.assertEqual("HTTP_503", state["errorCode"])
        runtime_text = (self.root / "state" / "supervisor-runtime.json").read_text(encoding="utf-8")
        self.assertNotIn("private details", runtime_text)

    def test_non_loopback_health_url_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            BrokerHealthSupervisor(self.root, "https://example.invalid/health")


if __name__ == "__main__":
    unittest.main()
