from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from wechat_docs_mcp.attachments import AttachmentRegistry
from wechat_docs_mcp.context_attachments import ContextAttachmentResolver
from wechat_docs_mcp.context_tokens import ContextTokenCodec
from wechat_docs_mcp.db_observer import DbObserver, RouteBinding
from wechat_docs_mcp.ledger import EventLedger, LedgerError
from wechat_docs_mcp.message_context import MessageContextReader


OWNER_KEY = "synthetic-owner-account"
OWNER_USERNAME = "wxid_synthetic_owner"
ROUTE_USERNAME = "wxid_synthetic_friend"
OTHER_USERNAME = "wxid_same_title_other"
ROUTE_ID = "route-context"
OTHER_ROUTE_ID = "route-context-same-title"
SUBSCRIPTION_ID = "subscription-context"
SECOND_SUBSCRIPTION_ID = "subscription-context-second"
DISABLED_SUBSCRIPTION_ID = "subscription-context-disabled"
OTHER_SUBSCRIPTION_ID = "subscription-context-other-route"
TITLE = "Synthetic Same Title"


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _message_table(username: str) -> str:
    return "Msg_" + hashlib.md5(username.encode("utf-8")).hexdigest()


def _create_message_table(connection: sqlite3.Connection, username: str) -> str:
    table = _message_table(username)
    connection.execute(
        f"""
        CREATE TABLE [{table}] (
          local_id INTEGER,
          server_id INTEGER,
          local_type INTEGER,
          sort_seq INTEGER,
          real_sender_id INTEGER,
          create_time INTEGER,
          status INTEGER,
          origin_source INTEGER,
          source TEXT,
          message_content TEXT,
          WCDB_CT_message_content INTEGER DEFAULT 0,
          WCDB_CT_source INTEGER DEFAULT 0
        )
        """
    )
    return table


