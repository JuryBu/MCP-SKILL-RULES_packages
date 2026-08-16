from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .db_observer import DbObserver, RouteBinding, resolve_owner_sender_username
from .ledger import EventLedger, LedgerError


DATA_ROOT = Path(
    os.environ.get(
        "WECHAT_DOCS_MCP_DATA_ROOT",
        Path.home() / ".codex-toolkit" / "wechat-docs-mcp",
    )
)
DECRYPTED_DIR = DATA_ROOT / "private-state" / "decrypted"
LEDGER_PATH = DATA_ROOT / "state" / "events.sqlite3"
BINDING_FILE = DATA_ROOT / "config" / "binding.json"


def load_binding_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Binding file not found: {path}")
    with path.open(encoding="utf-8") as stream:
        data = json.load(stream)
    owner_account_key = str(data.get("ownerAccountKey") or "").strip()
    if not owner_account_key:
        raise ValueError("ownerAccountKey is required")
    routes = data.get("routes") or []
    if not routes:
        raise ValueError("At least one route is required")
    data["ownerAccountKey"] = owner_account_key
    return data


def load_bindings(path: Path) -> list[RouteBinding]:
    data = load_binding_config(path)
    owner_account_key = data["ownerAccountKey"]
    owner_sender_username = str(data.get("ownerSenderUsername") or "")
    return [
        RouteBinding(
            route_id=route["route_id"],
            exact_title=route["exact_title"],
            chat_type=route["chat_type"],
            username=route["username"],
            owner_account_key=str(route.get("ownerAccountKey") or owner_account_key),
            owner_sender_username=resolve_owner_sender_username(
                route,
                default_owner_account_key=owner_account_key,
                default_owner_sender_username=owner_sender_username,
            ),
        )
        for route in data["routes"]
    ]


def _subscriptions(data: dict[str, Any]) -> list[dict[str, Any]]:
    subscriptions = list(data.get("subscriptions") or [])
    if subscriptions:
        return subscriptions
    for route in data["routes"]:
        conversation_id = str(route.get("conversation_id") or "").strip()
        if conversation_id:
            subscriptions.append(
                {
                    "route_id": route["route_id"],
                    "conversation_id": conversation_id,
                    "generation": int(route.get("generation", 1)),
                    "state": "active" if route.get("state", "active") == "active" else "paused",
                    "listen_capability": True,
                    "send_capability": False,
                    "policy_ref": "legacy-binding-v1",
                }
            )
    return subscriptions


def main() -> int:
    if not DECRYPTED_DIR.exists():
        print("ERROR: decrypted database directory is unavailable")
        return 1
    data = load_binding_config(BINDING_FILE)
    bindings = load_bindings(BINDING_FILE)
    observer = DbObserver(DECRYPTED_DIR, bindings)
    event_ledger = EventLedger(LEDGER_PATH)
    baselines = observer.establish_baseline()

    for binding in bindings:
        identity = observer.get_route_identity(binding)
        try:
            event_ledger.get_route(binding.route_id)
        except LedgerError as error:
            if error.code != "ROUTE_NOT_FOUND":
                raise
            event_ledger.register_route(
                route_id=binding.route_id,
                profile="human_direct" if binding.chat_type == "friend" else "human_group",
                identity=identity,
                state="active",
                baseline_local_id=baselines.get(binding.route_id, 0),
                owner_account_key=binding.owner_account_key,
                username=binding.username,
                chat_type=binding.chat_type,
                display_title=binding.exact_title,
            )
        else:
            event_ledger.verify_or_upgrade_route_identity(
                binding.route_id,
                identity,
                binding.owner_account_key,
                binding.username,
                binding.chat_type,
                binding.exact_title,
            )
            event_ledger.update_baseline(binding.route_id, baselines.get(binding.route_id, 0))

    for subscription in _subscriptions(data):
        try:
            event_ledger.register_subscription(
                subscription["route_id"],
                subscription["conversation_id"],
                int(subscription.get("generation", 1)),
                subscription_id=subscription.get("subscription_id") or None,
                state=subscription.get("state", "active"),
                listen_capability=bool(subscription.get("listen_capability", True)),
                send_capability=bool(subscription.get("send_capability", False)),
                policy_ref=subscription.get("policy_ref"),
            )
        except LedgerError as error:
            if error.code != "SUBSCRIPTION_CONFLICT":
                raise

    print(
        json.dumps(
            {
                "schema_version": event_ledger.schema_info()["schema_version"],
                "route_count": len(bindings),
                "subscription_count": len(event_ledger.list_subscriptions()),
                "history_replayed": False,
            },
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
