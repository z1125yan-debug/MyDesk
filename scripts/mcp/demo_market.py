#!/usr/bin/env python3
"""demo_market.py —— MyDesk 附带的 MCP 演示服务器（stdio 传输）。

实现 MCP JSON-RPC 握手（initialize → initialized → tools/list → tools/call），
提供两个演示工具，便于在 MyDesk 设置页里体验 MCP 的启动、发现与调用流程。
仅依赖 Python 标准库。作为真实服务器时，把工具实现替换为你自己的逻辑即可。
"""

import json
import random
import sys

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "demo-market", "version": "1.0.0"}

TOOLS = [
    {
        "name": "get_quote",
        "description": "返回某个演示品种的模拟报价（演示数据）",
        "inputSchema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string", "description": "品种代码，如 XAU/USD、BTC/USDT"},
            },
            "required": ["symbol"],
        },
    },
    {
        "name": "list_hot_sectors",
        "description": "返回演示的热门板块列表（演示数据）",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def get_quote(args):
    symbol = str(args.get("symbol", "XAU/USD"))
    random.seed(hash(symbol) & 0xFFFF)
    price = round(random.uniform(10, 3000), 2)
    change = round(random.uniform(-4, 4), 2)
    payload = {"symbol": symbol, "price": price, "change_pct": change, "note": "演示数据"}
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]}


def list_hot_sectors(_args):
    sectors = [
        {"name": "半导体", "change_pct": 3.2},
        {"name": "人工智能", "change_pct": 3.6},
        {"name": "电力设备", "change_pct": 2.6},
        {"name": "贵金属", "change_pct": 2.8},
        {"name": "算力租赁", "change_pct": 3.1},
    ]
    payload = {"sectors": sectors, "note": "演示数据"}
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]}


HANDLERS = {"get_quote": get_quote, "list_hot_sectors": list_hot_sectors}


def reply(req_id, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method", "")
        req_id = msg.get("id")
        params = msg.get("params", {}) or {}

        if method == "initialize":
            reply(req_id, {
                "protocolVersion": params.get("protocolVersion", PROTOCOL_VERSION),
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            })
        elif method == "notifications/initialized":
            pass  # 通知无需回复
        elif method == "tools/list":
            reply(req_id, {"tools": TOOLS})
        elif method == "tools/call":
            name = params.get("name", "")
            args = params.get("arguments", {}) or {}
            handler = HANDLERS.get(name)
            if handler is None:
                reply(req_id, {"isError": True, "content": [{"type": "text", "text": f"未知工具: {name}"}]})
            else:
                reply(req_id, handler(args))
        elif method == "ping":
            reply(req_id, {})
        elif req_id is not None:
            reply(req_id, {"isError": True, "content": [{"type": "text", "text": f"不支持的方法: {method}"}]})


if __name__ == "__main__":
    main()
