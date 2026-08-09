from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from wechat_docs_mcp.db_observer import (
    DbObserver,
    Observation,
    RouteBinding,
)


def _make_decrypted_tree(base: Path) -> Path:
    """Create a minimal decrypted DB tree for testing."""
    msg_dir = base / "message"
    contact_dir = base / "contact"
    msg_dir.mkdir(parents=True)
    contact_dir.mkdir(parents=True)

    # message_0.db with Name2Id and a Msg_ table
    msg_db = msg_dir / "message_0.db"
    conn = sqlite3.connect(str(msg_db))
    conn.executescript("""
        CREATE TABLE Name2Id (
            user_name TEXT,
            is_session INTEGER DEFAULT 0
        );
        INSERT INTO Name2Id VALUES ('wxid_test_friend', 1);
        INSERT INTO Name2Id VALUES ('wxid_self', 0);
        INSERT INTO Name2Id VALUES ('', 0);
        INSERT INTO Name2Id VALUES ('12345@chatroom', 1);
    """)
    # Create a Msg_ table for the friend (MD5 of 'wxid_test_friend')
    import hashlib
    friend_hash = hashlib.md5(b"wxid_test_friend").hexdigest()
    friend_table = f"Msg_{friend_hash}"
    conn.executescript(f"""
        CREATE TABLE [{friend_table}] (
            local_id INTEGER,
            server_id INTEGER,
            local_type INTEGER,
            sort_seq INTEGER,
            real_sender_id INTEGER,
            create_time INTEGER,
            status INTEGER,
            source TEXT,
            message_content TEXT,
            compress_content TEXT,
            packed_info_data BLOB,
            WCDB_CT_message_content INTEGER DEFAULT 0,
            WCDB_CT_source INTEGER DEFAULT 0
        );
        INSERT INTO [{friend_table}] VALUES
            (1, 1001, 1, 1700000001000, 1, 1700000001, 4, '<msgsource/>', 'hello world', '', NULL, 0, 0),
            (2, 1002, 10000, 1700000002000, 2, 1700000002, 4, '<msgsource/>', 'You added a contact', '', NULL, 0, 0),
            (3, 1003, 1, 1700000003000, 2, 1700000003, 4, '<msgsource/>', 'hi there', '', NULL, 0, 0);
    """)
    # Create a Msg_ table for the group (MD5 of '12345@chatroom')
    group_hash = hashlib.md5(b"12345@chatroom").hexdigest()
    group_table = f"Msg_{group_hash}"
    conn.executescript(f"""
        CREATE TABLE [{group_table}] (
            local_id INTEGER,
            server_id INTEGER,
            local_type INTEGER,
            sort_seq INTEGER,
            real_sender_id INTEGER,
            create_time INTEGER,
            status INTEGER,
            source TEXT,
            message_content TEXT,
            compress_content TEXT,
            packed_info_data BLOB,
            WCDB_CT_message_content INTEGER DEFAULT 0,
            WCDB_CT_source INTEGER DEFAULT 0
        );
        INSERT INTO [{group_table}] VALUES
            (1, 2001, 10000, 1700000010000, 2, 1700000010, 4, '<msgsource/>', 'UserA joined the group', '', NULL, 0, 0),
            (2, 2002, 1, 1700000011000, 1, 1700000011, 4, '<msgsource/>', 'wxid_test_friend:\ngroup test message', '', NULL, 0, 0);
    """)
    conn.commit()
    conn.close()

    # contact.db
    contact_db = contact_dir / "contact.db"
    conn = sqlite3.connect(str(contact_db))
    conn.executescript("""
        CREATE TABLE contact (
            id INTEGER,
            username TEXT,
            nick_name TEXT,
            local_type INTEGER
        );
        INSERT INTO contact VALUES
            (1, 'wxid_test_friend', 'TestFriend', 1),
            (2, 'wxid_self', 'MySelf', 1),
            (3, '12345@chatroom', 'TestGroup', 2);
        CREATE TABLE chatroom_member (
            chatroom_id INTEGER,
            member_username TEXT
        );
        INSERT INTO chatroom_member VALUES (3, 'wxid_test_friend'), (3, 'wxid_self');
    """)
    conn.commit()
    conn.close()

    return base


class DbObserverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.decrypted_dir = Path(self.temp_dir.name) / "decrypted"
        _make_decrypted_tree(self.decrypted_dir)
        self.bindings = [
            RouteBinding(
                route_id="route-friend",
                exact_title="TestFriend",
                chat_type="friend",
                username="wxid_test_friend",
            ),
            RouteBinding(
                route_id="route-group",
                exact_title="TestGroup",
                chat_type="group",
                username="12345@chatroom",
            ),
        ]
        self.observer = DbObserver(self.decrypted_dir, self.bindings)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_baseline_returns_max_local_id_per_route(self) -> None:
        baselines = self.observer.establish_baseline()
        self.assertEqual(3, baselines["route-friend"])
        self.assertEqual(2, baselines["route-group"])

    def test_poll_with_zero_baseline_yields_all_messages(self) -> None:
        observations = list(self.observer.poll_new_messages({}))
        # 3 friend + 2 group = 5 total
        self.assertEqual(5, len(observations))

    def test_poll_respects_baseline_no_replay(self) -> None:
        baselines = {"route-friend": 2, "route-group": 1}
        observations = list(self.observer.poll_new_messages(baselines))
        # Only friend local_id=3 and group local_id=2
        self.assertEqual(2, len(observations))
        friend_obs = [o for o in observations if o.route_id == "route-friend"]
        group_obs = [o for o in observations if o.route_id == "route-group"]
        self.assertEqual(1, len(friend_obs))
        self.assertEqual(1, len(group_obs))
        self.assertEqual(3, friend_obs[0].payload["local_id"])
        self.assertEqual(2, group_obs[0].payload["local_id"])

    def test_text_message_classification_and_content(self) -> None:
        observations = list(self.observer.poll_new_messages({}))
        text_msgs = [
            o for o in observations
            if o.event_type == "text" and o.route_id == "route-friend"
        ]
        self.assertEqual(2, len(text_msgs))
        contents = [o.payload["visible_text"] for o in text_msgs]
        self.assertIn("hello world", contents)
        self.assertIn("hi there", contents)

    def test_system_message_classification(self) -> None:
        observations = list(self.observer.poll_new_messages({}))
        system_msgs = [o for o in observations if o.event_type == "system"]
        self.assertGreaterEqual(len(system_msgs), 2)

    def test_sender_display_name_resolved(self) -> None:
        observations = list(self.observer.poll_new_messages({}))
        friend_msgs = [o for o in observations if o.route_id == "route-friend"]
        # local_id=1 is from sender_id=1 = wxid_test_friend = TestFriend
        msg1 = next(o for o in friend_msgs if o.payload["local_id"] == 1)
        self.assertEqual("TestFriend", msg1.payload["sender_display"])

    def test_group_sender_prefix_is_removed_from_visible_text(self) -> None:
        observations = list(self.observer.poll_new_messages({}))
        group_message = next(
            observation
            for observation in observations
            if observation.route_id == "route-group" and observation.payload["local_id"] == 2
        )
        self.assertEqual("wxid_test_friend", group_message.payload["sender_username"])
        self.assertEqual("group test message", group_message.payload["visible_text"])

    def test_group_sender_prefix_requires_exact_sender(self) -> None:
        content = "wxid_other:\nkeep this text"
        self.assertEqual(
            content,
            self.observer._strip_group_sender_prefix(content, "wxid_test_friend"),
        )

    def test_dedup_fingerprint_is_unique_per_message(self) -> None:
        observations = list(self.observer.poll_new_messages({}))
        fingerprints = [o.source_fingerprint for o in observations]
        self.assertEqual(len(fingerprints), len(set(fingerprints)))

    def test_route_identity_includes_member_count_for_group(self) -> None:
        binding = self.bindings[1]  # group
        identity = self.observer.get_route_identity(binding)
        self.assertEqual("TestGroup", identity["chat_name"])
        self.assertEqual("group", identity["chat_type"])
        self.assertEqual(2, identity["group_member_count"])

    def test_route_identity_for_friend_has_no_member_count(self) -> None:
        binding = self.bindings[0]  # friend
        identity = self.observer.get_route_identity(binding)
        self.assertEqual("TestFriend", identity["chat_name"])
        self.assertNotIn("group_member_count", identity)

    def test_missing_msg_table_produces_empty_baseline(self) -> None:
        binding = RouteBinding(
            route_id="route-missing",
            exact_title="Nonexistent",
            chat_type="friend",
            username="wxid_nonexistent_user",
        )
        observer = DbObserver(self.decrypted_dir, [binding])
        baselines = observer.establish_baseline()
        self.assertEqual(0, baselines["route-missing"])


if __name__ == "__main__":
    unittest.main()
