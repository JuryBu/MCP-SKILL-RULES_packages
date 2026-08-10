from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sqlite3
from pathlib import Path
from typing import Any


ACTIVE_WAKE_STATES = ("prepared", "submitted", "unknown")


def connect_read_only(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def ledger_state(path: Path, route_id: str) -> dict[str, int]:
    connection = connect_read_only(path)
    try:
        tables = {
            row["name"]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        if {"subscriptions", "event_deliveries", "subscription_wakes"}.issubset(tables):
            schema_version = 2
            if "schema_meta" in tables:
                row = connection.execute(
                    "SELECT value FROM schema_meta WHERE key='schema_version'"
                ).fetchone()
                if row is not None:
                    schema_version = int(row["value"])
            return {
                "schema_version": schema_version,
                "routes": connection.execute("SELECT COUNT(*) FROM routes").fetchone()[0],
                "events_total": connection.execute("SELECT COUNT(*) FROM events").fetchone()[0],
                "subscriptions_total": connection.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0],
                "pending_total": connection.execute(
                    "SELECT COUNT(*) FROM event_deliveries WHERE state='PENDING'"
                ).fetchone()[0],
                "pending_subscriptions_total": connection.execute(
                    "SELECT COUNT(DISTINCT subscription_id) FROM event_deliveries WHERE state='PENDING'"
                ).fetchone()[0],
                "wakes_total": connection.execute("SELECT COUNT(*) FROM subscription_wakes").fetchone()[0],
                "active_wakes_total": connection.execute(
                    "SELECT COUNT(*) FROM subscription_wakes WHERE state IN (?,?,?)",
                    ACTIVE_WAKE_STATES,
                ).fetchone()[0],
                "expected_legacy_subscriptions": connection.execute(
                    "SELECT COUNT(*) FROM routes WHERE TRIM(conversation_id)<>''"
                ).fetchone()[0],
                "events": connection.execute(
                    "SELECT COUNT(*) FROM events WHERE route_id=?", (route_id,)
                ).fetchone()[0],
                "subscriptions": connection.execute(
                    "SELECT COUNT(*) FROM subscriptions WHERE route_id=?", (route_id,)
                ).fetchone()[0],
                "pending": connection.execute(
                    """
                    SELECT COUNT(*) FROM event_deliveries
                    JOIN subscriptions USING(subscription_id)
                    WHERE subscriptions.route_id=? AND event_deliveries.state='PENDING'
                    """,
                    (route_id,),
                ).fetchone()[0],
                "pending_subscriptions": connection.execute(
                    """
                    SELECT COUNT(DISTINCT event_deliveries.subscription_id) FROM event_deliveries
                    JOIN subscriptions USING(subscription_id)
                    WHERE subscriptions.route_id=? AND event_deliveries.state='PENDING'
                    """,
                    (route_id,),
                ).fetchone()[0],
                "wakes": connection.execute(
                    """
                    SELECT COUNT(*) FROM subscription_wakes
                    JOIN subscriptions USING(subscription_id)
                    WHERE subscriptions.route_id=?
                    """,
                    (route_id,),
                ).fetchone()[0],
                "active_wakes": connection.execute(
                    """
                    SELECT COUNT(*) FROM subscription_wakes
                    JOIN subscriptions USING(subscription_id)
                    WHERE subscriptions.route_id=? AND subscription_wakes.state IN (?,?,?)
                    """,
                    (route_id, *ACTIVE_WAKE_STATES),
                ).fetchone()[0],
            }
        route_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(routes)").fetchall()
        } if "routes" in tables else set()
        expected_legacy_subscriptions = (
            connection.execute(
                "SELECT COUNT(*) FROM routes WHERE TRIM(conversation_id)<>''"
            ).fetchone()[0]
            if "conversation_id" in route_columns
            else 0
        )
        route_subscription_expected = (
            connection.execute(
                "SELECT COUNT(*) FROM routes WHERE route_id=? AND TRIM(conversation_id)<>''",
                (route_id,),
            ).fetchone()[0]
            if "conversation_id" in route_columns
            else 0
        )
        pending_subscriptions_total = (
            connection.execute(
                """
                SELECT COUNT(DISTINCT events.route_id) FROM events
                JOIN routes USING(route_id)
                WHERE events.acked_at IS NULL AND TRIM(routes.conversation_id)<>''
                """
            ).fetchone()[0]
            if "conversation_id" in route_columns
            else 0
        )
        return {
            "schema_version": 1,
            "routes": connection.execute("SELECT COUNT(*) FROM routes").fetchone()[0]
            if "routes" in tables else 0,
            "events_total": connection.execute("SELECT COUNT(*) FROM events").fetchone()[0],
            "subscriptions_total": 0,
            "pending_total": connection.execute(
                "SELECT COUNT(*) FROM events WHERE acked_at IS NULL"
            ).fetchone()[0],
            "pending_subscriptions_total": pending_subscriptions_total,
            "wakes_total": connection.execute("SELECT COUNT(*) FROM wakes").fetchone()[0],
            "active_wakes_total": connection.execute(
                "SELECT COUNT(*) FROM wakes WHERE state IN (?,?,?)", ACTIVE_WAKE_STATES
            ).fetchone()[0],
            "expected_legacy_subscriptions": expected_legacy_subscriptions,
            "events": connection.execute(
                "SELECT COUNT(*) FROM events WHERE route_id=?", (route_id,)
            ).fetchone()[0],
            "subscriptions": 0,
            "route_subscription_expected": route_subscription_expected,
            "pending": connection.execute(
                "SELECT COUNT(*) FROM events WHERE route_id=? AND acked_at IS NULL",
                (route_id,),
            ).fetchone()[0],
            "pending_subscriptions": 1
            if route_subscription_expected
            and connection.execute(
                "SELECT 1 FROM events WHERE route_id=? AND acked_at IS NULL LIMIT 1",
                (route_id,),
            ).fetchone()
            else 0,
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


def backup_ledger(source: Path, destination: Path) -> dict[str, object]:
    if destination.exists():
        raise FileExistsError(f"ledger backup already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_connection = connect_read_only(source)
    target_connection = sqlite3.connect(destination)
    try:
        source_connection.backup(target_connection)
        integrity = target_connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise sqlite3.DatabaseError(f"ledger backup integrity failed: {integrity}")
    finally:
        target_connection.close()
        source_connection.close()
    return {"backup": str(destination.resolve()), "integrity": "ok", "bytes": destination.stat().st_size}


def restore_ledger(source: Path, destination: Path) -> dict[str, object]:
    if not source.is_file():
        raise FileNotFoundError(f"ledger backup does not exist: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_connection = connect_read_only(source)
    target_connection = sqlite3.connect(destination)
    try:
        source_connection.backup(target_connection)
        integrity = target_connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise sqlite3.DatabaseError(f"restored ledger integrity failed: {integrity}")
    finally:
        target_connection.close()
        source_connection.close()
    return {
        "source": str(source.resolve()),
        "destination": str(destination.resolve()),
        "integrity": "ok",
        "bytes": destination.stat().st_size,
    }


async def call_mcp_tool(url: str, name: str, arguments: dict[str, Any], timeout: float) -> dict[str, Any]:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client

    async with streamable_http_client(url) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            result = await session.call_tool(name, arguments, read_timeout_seconds=timeout)
    payload = result.model_dump(mode="json")
    return {
        "tool": name,
        "is_error": bool(payload.get("is_error", False)),
        "structured_content": payload.get("structured_content"),
        "result_type": payload.get("result_type"),
    }


def parse_arguments(argument_json: str, argument_base64: str) -> dict[str, Any]:
    raw = argument_json
    if argument_base64:
        raw = base64.b64decode(argument_base64, validate=True).decode("utf-8")
    arguments = json.loads(raw)
    if not isinstance(arguments, dict):
        raise TypeError("MCP tool arguments must be a JSON object")
    return arguments


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

    backup_parser = subparsers.add_parser("backup-ledger")
    backup_parser.add_argument("--source", type=Path, required=True)
    backup_parser.add_argument("--destination", type=Path, required=True)

    restore_parser = subparsers.add_parser("restore-ledger")
    restore_parser.add_argument("--source", type=Path, required=True)
    restore_parser.add_argument("--destination", type=Path, required=True)

    call_parser = subparsers.add_parser("mcp-call")
    call_parser.add_argument("--url", required=True)
    call_parser.add_argument("--name", required=True)
    call_parser.add_argument("--arguments-json", default="{}")
    call_parser.add_argument("--arguments-base64", default="")
    call_parser.add_argument("--timeout", type=float, default=30.0)

    args = parser.parse_args()
    if args.action == "ledger-state":
        result = ledger_state(args.ledger, args.route_id)
    elif args.action == "create-fixture":
        result = create_fixture(args.ledger, args.route_id)
    elif args.action == "package-info":
        result = package_info(args.expected_root)
    elif args.action == "backup-ledger":
        result = backup_ledger(args.source, args.destination)
    elif args.action == "restore-ledger":
        result = restore_ledger(args.source, args.destination)
    else:
        arguments = parse_arguments(args.arguments_json, args.arguments_base64)
        result = asyncio.run(call_mcp_tool(args.url, args.name, arguments, args.timeout))
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
