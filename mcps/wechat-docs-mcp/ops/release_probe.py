from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path


ACTIVE_WAKE_STATES = ("prepared", "submitted", "unknown")


def connect_read_only(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def ledger_state(path: Path, route_id: str) -> dict[str, int]:
    connection = connect_read_only(path)
    try:
        return {
            "events": connection.execute(
                "SELECT COUNT(*) FROM events WHERE route_id=?", (route_id,)
            ).fetchone()[0],
            "pending": connection.execute(
                "SELECT COUNT(*) FROM events WHERE route_id=? AND acked_at IS NULL",
                (route_id,),
            ).fetchone()[0],
            "wakes": connection.execute(
                "SELECT COUNT(*) FROM wakes WHERE route_id=?", (route_id,)
            ).fetchone()[0],
            "active_wakes": connection.execute(
                "SELECT COUNT(*) FROM wakes WHERE route_id=? AND state IN (?,?,?)",
                (route_id, *ACTIVE_WAKE_STATES),
            ).fetchone()[0],
        }
    finally:
        connection.close()


def create_fixture(path: Path, route_id: str) -> dict[str, int]:
    if path.exists():
        raise FileExistsError(f"fixture ledger already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    try:
        connection.executescript(
            """
            CREATE TABLE events(
              event_id TEXT PRIMARY KEY,
              route_id TEXT NOT NULL,
              acked_at TEXT
            );
            CREATE TABLE wakes(
              wake_id TEXT PRIMARY KEY,
              route_id TEXT NOT NULL,
              state TEXT NOT NULL
            );
            """
        )
        connection.execute(
            "INSERT INTO events VALUES(?,?,?)",
            ("event-fixture", route_id, "2026-08-09T00:00:00+00:00"),
        )
        connection.execute(
            "INSERT INTO wakes VALUES(?,?,?)",
            ("wake-fixture", route_id, "closed"),
        )
        connection.commit()
    finally:
        connection.close()
    return ledger_state(path, route_id)


def package_info(expected_root: Path) -> dict[str, object]:
    import wechat_docs_mcp
    from wechat_docs_mcp.server import mcp

    module_path = Path(wechat_docs_mcp.__file__).resolve()
    release_root = expected_root.resolve()
    inside_release = os.path.commonpath((module_path, release_root)) == str(release_root)
    return {
        "inside_release": inside_release,
        "module_path": str(module_path),
        "tool_count": len(mcp._tool_manager._tools),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="action", required=True)

    state_parser = subparsers.add_parser("ledger-state")
    state_parser.add_argument("--ledger", type=Path, required=True)
    state_parser.add_argument("--route-id", required=True)

    fixture_parser = subparsers.add_parser("create-fixture")
    fixture_parser.add_argument("--ledger", type=Path, required=True)
    fixture_parser.add_argument("--route-id", required=True)

    package_parser = subparsers.add_parser("package-info")
    package_parser.add_argument("--expected-root", type=Path, required=True)

    args = parser.parse_args()
    if args.action == "ledger-state":
        result = ledger_state(args.ledger, args.route_id)
    elif args.action == "create-fixture":
        result = create_fixture(args.ledger, args.route_id)
    else:
        result = package_info(args.expected_root)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