def _make_decrypted_tree(root: Path) -> Path:
    message_dir = root / "message"
    contact_dir = root / "contact"
    message_dir.mkdir(parents=True)
    contact_dir.mkdir(parents=True)

    image_md5 = "a" * 32
    sticker_md5 = "b" * 32
    file_md5 = "c" * 32
    connection = sqlite3.connect(message_dir / "message_0.db")
    try:
        connection.executescript(
            f"""
            CREATE TABLE Name2Id(user_name TEXT,is_session INTEGER DEFAULT 0);
            INSERT INTO Name2Id VALUES('{ROUTE_USERNAME}',1);
            INSERT INTO Name2Id VALUES('{OWNER_USERNAME}',0);
            INSERT INTO Name2Id VALUES('{OTHER_USERNAME}',1);
            """
        )
        table = _create_message_table(connection, ROUTE_USERNAME)
        other_table = _create_message_table(connection, OTHER_USERNAME)
        connection.executemany(
            f"""
            INSERT INTO [{table}] (
              local_id,server_id,local_type,sort_seq,real_sender_id,create_time,
              status,origin_source,source,message_content,
              WCDB_CT_message_content,WCDB_CT_source
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            [
                (1, 1001, 1, 1, 1, 1_700_000_001, 3, 2, "", "Earlier question", 0, 0),
                (2, 1002, 1, 2, 2, 1_700_000_002, 2, 1, "", "Tomorrow at four?", 0, 0),
                (3, 1003, 1, 3, 1, 1_700_000_003, 3, 2, "", "应该可以", 0, 0),
                (
                    4,
                    1004,
                    3,
                    4,
                    1,
                    1_700_000_004,
                    3,
                    2,
                    "",
                    f'<msg><img md5="{image_md5}" hdlength="2048" width="640" height="480"/></msg>',
                    0,
                    0,
                ),
                (
                    5,
                    1005,
                    47,
                    5,
                    1,
                    1_700_000_005,
                    3,
                    2,
                    "",
                    f'<msg><emoji md5="{sticker_md5}" len="512" width="128" height="64"/></msg>',
                    0,
                    0,
                ),
                (
                    6,
                    1006,
                    49,
                    6,
                    1,
                    1_700_000_006,
                    3,
                    2,
                    "",
                    "<msg><appmsg><type>6</type><title>notes.pdf</title><md5>"
                    + file_md5
                    + "</md5><appattach><totallen>3072</totallen><fileext>pdf</fileext>"
                    "</appattach></appmsg></msg>",
                    0,
                    0,
                ),
                (7, 1007, 1, 7, 1, 1_700_000_007, 3, 2, "", "Tail message", 0, 0),
            ],
        )
        connection.execute(
            f"""
            INSERT INTO [{other_table}] VALUES
              (1,2001,1,1,3,1700000100,3,2,'','Other route message',0,0)
            """
        )
        connection.commit()
    finally:
        connection.close()

    connection = sqlite3.connect(contact_dir / "contact.db")
    try:
        connection.executescript(
            f"""
            CREATE TABLE contact(id INTEGER,username TEXT,nick_name TEXT,local_type INTEGER);
            INSERT INTO contact VALUES(1,'{ROUTE_USERNAME}','Synthetic Friend',1);
            INSERT INTO contact VALUES(2,'{OWNER_USERNAME}','Synthetic Owner',1);
            INSERT INTO contact VALUES(3,'{OTHER_USERNAME}','Other Same Title',1);
            """
        )
        connection.commit()
    finally:
        connection.close()
    return root


def _binding_document() -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "ownerAccountKey": OWNER_KEY,
        "routes": [
            {
                "route_id": ROUTE_ID,
                "display_title": TITLE,
                "chat_type": "friend",
                "username": ROUTE_USERNAME,
                "state": "active",
                "outbound": {"enabled": False},
            },
            {
                "route_id": OTHER_ROUTE_ID,
                "display_title": TITLE,
                "chat_type": "friend",
                "username": OTHER_USERNAME,
                "state": "active",
                "outbound": {"enabled": False},
            },
        ],
        "subscriptions": [
            {
                "subscription_id": SUBSCRIPTION_ID,
                "route_id": ROUTE_ID,
                "conversation_id": "conversation-a",
                "generation": 1,
                "state": "active",
                "listen_capability": True,
                "send_capability": False,
                "context_read_capability": True,
                "policy_ref": "context-test-policy",
            },
            {
                "subscription_id": SECOND_SUBSCRIPTION_ID,
                "route_id": ROUTE_ID,
                "conversation_id": "conversation-b",
                "generation": 1,
                "state": "active",
                "listen_capability": True,
                "send_capability": False,
                "context_read_capability": True,
                "policy_ref": "context-test-policy",
            },
            {
                "subscription_id": DISABLED_SUBSCRIPTION_ID,
                "route_id": ROUTE_ID,
                "conversation_id": "conversation-disabled",
                "generation": 1,
                "state": "active",
                "listen_capability": True,
                "send_capability": False,
                "context_read_capability": False,
                "policy_ref": "context-test-policy",
            },
            {
                "subscription_id": OTHER_SUBSCRIPTION_ID,
                "route_id": OTHER_ROUTE_ID,
                "conversation_id": "conversation-other",
                "generation": 1,
                "state": "active",
                "listen_capability": True,
                "send_capability": False,
                "context_read_capability": True,
                "policy_ref": "context-test-policy",
            },
        ],
    }


def _bindings() -> list[RouteBinding]:
    return [
        RouteBinding(ROUTE_ID, TITLE, "friend", ROUTE_USERNAME, OWNER_USERNAME),
        RouteBinding(OTHER_ROUTE_ID, TITLE, "friend", OTHER_USERNAME, OWNER_USERNAME),
    ]


def _ledger_state(ledger: EventLedger) -> dict[str, list[tuple[Any, ...]]]:
    connection = ledger._connect()
    try:
        return {
            table: [tuple(row) for row in connection.execute(f"SELECT * FROM [{table}] ORDER BY rowid")]
            for table in (
                "routes",
                "subscriptions",
                "events",
                "event_deliveries",
                "subscription_wakes",
                "attachments",
                "attachment_transfers",
            )
        }
    finally:
        connection.close()


@pytest.fixture()
def context_fixture(tmp_path: Path) -> dict[str, Any]:
    decrypted = _make_decrypted_tree(tmp_path / "decrypted")
    ledger = EventLedger(tmp_path / "events.sqlite3")
    ledger.register_route(
        ROUTE_ID,
        profile="test",
        state="active",
        owner_account_key=OWNER_KEY,
        username=ROUTE_USERNAME,
        chat_type="friend",
        display_title=TITLE,
    )
    ledger.register_route(
        OTHER_ROUTE_ID,
        profile="test",
        state="active",
        owner_account_key=OWNER_KEY,
        username=OTHER_USERNAME,
        chat_type="friend",
        display_title=TITLE,
    )
    ledger.register_subscription(
        ROUTE_ID,
        "conversation-a",
        1,
        subscription_id=SUBSCRIPTION_ID,
        context_read_capability=True,
        policy_ref="context-test-policy",
    )
    observer = DbObserver(decrypted, _bindings())
    anchor_observation = observer.read_route_messages(
        _bindings()[0], minimum_local_id=3, maximum_local_id=3
    )[0]
    event = ledger.ingest_event(
        ROUTE_ID,
        anchor_observation.source_fingerprint,
        anchor_observation.event_type,
        anchor_observation.payload,
        anchor_observation.occurred_at,
        anchor_observation.sensitivity,
    )
    ledger.register_subscription(
        ROUTE_ID,
        "conversation-b",
        1,
        subscription_id=SECOND_SUBSCRIPTION_ID,
        context_read_capability=True,
        policy_ref="context-test-policy",
    )
    ledger.register_subscription(
        ROUTE_ID,
        "conversation-disabled",
        1,
        subscription_id=DISABLED_SUBSCRIPTION_ID,
    )
    ledger.register_subscription(
        OTHER_ROUTE_ID,
        "conversation-other",
        1,
        subscription_id=OTHER_SUBSCRIPTION_ID,
        context_read_capability=True,
        policy_ref="context-test-policy",
    )
    clock = [1_800_000_000]
    codec = ContextTokenCodec(b"context-test-secret-32-bytes-minimum", now=lambda: clock[0])
    binding_document = _binding_document()
    reader = MessageContextReader(
        ledger,
        binding_document,
        _bindings(),
        decrypted,
        codec,
        active_owner_account_key_sha256=_sha256_text(OWNER_KEY),
    )
    resolver = ContextAttachmentResolver(
        ledger,
        binding_document,
        _bindings(),
        decrypted,
        codec,
        active_owner_account_key_sha256=_sha256_text(OWNER_KEY),
    )
    return {
        "ledger": ledger,
        "reader": reader,
        "resolver": resolver,
        "codec": codec,
        "clock": clock,
        "event_id": event["event_id"],
        "decrypted": decrypted,
        "tmp_path": tmp_path,
        "binding_document": binding_document,
    }


def _full_slice(fixture: dict[str, Any]) -> dict[str, Any]:
    return fixture["reader"].read(
        SUBSCRIPTION_ID,
        anchor_event_id=fixture["event_id"],
        before=2,
        after=4,
    )


def test_single_anchor_reads_two_way_context_without_mutating_ledger(
    context_fixture: dict[str, Any],
) -> None:
    before_state = _ledger_state(context_fixture["ledger"])
    result = _full_slice(context_fixture)
    after_state = _ledger_state(context_fixture["ledger"])

    assert [item["local_id"] for item in result["messages"]] == list(range(1, 8))
    assert [item["direction"] for item in result["messages"][:3]] == [
        "inbound",
        "outbound",
        "inbound",
    ]
    assert result["messages"][1]["visible_text"] == "Tomorrow at four?"
    assert result["messages"][2]["visible_text"] == "应该可以"
    assert result["source_cutoff_local_id"] == 7
    assert result["read_only"] is True
    assert result["ledger_state_changed"] is False
    assert before_state == after_state


def test_event_anchor_must_have_been_delivered_to_the_subscription(
    context_fixture: dict[str, Any],
) -> None:
    with pytest.raises(LedgerError) as raised:
        context_fixture["reader"].read(
            SECOND_SUBSCRIPTION_ID,
            anchor_event_id=context_fixture["event_id"],
        )
    assert raised.value.code == "CONTEXT_ANCHOR_NOT_AUTHORIZED"


def test_filters_apply_to_anchor_and_range_uses_signed_message_refs(
    context_fixture: dict[str, Any],
) -> None:
    full = _full_slice(context_fixture)
    refs = {item["local_id"]: item["message_ref"] for item in full["messages"]}

    outbound_only = context_fixture["reader"].read(
        SUBSCRIPTION_ID,
        anchor_event_id=context_fixture["event_id"],
        before=2,
        after=1,
        include_directions=["outbound"],
    )
    assert [item["local_id"] for item in outbound_only["messages"]] == [2]

    attachments = context_fixture["reader"].read(
        SUBSCRIPTION_ID,
        start_anchor=refs[2],
        end_anchor=refs[6],
        include_kinds=["image", "sticker", "file"],
    )
    assert [item["kind"] for item in attachments["messages"]] == [
        "image",
        "sticker",
        "file",
    ]


def test_continuation_is_stable_tamper_resistant_and_budget_adjustable(
    context_fixture: dict[str, Any],
) -> None:
    reader = context_fixture["reader"]
    page = reader.read(
        SUBSCRIPTION_ID,
        anchor_event_id=context_fixture["event_id"],
        before=2,
        after=4,
        max_messages=2,
    )
    observed = [item["local_id"] for item in page["messages"]]
    cursor = page["continuation_cursor"]
    assert cursor

    tampered = cursor[:-1] + ("A" if cursor[-1] != "A" else "B")
    with pytest.raises(LedgerError) as raised:
        reader.read(
            SUBSCRIPTION_ID,
            anchor_event_id=context_fixture["event_id"],
            before=2,
            after=4,
            continuation_cursor=tampered,
        )
    assert raised.value.code == "TOKEN_INVALID"

    while cursor:
        page = reader.read(
            SUBSCRIPTION_ID,
            anchor_event_id=context_fixture["event_id"],
            before=2,
            after=4,
            max_messages=3,
            max_chars=100_000,
            continuation_cursor=cursor,
        )
        observed.extend(item["local_id"] for item in page["messages"])
        cursor = page["continuation_cursor"]
    assert observed == list(range(1, 8))


def test_small_context_slice_does_not_depend_on_total_route_history_size(
    context_fixture: dict[str, Any],
) -> None:
    message_db = context_fixture["decrypted"] / "message" / "message_0.db"
    table = _message_table(ROUTE_USERNAME)
    connection = sqlite3.connect(message_db)
    try:
        connection.executemany(
            f"""
            INSERT INTO [{table}] (
              local_id,server_id,local_type,sort_seq,real_sender_id,create_time,
              status,origin_source,source,message_content,
              WCDB_CT_message_content,WCDB_CT_source
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                (
                    local_id,
                    10_000_000 + local_id,
                    1,
                    local_id,
                    1,
                    1_700_100_000 + local_id,
                    3,
                    2,
                    "",
                    "later history",
                    0,
                    0,
                )
                for local_id in range(100, 20_101)
            ),
        )
        connection.commit()
    finally:
        connection.close()

    result = context_fixture["reader"].read(
        SUBSCRIPTION_ID,
        anchor_event_id=context_fixture["event_id"],
        before=2,
        after=0,
    )
    assert [item["local_id"] for item in result["messages"]] == [1, 2, 3]
    assert result["source_cutoff_local_id"] == 20_100


