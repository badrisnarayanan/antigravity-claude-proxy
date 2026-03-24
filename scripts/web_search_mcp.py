import sys
import json
import asyncio
import traceback
import os
import requests
from mcp.server import Server, NotificationOptions
from mcp.server.models import InitializationOptions
import mcp.server.stdio
import mcp.types as types


def get_proxy_config():
    """Read proxy URL and API key from Claude CLI settings."""
    config_path = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
    try:
        with open(config_path) as f:
            config = json.load(f)
            base_url = config.get("apiBaseUrl", "http://localhost:8080")
            api_key = config.get("apiKey", "test")
            return f"{base_url}/v1/messages", api_key
    except Exception:
        return "http://localhost:8080/v1/messages", "test"


PROXY_URL, API_KEY = get_proxy_config()

app = Server("antigravity-search")


@app.list_tools()
async def list_tools() -> list[types.Tool]:
    """List available tools."""
    return [
        types.Tool(
            name="search",
            description="Performs a web search via Gemini's Google Search grounding through the Antigravity Proxy.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query"
                    }
                },
                "required": ["query"]
            }
        )
    ]


def _call_proxy(query: str) -> str:
    """Send a search query through the Antigravity Proxy using Google Search grounding."""
    headers = {"x-api-key": API_KEY, "Content-Type": "application/json"}
    payload = {
        "model": "gemini-3-flash",
        "system": "You are a concise search assistant. Return ONLY factual results in 2-3 sentences with source URLs. No code, no filler.",
        "messages": [{"role": "user", "content": query}],
        "max_tokens": 512,
        "thinking": {"budget_tokens": 1},
        "tools": [{"name": "google_search", "input_schema": {"type": "object"}}]
    }

    response = requests.post(PROXY_URL, headers=headers, json=payload, timeout=60)

    if response.status_code != 200:
        return f"Error: Proxy returned status {response.status_code} - {response.text}"

    data = response.json()
    content_blocks = data.get("content", [])
    text_parts = [block.get("text", "") for block in content_blocks if block.get("type") == "text"]
    return "".join(text_parts) if text_parts else "No results found."


@app.call_tool()
async def call_tool(name: str, arguments: dict):
    """Handle tool calls."""
    if name != "search":
        raise ValueError(f"Unknown tool: {name}")

    query = arguments.get("query")
    if not query:
        raise ValueError("Missing required parameter 'query'")

    if len(query) > 500:
        raise ValueError("Query too long (max 500 characters)")

    try:
        result = await asyncio.to_thread(_call_proxy, query)
        return [types.TextContent(type="text", text=result)]
    except Exception as e:
        sys.stderr.write(f"Search error: {traceback.format_exc()}\n")
        sys.stderr.flush()
        return [types.TextContent(type="text", text=f"Search failed: {str(e)}")]


async def main():
    sys.stderr.write("Starting Antigravity Search MCP Server...\n")
    sys.stderr.flush()
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await app.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="antigravity-search",
                server_version="1.1.0",
                capabilities=app.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                )
            ),
        )


if __name__ == "__main__":
    asyncio.run(main())
