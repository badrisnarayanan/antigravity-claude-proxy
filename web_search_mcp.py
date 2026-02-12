import sys
import json
import requests
import traceback

# Configuration
PROXY_URL = "http://localhost:8080/v1/messages"
API_KEY = "test"  # Default API key for local proxy

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

def main():
    # Write to stderr for logging since stdout is for JSON-RPC
    sys.stderr.write("Starting Minimal MCP Server...\n")

    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break

            request = json.loads(line)
            response = handle_request(request)

            if response:
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()

        except json.JSONDecodeError:
            sys.stderr.write(f"Failed to decode JSON: {line}\n")
        except Exception:
            sys.stderr.write(traceback.format_exc())

if __name__ == "__main__":
    main()
