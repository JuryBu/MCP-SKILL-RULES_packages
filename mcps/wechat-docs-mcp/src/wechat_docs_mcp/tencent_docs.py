from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx


READ_ONLY_PREFIXES = ("query_", "search_", "get_", "list_", "read_", "describe_")


class TencentDocsMcpClient:
    def __init__(self, token_path: str | Path, endpoint: str = "https://docs.qq.com/openapi/mcp") -> None:
        self.token_path = Path(token_path)
        self.endpoint = endpoint

    def _token(self) -> str:
        token = self.token_path.read_text(encoding="utf-8").strip()
        if not token:
            raise RuntimeError("TENCENT_DOCS_TOKEN_EMPTY")
        return token

    async def request(self, method: str, params: dict[str, Any] | None = None, request_id: int = 1) -> dict[str, Any]:
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                self.endpoint,
                headers={"Authorization": self._token(), "Content-Type": "application/json"},
                content=json.dumps(payload, ensure_ascii=False),
            )
            response.raise_for_status()
            return response.json()

    async def list_tools(self) -> dict[str, Any]:
        return await self.request("tools/list")

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return await self.request("tools/call", {"name": name, "arguments": arguments})

    async def tool_catalog(self) -> list[dict[str, Any]]:
        response = await self.list_tools()
        tools = response.get("result", {}).get("tools", [])
        return tools if isinstance(tools, list) else []

    async def search_tools(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        terms = [term.casefold() for term in query.split() if term.strip()]
        matches = []
        for tool in await self.tool_catalog():
            haystack = f"{tool.get('name', '')} {tool.get('description', '')}".casefold()
            if all(term in haystack for term in terms):
                matches.append(
                    {
                        "name": tool.get("name"),
                        "description": tool.get("description"),
                        "inputSchema": tool.get("inputSchema", {}),
                        "access": classify_tool(tool),
                    }
                )
            if len(matches) >= limit:
                break
        return matches

    @staticmethod
    def audit_summary(method: str, tool_name: str | None = None) -> dict[str, Any]:
        return {"method": method, "tool_name": tool_name, "authorization": "[REDACTED]"}


def classify_tool(tool: dict[str, Any]) -> str:
    annotations = tool.get("annotations") or {}
    if annotations.get("readOnlyHint") is True:
        return "read_only"
    name = str(tool.get("name", "")).casefold()
    if name.startswith(READ_ONLY_PREFIXES):
        return "read_only"
    return "approval_required"
