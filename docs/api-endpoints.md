# API Endpoints

| Endpoint                  | Method | Description                                                           |
| ------------------------- | ------ | --------------------------------------------------------------------- |
| `/health`                 | GET    | Health check                                                          |
| `/account-limits`         | GET    | Account status, weekly & 5-hour quota limits (`?format=table` for ASCII table) |
| `/v1/messages`            | POST   | Anthropic Messages API                                                |
| `/v1/models`              | GET    | List available models (OpenAI-compatible)                             |
| `/v1/models/:model`       | GET    | Retrieve model details (OpenAI-compatible)                            |
| `/v1/chat/completions`    | POST   | OpenAI-compatible Chat Completions (streaming & non-streaming)        |
| `/v1/completions`         | POST   | OpenAI-compatible Completions (legacy prompt mapping)                 |
| `/refresh-token`          | POST   | Force token refresh                                                   |
