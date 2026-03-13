import sys
import json
import requests
import traceback
import os
from mcp.server import Server, NotificationOptions
from mcp.server.models import InitializationOptions
import mcp.server.stdio
import mcp.types as types

def get_proxy_config():
    config_path = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
    try:
        with open(config_path) as f:
            config = json.load(f)
            base_url = config.get("apiBaseUrl", "http://localhost:8080")
            api_key = config.get("apiKey", "test")
            return f"{base_url}/v1/messages", api_key
    except Exception:
        return "http://localhost:8080/v1/messages", "test"

# Configuration
PROXY_URL, API_KEY = get_proxy_config()

app = Server("antigravity-search")

@app.list_tools()
async def list_tools() -> list[types.Tool]:
    """List available tools."""
    return [
        types.Tool(
            name="search",
            description="Performs a Google Search using the Antigravity Proxy.",
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

@app.call_tool()
async def call_tool(
    name: str, arguments: dict
) -> list[types.TextContent | types.ImageContent | types.EmbeddedResource]:
    """Handle tool calls."""
    if name != "search":
        raise ValueError(f"Unknown tool: {name}")

    query = arguments.get("query")
    if not query:
        raise ValueError("Missing required parameter 'query'")

    headers = {
        "x-api-key": API_KEY,
        "Content-Type": "application/json"
    }

    payload = {
        "model": "gemini-3-flash",
        "system": "You are a fast, automated web search engine API. You MUST follow these rules strictly:\n1. Perform exactly ONE search query to find the answer.\n2. DO NOT perform multiple, chained, or refined searches.\n3. Return ONLY a direct, concise factual summary (under 3 sentences).\n4. Do not explain your process, do not offer to write code, and do not provide conversational filler.\n5. Include source URLs if possible.",
        "messages": [{"role": "user", "content": query}],
        "max_tokens": 256,
        "thinking": {"type": "disabled"}
    }

    try:
        response = requests.post(PROXY_URL, headers=headers, json=payload)
        if response.status_code != 200:
            return [types.TextContent(
                type="text",
                text=f"Error: Proxy returned status {response.status_code} - {response.text}"
            )]

        data = response.json()
        content_blocks = data.get("content", [])
        text_response = ""

        for block in content_blocks:
            if block.get("type") == "text":
                text_response += block.get("text", "")

        return [types.TextContent(
            type="text",
            text=text_response if text_response else "No results found."
        )]

    except Exception as e:
        return [types.TextContent(
            type="text",
            text=f"Request failed: {str(e)}\n{traceback.format_exc()}"
        )]

async def main():
    sys.stderr.write("Starting Antigravity Search MCP Server...\n")
    sys.stderr.flush()
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await app.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="antigravity-search",
                server_version="1.0.0",
                capabilities=app.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                )
            ),
        )

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
