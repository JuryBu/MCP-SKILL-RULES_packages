"""Register authorised routes and establish message baselines.

This script reads route bindings from the private config file
(``config/binding.json`` under the data root) and registers them in the
event ledger.  No real account identifiers, conversation IDs, or other
sensitive data appear in this source file.

Run with:
    python -m wechat_docs_mcp.enroll_routes
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Set up paths for direct execution
SRC_DIR = Path(__file__).resolve().parent.parent / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from wechat_docs_mcp.db_observer import DbObserver, RouteBinding
from wechat_docs_mcp.ledger import EventLedger

DATA_ROOT = Path(
    os.environ.get(
        "WECHAT_DOCS_MCP_DATA_ROOT",
        Path.home() / ".codex-toolkit" / "wechat-docs-mcp",
    )
)
DECRYPTED_DIR = DATA_ROOT / "private-state" / "decrypted"
LEDGER_PATH = DATA_ROOT / "state" / "events.sqlite3"

BINDING_FILE = DATA_ROOT / "config" / "binding.json"


def load_bindings(path: Path) -> list[RouteBinding]:
    """Load route bindings from the private config file.

    Expected format (``binding.json``)::

        {
          "routes": [
            {
              "route_id": "wechat-example-friend",
              "exact_title": "<display name>",
              "chat_type": "friend",
              "username": "<wxid>",
              "conversation_id": "<conversation id>"
            }
          ]
        }
    """
    if not path.exists():
        raise FileNotFoundError(
            f"Binding file not found: {path}. "
            "Create it with route_id, exact_title, chat_type, username, "
            "and conversation_id for each authorised chat."
        )
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    routes = data.get("routes", [])
    if not routes:
        raise ValueError(f"No routes found in {path}")
    return [
        RouteBinding(
            route_id=r["route_id"],
            exact_title=r["exact_title"],
            chat_type=r["chat_type"],
            username=r["username"],
            conversation_id=r.get("conversation_id", ""),
        )
        for r in routes
    ]


def main() -> int:
    print(f"[*] Decrypted dir: {DECRYPTED_DIR}")
    print(f"[*] Ledger path: {LEDGER_PATH}")

    if not DECRYPTED_DIR.exists():
        print("[ERROR] Decrypted directory not found. Run key extraction first.")
        return 1

    bindings = load_bindings(BINDING_FILE)
    print(f"[*] Loaded {len(bindings)} route binding(s)")

    observer = DbObserver(DECRYPTED_DIR, bindings)
    ledger = EventLedger(LEDGER_PATH)

    # Step 1: Establish baselines (high-water mark per route)
    print("\n[1] Establishing message baselines...")
    baselines = observer.establish_baseline()
    for rid, max_id in baselines.items():
        print(f"    {rid}: max_local_id = {max_id}")

    # Step 2: Register routes in the ledger
    print("\n[2] Registering routes in event ledger...")
    for binding in bindings:
        identity = observer.get_route_identity(binding)
        baseline = baselines.get(binding.route_id, 0)
        try:
            route = ledger.register_route(
                route_id=binding.route_id,
                conversation_id=binding.conversation_id,
                generation=1,
                profile="human_direct_test" if binding.chat_type == "friend" else "human_group_test",
                identity=identity,
                state="active",
                baseline_local_id=baseline,
            )
            print(f"    OK: {binding.route_id} -> active (identity_sha256={route['identity_sha256'][:12]}...)")
        except Exception as e:
            if "UNIQUE constraint" in str(e):
                print(f"    SKIP: {binding.route_id} already registered")
            else:
                raise

    # Step 3: Verify no messages are yielded when baseline is applied
    print("\n[3] Verifying baseline prevents replay...")
    new_obs = list(observer.poll_new_messages(baselines))
    if not new_obs:
        print("    OK: 0 new messages with baseline applied (no replay)")
    else:
        print(f"    WARN: {len(new_obs)} messages above baseline:")
        for o in new_obs:
            print(f"      {o.route_id} local_id={o.payload['local_id']}")

    print("\nDone. Routes are active and baselines are stored in the ledger.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