def test_context_capability_scope_account_and_same_title_are_fail_closed(
    context_fixture: dict[str, Any],
) -> None:
    full = _full_slice(context_fixture)
    message_ref = full["messages"][0]["message_ref"]

    with pytest.raises(LedgerError) as disabled:
        context_fixture["reader"].read(
            DISABLED_SUBSCRIPTION_ID,
            anchor_message_ref=message_ref,
        )
    assert disabled.value.code == "CONTEXT_CAPABILITY_DISABLED"

    for subscription_id in (SECOND_SUBSCRIPTION_ID, OTHER_SUBSCRIPTION_ID):
        with pytest.raises(LedgerError) as crossed:
            context_fixture["reader"].read(
                subscription_id,
                anchor_message_ref=message_ref,
            )
        assert crossed.value.code == "CONTEXT_TOKEN_SCOPE_MISMATCH"

    switched_account_reader = MessageContextReader(
        context_fixture["ledger"],
        _binding_document(),
        _bindings(),
        context_fixture["decrypted"],
        context_fixture["codec"],
        active_owner_account_key_sha256="0" * 64,
    )
    with pytest.raises(LedgerError) as switched:
        switched_account_reader.read(
            SUBSCRIPTION_ID,
            anchor_event_id=context_fixture["event_id"],
        )
    assert switched.value.code == "CONTEXT_OWNER_ACCOUNT_MISMATCH"

    unscoped_reader = MessageContextReader(
        context_fixture["ledger"],
        _binding_document(),
        _bindings(),
        context_fixture["decrypted"],
        context_fixture["codec"],
    )
    with pytest.raises(LedgerError) as unscoped:
        unscoped_reader.read(
            SUBSCRIPTION_ID,
            anchor_event_id=context_fixture["event_id"],
        )
    assert unscoped.value.code == "CONTEXT_ACTIVE_OWNER_NOT_CONFIGURED"


