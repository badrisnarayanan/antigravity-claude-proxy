import sys
import json
import requests
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


def search(query: str) -> str:
    """
    Performs a Google Search using the Antigravity Proxy.
    """
    headers = {
        "x-api-key": API_KEY,
        "Content-Type": "application/json"
    }

    payload = {
        "model": "web-search",
        "messages": [{"role": "user", "content": query}],
        "max_tokens": 1024
    }

    try:
        response = requests.post(PROXY_URL, headers=headers, json=payload)
        if response.status_code != 200:
            return f"Error: Proxy returned status {response.status_code} - {response.text}"

        data = response.json()
        content_blocks = data.get("content", [])
        text_response = ""

        for block in content_blocks:
            if block.get("type") == "text":
                text_response += block.get("text", "")

        return text_response if text_response else "No results found."

    except Exception as e:
        return f"Request failed: {str(e)}"


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
    main()
