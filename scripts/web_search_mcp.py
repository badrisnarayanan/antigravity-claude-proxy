import sys
import asyncio
import traceback
from ddgs import DDGS
from mcp.server import Server, NotificationOptions
from mcp.server.models import InitializationOptions
import mcp.server.stdio
import mcp.types as types

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

    try:
        results = DDGS().text(query, max_results=5)

        if not results:
            return [types.TextContent(type="text", text="No results found.")]

        lines = []
        for i, r in enumerate(results, 1):
            lines.append(f"{i}. [{r['title']}]({r['href']})")
            if r.get("body"):
                lines.append(f"   {r['body']}")
            lines.append("")

        return [types.TextContent(type="text", text="\n".join(lines))]

    except Exception as e:
        sys.stderr.write(f"Search error: {traceback.format_exc()}\n")
        sys.stderr.flush()
        return [types.TextContent(
            type="text",
            text=f"Search failed: {str(e)}"
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
                server_version="2.0.0",
                capabilities=app.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                )
            ),
        )

if __name__ == "__main__":
    asyncio.run(main())