def test_context_read_requires_runtime_policy_ref(
    context_fixture: dict[str, Any],
) -> None:
    with context_fixture["ledger"]._transaction() as connection:
        connection.execute(
            "UPDATE subscriptions SET policy_ref=NULL WHERE subscription_id=?",
            (SUBSCRIPTION_ID,),
        )

    with pytest.raises(LedgerError) as missing_policy:
        context_fixture["reader"].read(
            SUBSCRIPTION_ID,
            anchor_event_id=context_fixture["event_id"],
        )

    assert missing_policy.value.code == "CONTEXT_POLICY_REF_REQUIRED"


def test_private_context_policy_revocation_is_immediate_for_reads_and_attctx(
    context_fixture: dict[str, Any],
) -> None:
    result = _full_slice(context_fixture)
    attachment_ref = next(
        item["attachment"]["attachment_ref"]
        for item in result["messages"]
        if item["kind"] == "image"
    )
    private_policy = next(
        item
        for item in context_fixture["binding_document"]["subscriptions"]
        if item["subscription_id"] == SUBSCRIPTION_ID
    )
    private_policy["context_read_capability"] = False

    with pytest.raises(LedgerError) as read_denied:
        context_fixture["reader"].read(
            SUBSCRIPTION_ID,
            anchor_event_id=context_fixture["event_id"],
        )
    assert read_denied.value.code == "CONTEXT_PRIVATE_POLICY_UNVERIFIED"

    with pytest.raises(LedgerError) as attachment_denied:
        context_fixture["resolver"].resolve(SUBSCRIPTION_ID, attachment_ref)
    assert attachment_denied.value.code == "CONTEXT_PRIVATE_POLICY_UNVERIFIED"


