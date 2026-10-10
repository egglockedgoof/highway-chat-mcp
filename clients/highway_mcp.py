# Hollow's Highway MCP client. Bound Bearer only — never the path secret.
# Token lives in MCP_CALLER_TOKEN (client host). Render maps it via MCP_CALLERS.

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

BASE_DEFAULT = "https://highway-chat-mcp.onrender.com"


class ClientError(RuntimeError):
    pass


def request_spec(token: str, base: str = BASE_DEFAULT) -> dict[str, str]:
    t = (token or "").strip()
    if len(t) < 16:
        raise ClientError("MCP_CALLER_TOKEN missing or weak; refuse path-legacy")
    root = (base or BASE_DEFAULT).rstrip("/")
    return {
        "url": f"{root}/mcp",
        "authorization": f"Bearer {t}",
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
    }


def _token() -> str:
    return os.environ.get("MCP_CALLER_TOKEN", "")


def _base() -> str:
    return os.environ.get("HIGHWAY_MCP_URL", BASE_DEFAULT)


def call(method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    spec = request_spec(_token(), _base())
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).encode()
    headers = {k: v for k, v in spec.items() if k != "url"}
    req = urllib.request.Request(spec["url"], data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            raw = res.read().decode()
    except urllib.error.HTTPError as e:
        text = e.read().decode() if e.fp else ""
        raise ClientError(f"MCP HTTP {e.code}: {text[:300]}") from e
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ClientError(f"MCP non-JSON: {raw[:300]}") from e
    if parsed.get("error"):
        err = parsed["error"]
        raise ClientError(f"JSON-RPC {err.get('code')}: {err.get('message')}")
    return parsed


def tools_call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return call("tools/call", {"name": name, "arguments": arguments})
