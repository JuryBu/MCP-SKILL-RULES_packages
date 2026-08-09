"""One-time migration: add baseline_local_id to existing events.sqlite3 and backfill.

This script:
1. Opens the real event ledger (triggers ALTER TABLE migration automatically).
2. Reads the decrypted message database to get current max local_id per route.
3. Updates each route's baseline to prevent old-history replay.

Run with:
    python -m wechat_docs_mcp.migrate_baselines
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

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


def main() -> int:
    print(f"[*] Ledger: {LEDGER_PATH}")
    print(f"[*] Decrypted: {DECRYPTED_DIR}")

    # Step 0: Create timestamped backup before migration using SQLite backup()
    if LEDGER_PATH.exists():
        import sqlite3
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup_path = LEDGER_PATH.with_suffix(f".sqlite3.bak.{ts}")
        src_conn = sqlite3.connect(str(LEDGER_PATH))
        try:
            dst_conn = sqlite3.connect(str(backup_path))
            try:
                src_conn.backup(dst_conn)
            finally:
                dst_conn.close()
        finally:
            src_conn.close()
        print(f"[*] Backup created: {backup_path}")
    else:
        print("[*] Ledger does not exist yet, no backup needed")

    failures = 0

    # Step 1: Open ledger (triggers ALTER TABLE migration)
    print("\n[1] Opening ledger (triggers schema migration)...")
    try:
        ledger = EventLedger(LEDGER_PATH)
    except Exception as e:
        print(f"    FATAL: cannot open ledger: {e}")
        return 1
    cols = ledger._connect().execute("PRAGMA table_info(routes)").fetchall()
    col_names = [c[1] for c in cols]
    has_baseline = "baseline_local_id" in col_names
    print(f"    Columns: {col_names}")
    print(f"    baseline_local_id present: {has_baseline}")
    if not has_baseline:
        print("    ERROR: migration did not add column")
        return 1

    # Step 2: Load bindings from private config
    try:
        with open(BINDING_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"    FATAL: cannot load binding.json: {e}")
        return 1
    routes = data.get("routes", [])
    bindings = [
        RouteBinding(
            route_id=r["route_id"],
            exact_title=r["exact_title"],
            chat_type=r["chat_type"],
            username=r["username"],
        )
        for r in routes
    ]

    # Step 3: Establish baselines from decrypted DB
    print("\n[2] Establishing baselines from decrypted database...")
    observer = DbObserver(DECRYPTED_DIR, bindings)
    baselines = observer.establish_baseline()
    for rid, max_id in baselines.items():
        print(f"    {rid}: max_local_id = {max_id}")

    # Step 4: Backfill baselines into the ledger
    print("\n[3] Backfilling baselines into ledger...")
    for binding in bindings:
        rid = binding.route_id
        target = baselines.get(rid, 0)
        try:
            route = ledger.get_route(rid)
            current = route["baseline_local_id"]
            if current < target:
                # Use direct SQL to bypass regression check (migration is special)
                conn = ledger._connect()
                try:
                    conn.execute(
                        "UPDATE routes SET baseline_local_id=?, updated_at=? WHERE route_id=?",
                        (target, ledger.__class__ and __import__("wechat_docs_mcp.ledger", fromlist=["utc_now"]).utc_now(), rid),
                    )
                finally:
                    conn.close()
                print(f"    {rid}: {current} -> {target} (backfilled)")
            else:
                print(f"    {rid}: already at {current}, skip")
        except Exception as e:
            print(f"    {rid}: ERROR - {e}")
            failures += 1

    # Step 5: Verify
    print("\n[4] Verification...")
    for binding in bindings:
        rid = binding.route_id
        try:
            bl = ledger.get_baseline(rid)
            print(f"    {rid}: baseline_local_id = {bl}")
        except Exception as e:
            print(f"    {rid}: VERIFICATION FAILED - {e}")
            failures += 1

    if failures:
        print(f"\nMigration completed with {failures} failure(s).")
        return 1
    print("\nMigration complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