def test_invalid_kind_filter_is_rejected(context_fixture: dict[str, Any]) -> None:
    with pytest.raises(LedgerError) as invalid:
        context_fixture["reader"].read(
            SUBSCRIPTION_ID,
            anchor_event_id=context_fixture["event_id"],
            include_kinds=["typo-kind"],
        )
    assert invalid.value.code == "CONTEXT_KIND_FILTER_INVALID"


def test_long_text_continuation_does_not_drop_remaining_characters(
    context_fixture: dict[str, Any],
) -> None:
    message_db = context_fixture["decrypted"] / "message" / "message_0.db"
    connection = sqlite3.connect(message_db)
    try:
        connection.execute(
            f"UPDATE [{_message_table(ROUTE_USERNAME)}] SET message_content='abcdefghij' WHERE local_id=1"
        )
        connection.commit()
    finally:
        connection.close()

    cursor = ""
    fragments: list[str] = []
    while True:
        page = context_fixture["reader"].read(
            SUBSCRIPTION_ID,
            anchor_event_id=context_fixture["event_id"],
            before=2,
            after=0,
            max_chars=3,
            continuation_cursor=cursor,
        )
        for item in page["messages"]:
            if item["local_id"] == 1:
                fragments.append(item["visible_text"])
                assert item["text_fragment_end"] <= item["text_total_characters"]
        cursor = page["continuation_cursor"] or ""
        if not cursor or any(
            item["local_id"] > 1 for item in page["messages"]
        ):
            break
    assert "".join(fragments) == "abcdefghij"


