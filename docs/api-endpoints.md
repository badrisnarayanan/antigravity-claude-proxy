# API Endpoints

| Endpoint          | Method | Description                                                           |
| ----------------- | ------ | --------------------------------------------------------------------- |
| `/health`         | GET    | Health check                                                          |
| `/account-limits` | GET    | Account status and quota limits (add `?format=table` for ASCII table) |
| `/v1/messages`    | POST   | Anthropic Messages API                                                |
| `/v1/chat/completions` | POST | OpenAI Chat Completions API (compatibility)                      |
| `/v1/models`      | GET    | List available models                                                 |
| `/refresh-token`  | POST   | Force token refresh                                                   |
