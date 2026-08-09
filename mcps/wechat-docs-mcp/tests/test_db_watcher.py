from __future__ import annotations

import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from wechat_docs_mcp.db_observer import RouteBinding
from wechat_docs_mcp.db_watcher import DbWatcher, FileSnapshot, WatchResult
from wechat_docs_mcp.ledger import EventLedger


def _make_encrypted_tree(base: Path) -> Path:
    """Create a minimal encrypted DB directory for testing."""
    msg_dir = base / "message"
    msg_dir.mkdir(parents=True)
    # Create a fake encrypted .db file
    db_path = msg_dir / "message_0.db"
    db_path.write_bytes(b"\x00" * 4096)
    return base


def _make_decrypted_tree(base: Path) -> Path:
    """Create a minimal decrypted DB tree for testing."""
    import hashlib
    msg_dir = base / "message"
    contact_dir = base / "contact"
    msg_dir.mkdir(parents=True)
    contact_dir.mkdir(parents=True)

    msg_db = msg_dir / "message_0.db"
    conn = sqlite3.connect(str(msg_db))
    conn.executescript("""
        CREATE TABLE Name2Id (user_name TEXT, is_session INTEGER DEFAULT 0);
        INSERT INTO Name2Id VALUES ('wxid_test', 1);
        INSERT INTO Name2Id VALUES ('self', 0);
    """)
    h = hashlib.md5(b"wxid_test").hexdigest()
    conn.executescript(f"""
        CREATE TABLE Msg_{h} (
            local_id INTEGER, server_id INTEGER, local_type INTEGER,
            sort_seq INTEGER, real_sender_id INTEGER, create_time INTEGER,
            status INTEGER, source TEXT, message_content TEXT,
            compress_content TEXT, packed_info_data BLOB,
            WCDB_CT_message_content INTEGER DEFAULT 0,
            WCDB_CT_source INTEGER DEFAULT 0
        );
        INSERT INTO Msg_{h} VALUES
            (1, 100, 1, 1700000001000, 1, 1700000001, 4, '<msgsource/>', 'hello', '', NULL, 0, 0);
    """)
    conn.commit()
    conn.close()

    contact_db = contact_dir / "contact.db"
    conn = sqlite3.connect(str(contact_db))
    conn.executescript("""
        CREATE TABLE contact (id INTEGER, username TEXT, nick_name TEXT, local_type INTEGER);
        INSERT INTO contact VALUES (1, 'wxid_test', 'TestUser', 1);
    """)
    conn.commit()
    conn.close()
    return base


def _insert_msg(db_path: Path, username: str, local_id: int, content: str = "msg") -> None:
    """Insert a message row into the test decrypted DB."""
    import hashlib
    h = hashlib.md5(username.encode("utf-8")).hexdigest()
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        f"INSERT INTO Msg_{h} VALUES (?, ?, 1, ?, 1, ?, 4, '<msgsource/>', ?, '', NULL, 0, 0)",
        (local_id, 200 + local_id, 1700000001000 + local_id, 1700000001 + local_id, content),
    )
    conn.commit()
    conn.close()


class DbWatcherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        base = Path(self.temp_dir.name)
        self.encrypted_dir = base / "encrypted"
        self.decrypted_dir = base / "decrypted"
        self.keys_file = base / "keys.json"

        _make_encrypted_tree(self.encrypted_dir)
        _make_decrypted_tree(self.decrypted_dir)

        self.bindings = [
            RouteBinding(
                route_id="route-test",
                exact_title="TestUser",
                chat_type="friend",
                username="wxid_test",
            ),
        ]
        self.ledger = EventLedger(base / "events.sqlite3")
        self.ledger.register_route(
            "route-test", "conv-test", 1, "test",
            {"chat_name": "TestUser"}, "active",
            baseline_local_id=0,
        )
        self.watcher = DbWatcher(
            self.encrypted_dir, self.decrypted_dir,
            self.keys_file, self.bindings, self.ledger,
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_initial_scan_forces_full_cycle(self) -> None:
        """First watch cycle should force a full refresh to catch offline messages."""
        with patch.object(self.watcher, "refresh_keys", return_value=True), \
             patch.object(self.watcher, "decrypt_changed", return_value=["message/message_0.db"]):
            result = self.watcher.watch_once()
            self.assertIsNone(result.error)
            # The existing message (local_id=1) should be found
            self.assertEqual(1, len(result.new_observations))

    def test_file_change_triggers_poll(self) -> None:
        """After initial scan, changing a file should trigger the cycle."""
        # First cycle: initial scan with mocked keys/decrypt
        with patch.object(self.watcher, "refresh_keys", return_value=True), \
             patch.object(self.watcher, "decrypt_changed", return_value=["message/message_0.db"]):
            self.watcher.watch_once()

        # Touch the encrypted file
        db_path = self.encrypted_dir / "message" / "message_0.db"
        time.sleep(0.1)
        with open(db_path, "wb") as f:
            f.write(b"\x00" * 8192)

        # Mock the key extraction and decryption since we don't have real keys
        with patch.object(self.watcher, "refresh_keys", return_value=True), \
             patch.object(self.watcher, "decrypt_changed", return_value=["message/message_0.db"]):
            result = self.watcher.watch_once()
            self.assertIsNone(result.error)
            self.assertTrue(
                any("message_0.db" in f for f in result.changed_files),
                f"message_0.db not in {result.changed_files}",
            )

    def test_non_message_db_change_does_not_trigger(self) -> None:
        """Changes to non-message DBs should not trigger decryption."""
        # First cycle: initial scan with mocked keys/decrypt
        with patch.object(self.watcher, "refresh_keys", return_value=True), \
             patch.object(self.watcher, "decrypt_changed", return_value=["message/message_0.db"]):
            self.watcher.watch_once()

        # Create a non-message DB file
        other_dir = self.encrypted_dir / "contact"
        other_dir.mkdir(parents=True, exist_ok=True)
        other_db = other_dir / "contact.db"
        time.sleep(0.1)
        other_db.write_bytes(b"\x00" * 4096)

        result = self.watcher.watch_once()
        self.assertIsNone(result.error)
        self.assertEqual(0, len(result.decrypted_files))

    def test_poll_and_ingest_advances_baseline(self) -> None:
        """Polling should ingest events and advance the baseline."""
        obs, ok = self.watcher.poll_and_ingest()
        # baseline=0, so the existing message (local_id=1) should be found
        self.assertEqual(1, len(obs))
        self.assertTrue(ok)
        # Baseline should have advanced to 1
        self.assertEqual(1, self.ledger.get_baseline("route-test"))

    def test_poll_and_ingest_with_advanced_baseline_finds_nothing(self) -> None:
        """With baseline=1, no new messages should be found."""
        self.ledger.update_baseline("route-test", 1)
        obs, ok = self.watcher.poll_and_ingest()
        self.assertEqual(0, len(obs))
        self.assertTrue(ok)

    def test_force_refresh_triggers_full_cycle(self) -> None:
        """force_refresh should trigger keys+decrypt+poll even without changes."""
        with patch.object(self.watcher, "refresh_keys", return_value=True), \
             patch.object(self.watcher, "decrypt_changed", return_value=["message/message_0.db"]):
            result = self.watcher.watch_once(force_refresh=True)
            self.assertIsNone(result.error)

    def test_watch_result_elapsed_is_positive(self) -> None:
        result = self.watcher.watch_once()
        self.assertGreaterEqual(result.elapsed_seconds, 0.0)

    def test_failed_key_extraction_preserves_snapshot_for_retry(self) -> None:
        """If key extraction fails, snapshot must not advance so next cycle retries."""
        # First cycle: initial scan with mocked keys/decrypt
        with patch.object(self.watcher, "refresh_keys", return_value=True), \
             patch.object(self.watcher, "decrypt_changed", return_value=["message/message_0.db"]):
            self.watcher.watch_once()

        # Touch the encrypted file
        db_path = self.encrypted_dir / "message" / "message_0.db"
        time.sleep(0.1)
        with open(db_path, "wb") as f:
            f.write(b"\x00" * 8192)

        # Mock key extraction failure
        with patch.object(self.watcher, "refresh_keys", return_value=False):
            result = self.watcher.watch_once()
            self.assertEqual("Key extraction failed", result.error)

        # Next cycle should still detect the change (snapshot not advanced)
        with patch.object(self.watcher, "refresh_keys", return_value=True), \
             patch.object(self.watcher, "decrypt_changed", return_value=["message/message_0.db"]):
            result = self.watcher.watch_once()
            self.assertTrue(
                any("message_0.db" in f for f in result.changed_files),
                "Change should still be detected after failed retry",
            )

    def test_failed_ingestion_does_not_advance_baseline(self) -> None:
        """If ingest_event fails, baseline must not advance for that message."""
        from unittest.mock import MagicMock
        # Replace ledger with a mock that always fails ingestion
        mock_ledger = MagicMock()
        mock_ledger.get_baseline.return_value = 0
        mock_ledger.ingest_event.side_effect = Exception("DB locked")
        mock_ledger.update_baseline.side_effect = Exception("should not be called")

        watcher2 = DbWatcher(
            self.encrypted_dir, self.decrypted_dir,
            self.keys_file, self.bindings, mock_ledger,
        )
        # poll_and_ingest should not raise, and should not call update_baseline
        # because no messages were successfully ingested
        obs, ok = watcher2.poll_and_ingest()
        # The message was observed but not ingested
        self.assertEqual(1, len(obs))
        self.assertFalse(ok)
        # update_baseline should NOT have been called
        mock_ledger.update_baseline.assert_not_called()

    def test_contiguous_baseline_with_gap(self) -> None:
        """Messages 4 ok, 5 fail, 6 ok → baseline stops at 4, not 6."""
        msg_db = self.decrypted_dir / "message" / "message_0.db"
        for lid in range(2, 7):
            _insert_msg(msg_db, "wxid_test", lid, f"msg{lid}")

        # Set baseline to 3 via real ledger
        self.ledger.update_baseline("route-test", 1)
        self.ledger.update_baseline("route-test", 2)
        self.ledger.update_baseline("route-test", 3)

        # Use a mock ledger that fails on local_id=5 only
        mock_ledger = MagicMock()
        mock_ledger.get_baseline.return_value = 3

        def selective_ingest(**kwargs):
            payload = kwargs.get("payload", {})
            lid = payload.get("local_id", 0)
            if lid == 5:
                raise Exception("DB locked")
            return {"inserted": True, "event_id": f"evt-{lid}", "wake": None}

        mock_ledger.ingest_event.side_effect = selective_ingest
        mock_ledger.update_baseline = MagicMock()

        watcher2 = DbWatcher(
            self.encrypted_dir, self.decrypted_dir,
            self.keys_file, self.bindings, mock_ledger,
        )
        obs, ok = watcher2.poll_and_ingest()

        # All 3 messages observed (4, 5, 6)
        self.assertEqual(3, len(obs))
        self.assertFalse(ok)
        # Baseline should advance to 4 (contiguous max), not 6
        mock_ledger.update_baseline.assert_called_once_with("route-test", 4)

    def test_snapshot_not_advanced_on_all_ingestion_failure(self) -> None:
        """If all ingestions fail, file snapshot must not advance so next cycle retries."""
        mock_ledger = MagicMock()
        mock_ledger.get_baseline.return_value = 0
        mock_ledger.ingest_event.side_effect = Exception("DB locked")

        watcher2 = DbWatcher(
            self.encrypted_dir, self.decrypted_dir,
            self.keys_file, self.bindings, mock_ledger,
        )

        # First cycle: mock keys/decrypt to succeed, but ingestion fails
        with patch.object(watcher2, "refresh_keys", return_value=True), \
             patch.object(watcher2, "decrypt_changed", return_value=["message/message_0.db"]):
            result = watcher2.watch_once()
            self.assertEqual("Ingestion failed for some messages", result.error)

        # Next cycle should still detect changes (snapshot not advanced)
        with patch.object(watcher2, "refresh_keys", return_value=True), \
             patch.object(watcher2, "decrypt_changed", return_value=["message/message_0.db"]):
            result = watcher2.watch_once()
            self.assertTrue(
                any("message_0.db" in f for f in result.changed_files),
                "Change should still be detected after ingestion failure",
            )

    def test_force_refresh_no_changes_does_not_report_decryption_failed(self) -> None:
        """force_refresh=True with no file changes should not report 'Decryption failed'."""
        # First cycle: do initial scan with mocks
        with patch.object(self.watcher, "refresh_keys", return_value=True), \
             patch.object(self.watcher, "decrypt_changed", return_value=["message/message_0.db"]):
            self.watcher.watch_once()

        # Second cycle: force_refresh with no file changes
        with patch.object(self.watcher, "refresh_keys", return_value=True), \
             patch.object(self.watcher, "decrypt_changed", return_value=["message/message_0.db"]):
            result = self.watcher.watch_once(force_refresh=True)
            self.assertIsNone(result.error)
            self.assertTrue(len(result.decrypted_files) > 0)

    def test_concurrent_watch_once_is_serialized(self) -> None:
        """Two concurrent watch_once calls should be serialized by the lock."""
        import threading
        call_log: list[str] = []
        original_impl = self.watcher._watch_once_impl

        def tracking_impl(force_refresh: bool) -> WatchResult:
            call_log.append("enter")
            time.sleep(0.1)
            call_log.append("exit")
            return original_impl(force_refresh)

        self.watcher._watch_once_impl = tracking_impl

        threads = []
        for _ in range(2):
            t = threading.Thread(target=lambda: self.watcher.watch_once())
            threads.append(t)

        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

        # Calls should be serialized: enter, exit, enter, exit (not interleaved)
        self.assertEqual(["enter", "exit", "enter", "exit"], call_log)

    def test_get_active_wake_returns_wake_id(self) -> None:
        """After ingesting an event, get_active_wake should return the wake_id."""
        self.ledger.ingest_event(
            route_id="route-test",
            source_fingerprint="fp-wake-test",
            event_type="text",
            payload={"text": "wake test"},
        )
        wake = self.ledger.get_active_wake("route-test")
        self.assertIsNotNone(wake)
        self.assertEqual("prepared", wake["state"])
        self.assertTrue(wake["wake_id"])

    def test_get_active_wake_returns_none_when_no_events(self) -> None:
        """With no pending events, get_active_wake should return None."""
        wake = self.ledger.get_active_wake("route-test")
        self.assertIsNone(wake)


if __name__ == "__main__":
    unittest.main()