def test_message_ref_keeps_its_original_source_cutoff(
    context_fixture: dict[str, Any],
) -> None:
    full = _full_slice(context_fixture)
    tail_ref = next(
        item["message_ref"] for item in full["messages"] if item["local_id"] == 7
    )
    message_db = context_fixture["decrypted"] / "message" / "message_0.db"
    table = _message_table(ROUTE_USERNAME)
    connection = sqlite3.connect(message_db)
    try:
        connection.execute(
            f"""
            INSERT INTO [{table}] (
              local_id,server_id,local_type,sort_seq,real_sender_id,create_time,
              status,origin_source,source,message_content,
              WCDB_CT_message_content,WCDB_CT_source
            ) VALUES(8,1008,1,8,1,1700000008,3,2,'','Later message',0,0)
            """
        )
        connection.commit()
    finally:
        connection.close()

    result = context_fixture["reader"].read(
        SUBSCRIPTION_ID,
        anchor_message_ref=tail_ref,
        before=0,
        after=1,
    )

    assert result["source_cutoff_local_id"] == 7
    assert [item["local_id"] for item in result["messages"]] == [7]


def test_message_ref_rejects_source_payload_drift(
    context_fixture: dict[str, Any],
) -> None:
    full = _full_slice(context_fixture)
    message_ref = next(
        item["message_ref"] for item in full["messages"] if item["local_id"] == 7
    )
    message_db = context_fixture["decrypted"] / "message" / "message_0.db"
    table = _message_table(ROUTE_USERNAME)
    connection = sqlite3.connect(message_db)
    try:
        connection.execute(
            f"UPDATE [{table}] SET message_content='changed source text' WHERE local_id=7"
        )
        connection.commit()
    finally:
        connection.close()

    with pytest.raises(LedgerError) as drifted:
        context_fixture["reader"].read(
            SUBSCRIPTION_ID,
            anchor_message_ref=message_ref,
            before=0,
            after=0,
        )

    assert drifted.value.code == "CONTEXT_SOURCE_DRIFT"


def test_continuation_rejects_source_text_drift(
    context_fixture: dict[str, Any],
) -> None:
    message_db = context_fixture["decrypted"] / "message" / "message_0.db"
    table = _message_table(ROUTE_USERNAME)
    connection = sqlite3.connect(message_db)
    try:
        connection.execute(
            f"UPDATE [{table}] SET message_content='abcdefghij' WHERE local_id=1"
        )
        connection.commit()
    finally:
        connection.close()
    first = context_fixture["reader"].read(
        SUBSCRIPTION_ID,
        anchor_event_id=context_fixture["event_id"],
        before=2,
        after=0,
        max_chars=3,
    )

    connection = sqlite3.connect(message_db)
    try:
        connection.execute(
            f"UPDATE [{table}] SET message_content='abcXYZghij' WHERE local_id=1"
        )
        connection.commit()
    finally:
        connection.close()

    with pytest.raises(LedgerError) as drifted:
        context_fixture["reader"].read(
            SUBSCRIPTION_ID,
            anchor_event_id=context_fixture["event_id"],
            before=2,
            after=0,
            max_chars=3,
            continuation_cursor=first["continuation_cursor"],
        )
    assert drifted.value.code == "CONTEXT_SOURCE_DRIFT"


def test_default_context_read_starts_with_a_small_source_window(
    context_fixture: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[int, int]] = []
    original = DbObserver.read_route_message_window

    def bounded_window(
        observer: DbObserver,
        binding: RouteBinding,
        anchor_local_id: int,
        *,
        maximum_local_id: int,
        rows_before: int,
        rows_after: int,
    ) -> list[Any]:
        calls.append((rows_before, rows_after))
        return original(
            observer,
            binding,
            anchor_local_id,
            maximum_local_id=maximum_local_id,
            rows_before=rows_before,
            rows_after=rows_after,
        )

    monkeypatch.setattr(DbObserver, "read_route_message_window", bounded_window)
    context_fixture["reader"].read(
        SUBSCRIPTION_ID,
        anchor_event_id=context_fixture["event_id"],
    )

    assert calls == [(32, 32)]


def test_undelivered_ledger_event_id_is_not_disclosed(
    context_fixture: dict[str, Any],
) -> None:
    observer = DbObserver(context_fixture["decrypted"], _bindings())
    outbound = observer.read_route_messages(
        _bindings()[0], minimum_local_id=2, maximum_local_id=2
    )[0]
    context_fixture["ledger"].ingest_event(
        ROUTE_ID,
        outbound.source_fingerprint,
        outbound.event_type,
        outbound.payload,
        outbound.occurred_at,
        outbound.sensitivity,
        deliver_to_subscriptions=False,
    )
    result = _full_slice(context_fixture)
    item = next(message for message in result["messages"] if message["local_id"] == 2)
    assert item["event_id"] is None


