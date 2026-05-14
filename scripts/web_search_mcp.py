import sys
import json
import asyncio
import traceback

import os

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


def handle_request(request):
    method = request.get("method")
    params = request.get("params", {})
    req_id = request.get("id")

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "Antigravity Search",
                    "version": "1.0.0"
                }
            }
        }

    if method == "notifications/initialized":
        return None  # No response needed

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": [{
                    "name": "search",
                    "description": "Performs a Google Search using the Antigravity Proxy.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "The search query"
                            }
                        },
                        "required": ["query"]
                    }
                }]
            }
        }

    if method == "tools/call":
        tool_name = params.get("name")
        args = params.get("arguments", {})

        if tool_name == "search":
            query = args.get("query")
            if not query:
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [{
                            "type": "text",
                            "text": "Error: Missing required parameter 'query'"
                        }]
                    }
                }
            result = search(query)
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{
                        "type": "text",
                        "text": result
                    }]
                }
            }

        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {
                "code": -32601,
                "message": f"Tool not found: {tool_name}"
            }
        }

    return None


def read_message():
    """Read a JSON-RPC message using Content-Length header framing."""
    headers = {}
    while True:
        line = sys.stdin.readline()
        if not line:
            return None  # EOF
        line = line.strip()
        if line == "":
            break  # End of headers
        if ":" in line:
            key, value = line.split(":", 1)
            headers[key.strip()] = value.strip()

    content_length = int(headers.get("Content-Length", 0))
    if content_length == 0:
        return None

    body = sys.stdin.read(content_length)
    return json.loads(body)


def write_message(response):
    """Write a JSON-RPC message using Content-Length header framing."""
    body = json.dumps(response)
    body_bytes = body.encode('utf-8')
    header = f"Content-Length: {len(body_bytes)}\r\n\r\n"
    sys.stdout.buffer.write(header.encode('utf-8'))
    sys.stdout.buffer.write(body_bytes)
    sys.stdout.buffer.flush()


def main():
    # Write to stderr for logging since stdout is for JSON-RPC
    sys.stderr.write("Starting MCP Server (Content-Length framing)...\n")

    while True:
        try:
            request = read_message()
            if request is None:
                break

            response = handle_request(request)

            if response:
                write_message(response)

        except json.JSONDecodeError as e:
            sys.stderr.write(f"Failed to decode JSON: {e}\n")
        except Exception:
            sys.stderr.write(traceback.format_exc())


if __name__ == "__main__":
    asyncio.run(main())
