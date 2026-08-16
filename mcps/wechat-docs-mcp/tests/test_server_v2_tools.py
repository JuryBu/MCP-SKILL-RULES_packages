from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from wechat_docs_mcp import server
from wechat_docs_mcp.ledger import EventLedger
from wechat_docs_mcp.route_verifier import RouteVerificationError


OWNER_KEY = "synthetic-owner-key"
USERNAME = "synthetic-room@chatroom"


def configure_private_layer(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> EventLedger:
    data_root = tmp_path / "private"
    binding_file = data_root / "config" / "binding.json"
    intake_root = data_root / "intake"
    upload_root = data_root / "upload"
    binding_file.parent.mkdir(parents=True)
    intake_root.mkdir(parents=True)
    upload_root.mkdir(parents=True)
    binding_file.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "ownerAccountKey": OWNER_KEY,
                "routes": [
                    {
                        "route_id": "route-synthetic",
                        "exact_title": "Synthetic Room",
                        "display_title": "Synthetic Room",
                        "chat_type": "group",
                        "username": USERNAME,
                        "state": "active",
                        "outbound": {
                            "enabled": True,
                            "text": True,
                            "file": True,
                            "image": True,
                        },
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(server, "DATA_ROOT", data_root)
    monkeypatch.setattr(server, "BINDING_FILE", binding_file)
    monkeypatch.setattr(server, "ATTACHMENT_INTAKE_ROOT", intake_root)
    monkeypatch.setattr(server, "ATTACHMENT_UPLOAD_ROOT", upload_root)
    event_ledger = EventLedger(data_root / "state" / "events.sqlite3")
    event_ledger.register_route(
        "route-synthetic",
        profile="human_group",
        identity={"chat_name": "Synthetic Room"},
        state="active",
        owner_account_key=OWNER_KEY,
        username=USERNAME,
        chat_type="group",
        display_title="Synthetic Room",
    )
    event_ledger.register_subscription(
        "route-synthetic",
        "conversation-synthetic",
        1,
        subscription_id="subscription-synthetic",
        send_capability=True,
        policy_ref="private-test-policy",
    )
    return event_ledger


def test_server_prepare_approve_and_status_use_subscription_policy(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    configure_private_layer(monkeypatch, tmp_path)
    payload = {"text": "SYNTHETIC_MARKER"}
    draft = server.outbound_prepare(
        "route-synthetic",
        "wechat_text",
        payload,
        subscription_id="subscription-synthetic",
    )
    reference = {
        "conversation_id": "conversation-owner",
        "turn_id": "turn-owner",
        "message_item_id": "item-owner",
        "role": "user",
        "authorized_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
    }
    approved = server.outbound_approve(
        draft["draft_id"], payload, [reference], "dedupe-server-v2"
    )
    assert approved["state"] == "APPROVED"
    assert server.outbound_status(draft["draft_id"])["subscription_id"] == "subscription-synthetic"


def test_server_prepare_refuses_route_without_private_outbound_policy(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    configure_private_layer(monkeypatch, tmp_path)
    binding = json.loads(server.BINDING_FILE.read_text(encoding="utf-8"))
    binding["routes"][0]["outbound"]["enabled"] = False
    server.BINDING_FILE.write_text(json.dumps(binding), encoding="utf-8")
    with pytest.raises(RouteVerificationError) as raised:
        server.outbound_prepare(
            "route-synthetic",
            "wechat_text",
            {"text": "SYNTHETIC_MARKER"},
            subscription_id="subscription-synthetic",
        )
    assert raised.value.code == "UNVERIFIED"


def test_legacy_binding_without_route_state_remains_listenable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    binding_file = tmp_path / "binding.json"
    binding_file.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "ownerAccountKey": OWNER_KEY,
                "ownerSenderUsername": "synthetic-owner-sender",
                "routes": [
                    {
                        "route_id": "route-legacy",
                        "exact_title": "Synthetic Legacy",
                        "chat_type": "friend",
                        "username": "synthetic-contact-id",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(server, "BINDING_FILE", binding_file)
    bindings = server._load_bindings()
    assert len(bindings) == 1
    assert bindings[0].route_id == "route-legacy"
    assert bindings[0].owner_sender_username == "synthetic-owner-sender"


def test_route_owner_override_does_not_inherit_another_accounts_sender(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    binding_file = tmp_path / "binding.json"
    binding_file.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "ownerAccountKey": OWNER_KEY,
                "ownerSenderUsername": "synthetic-root-owner",
                "routes": [
                    {
                        "route_id": "route-other-owner",
                        "exact_title": "Synthetic Other Owner",
                        "chat_type": "friend",
                        "username": "synthetic-contact-id",
                        "ownerAccountKey": "b" * 64,
                    },
                    {
                        "route_id": "route-explicit-owner",
                        "exact_title": "Synthetic Explicit Owner",
                        "chat_type": "friend",
                        "username": "synthetic-contact-id-2",
                        "ownerAccountKey": "c" * 64,
                        "ownerSenderUsername": "synthetic-route-owner",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(server, "BINDING_FILE", binding_file)

    bindings = server._load_bindings()

    assert bindings[0].owner_sender_username == ""
    assert bindings[1].owner_sender_username == "synthetic-route-owner"


def test_server_attachment_and_document_change_interfaces_are_non_sending(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    configure_private_layer(monkeypatch, tmp_path)
    upload = server.ATTACHMENT_UPLOAD_ROOT / "sample.txt"
    upload.write_text("safe", encoding="utf-8")
    transfer = server.wechat_attachment_upload_prepare(
        "subscription-synthetic",
        "route-synthetic",
        str(upload),
        "dedupe-upload-v2",
    )
    assert transfer["transfer"]["state"] == "PREPARED"
    assert transfer["draft"]["state"] == "PREPARED"
    assert transfer["transfer"]["sha256"]

    start = datetime(2026, 8, 10, 0, 0, tzinfo=timezone.utc)
    batch = server.tdocs_change_observe(
        "synthetic-document",
        "doc",
        "change-1",
        {"changed_blocks": 1},
        start.isoformat(),
    )
    assert server.tdocs_change_batches_ready(
        (start + timedelta(minutes=5)).isoformat()
    )[0]["batch_id"] == batch["batch_id"]
    assert server.tdocs_change_batch_mark_emitted(batch["batch_id"])["state"] == "EMITTED"
    capabilities = server.wechat_outbound_capabilities()
    assert capabilities["runtime_gate_mode"] == "private_file_dynamic_fail_closed"
    assert capabilities["configured_enabled"] is False
    assert capabilities["attachment_configured_enabled"] is False
    assert capabilities["active_execution_count"] == 0
    assert capabilities["visible_ui_backend_implemented"] is True
    assert capabilities["hidden_after_verified_navigation"] is True
    assert capabilities["attachment_input_mode"] == "file_picker"
    assert capabilities["attachment_preferred_input_mode"] == "cf_hdrop_strict_no_window"
    assert capabilities["attachment_cf_hdrop_candidate"] is True
    assert capabilities["attachment_cf_hdrop_enabled"] is False
    assert capabilities["file_picker_fallback_available"] is True
    assert capabilities["file_picker_fallback_disturbance"] == "low"
    assert capabilities["attachment_remote_confirmation_required"] is True
    assert capabilities["complex_clipboard_restore_verified"] is False
    assert capabilities["no_disturbance_metrics_implemented"] is True


def test_wechat_status_reports_attachment_only_gate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    configure_private_layer(monkeypatch, tmp_path)
    monkeypatch.setattr(server, "outbound_runtime_enabled", lambda: False)
    monkeypatch.setattr(server, "attachment_outbound_runtime_enabled", lambda: True)

    status = server.wechat_status()

    assert status["outbound_enabled"] is True
    assert status["outbound_text_enabled"] is False
    assert status["attachment_outbound_enabled"] is True
    assert status["runtime_gate_mode"] == "private_file_dynamic_fail_closed"
    assert status["wake_message_visibility"] == server.WAKE_MESSAGE_VISIBILITY


def test_official_tool_level_error_does_not_verify_draft(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    configure_private_layer(monkeypatch, tmp_path)
    payload = {
        "provider": "tencent_docs_official_mcp",
        "tool": "synthetic_mutation",
        "arguments": {"value": "unchanged"},
    }
    event_ledger = server.ledger()
    draft = event_ledger.prepare_draft(
        "route-synthetic",
        "tdocs_official_call",
        payload,
        (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
    )
    reference = {
        "conversation_id": "conversation-owner",
        "turn_id": "turn-owner",
        "message_item_id": "item-owner",
        "role": "user",
        "authorized_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
    }
    event_ledger.approve_draft(draft["draft_id"], payload, [reference], "dedupe-tool-error")

    class ToolErrorClient:
        async def tool_catalog(self) -> list[dict[str, object]]:
            return [{"name": "synthetic_mutation", "annotations": {"readOnlyHint": False}}]

        async def call_tool(self, name: str, arguments: dict[str, object]) -> dict[str, object]:
            return {"jsonrpc": "2.0", "result": {"isError": True, "content": []}}

    monkeypatch.setattr(server, "docs_client", lambda: ToolErrorClient())
    response = asyncio.run(
        server.tdocs_official_call(
            "synthetic_mutation",
            {"value": "unchanged"},
            draft["draft_id"],
            "dedupe-tool-error",
        )
    )
    assert response["result"]["isError"] is True
    status = event_ledger.get_draft(draft["draft_id"])
    assert status["state"] == "FAILED"
    assert status["result"]["tool_reported_error"] is True


def test_outbound_prepare_maps_image_capability_and_rejects_unknown_kind(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    configure_private_layer(monkeypatch, tmp_path)
    draft = server.outbound_prepare(
        "route-synthetic",
        "wechat_image",
        {"attachment_sha256": "a" * 64},
        subscription_id="subscription-synthetic",
    )
    assert draft["state"] == "PREPARED"
    with pytest.raises(ValueError, match="unsupported WeChat outbound kind"):
        server.outbound_prepare(
            "route-synthetic",
            "wechat_unknown",
            {"value": "x"},
            subscription_id="subscription-synthetic",
        )


def test_document_monitor_tools_are_registered() -> None:
    tools = asyncio.run(server.mcp.list_tools())
    names = {tool.name for tool in tools}
    assert {
        "tdocs_monitor_create",
        "tdocs_monitors_list",
        "tdocs_monitor_set_state",
        "tdocs_monitor_subscription_create",
        "tdocs_monitor_subscriptions_list",
        "tdocs_monitor_subscription_set_state",
        "tdocs_monitor_poll",
        "tdocs_monitor_pending_batches",
        "tdocs_monitor_wake_info",
        "tdocs_monitor_batches_ack",
        "tdocs_monitor_health",
        "tdocs_monitor_capabilities",
        "tdocs_monitor_poll_start",
        "tdocs_monitor_poll_stop",
    }.issubset(names)
    assert {
        "wechat_read_attachments",
        "wechat_read_image",
        "wechat_capture_visible_image_preview",
        "wechat_text_send_execute",
    }.issubset(names)
    assert len(names) == 50
    attachment_verify = next(tool for tool in tools if tool.name == "wechat_attachment_upload_verify")
    assert set(attachment_verify.input_schema["required"]) == {"draft_id", "remote_confirmation"}