def test_historical_image_sticker_and_file_refs_are_distinct_and_scoped(
    context_fixture: dict[str, Any],
) -> None:
    full = _full_slice(context_fixture)
    attachment_items = [item for item in full["messages"] if item["attachment"]]
    assert [item["kind"] for item in attachment_items] == ["image", "sticker", "file"]
    refs = [item["attachment"]["attachment_ref"] for item in attachment_items]
    assert len(set(refs)) == 3
    assert all(ref.startswith("attctx_") for ref in refs)
    assert all(
        item["attachment"]["attachment_state"] == "reference_ready_not_materialized"
        for item in attachment_items
    )

    for item, ref in zip(attachment_items, refs):
        resolved = context_fixture["resolver"].resolve(SUBSCRIPTION_ID, ref)
        assert resolved["kind"] == item["kind"]
        assert resolved["event_id"] is None
        assert resolved["reference_kind"] == "context"
        assert resolved["observed_at"] is None

    with pytest.raises(LedgerError) as crossed:
        context_fixture["resolver"].resolve(SECOND_SUBSCRIPTION_ID, refs[0])
    assert crossed.value.code == "ATTCTX_SCOPE_MISMATCH"

    tampered = refs[0][:-1] + ("A" if refs[0][-1] != "A" else "B")
    with pytest.raises(LedgerError) as invalid:
        context_fixture["resolver"].resolve(SUBSCRIPTION_ID, tampered)
    assert invalid.value.code == "TOKEN_INVALID"

    context_fixture["clock"][0] += 24 * 60 * 60
    with pytest.raises(LedgerError) as expired:
        context_fixture["resolver"].resolve(SUBSCRIPTION_ID, refs[0])
    assert expired.value.code == "TOKEN_EXPIRED"


def test_attachment_source_drift_is_rejected(context_fixture: dict[str, Any]) -> None:
    full = _full_slice(context_fixture)
    image_ref = next(
        item["attachment"]["attachment_ref"]
        for item in full["messages"]
        if item["kind"] == "image"
    )
    message_db = context_fixture["decrypted"] / "message" / "message_0.db"
    connection = sqlite3.connect(message_db)
    try:
        connection.execute(
            f"UPDATE [{_message_table(ROUTE_USERNAME)}] SET local_type=47 WHERE local_id=4"
        )
        connection.commit()
    finally:
        connection.close()
    with pytest.raises(LedgerError) as drifted:
        context_fixture["resolver"].resolve(SUBSCRIPTION_ID, image_ref)
    assert drifted.value.code == "ATTCTX_SOURCE_DRIFT"


class WaitingMaterializer:
    def materialize(self, attachment: dict[str, Any], destination: Path) -> str:
        raise LedgerError("ATTACHMENT_IMAGE_INDEX_WAITING", "原件尚未由客户端物化")


def test_unavailable_historical_original_is_not_reported_as_success(
    context_fixture: dict[str, Any],
) -> None:
    full = _full_slice(context_fixture)
    image_ref = next(
        item["attachment"]["attachment_ref"]
        for item in full["messages"]
        if item["kind"] == "image"
    )
    registry = AttachmentRegistry(
        context_fixture["ledger"],
        context_fixture["tmp_path"] / "intake",
        context_fixture["tmp_path"] / "upload",
        context_fixture["resolver"],
    )
    with pytest.raises(LedgerError) as waiting:
        registry.ensure_downloaded(SUBSCRIPTION_ID, image_ref, WaitingMaterializer())
    assert waiting.value.code == "ATTACHMENT_IMAGE_INDEX_WAITING"

    connection = context_fixture["ledger"]._connect()
    try:
        transfer = connection.execute(
            "SELECT * FROM attachment_transfers WHERE attachment_ref=?",
            (image_ref,),
        ).fetchone()
    finally:
        connection.close()
    assert transfer is not None
    assert transfer["state"] == "FAILED"
    assert json.loads(transfer["result_json"])["error_code"] == "ATTACHMENT_IMAGE_INDEX_WAITING"
