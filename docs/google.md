# Google OAuth 授权机制文档

本文档详细说明 Antigravity Claude Proxy 项目中如何获取、保存和使用 Google OAuth 授权信息。

## 目录

- [授权流程](#授权流程)
- [保存的授权信息](#保存的授权信息)
- [使用授权信息调用 API](#使用授权信息调用-api)
- [相关代码文件](#相关代码文件)

---

## 授权流程

### 1. OAuth 2.0 with PKCE

项目使用 **OAuth 2.0 授权码流程**，配合 **PKCE (Proof Key for Code Exchange)** 增强安全性。

#### 1.1 生成授权 URL

**代码位置**: `src/auth/oauth.js` - `getAuthorizationUrl()`

```javascript
// 生成 PKCE 参数
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('hex');

// 构建授权 URL
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
```

**请求参数**:
- `client_id`: OAuth 客户端 ID
- `redirect_uri`: 回调地址（默认 `http://localhost:51121/oauth-callback`）
- `response_type`: `code`
- `scope`: 请求的权限范围
- `access_type`: `offline`（获取 refresh token）
- `prompt`: `consent`（强制显示同意页面）
- `code_challenge`: PKCE challenge（SHA256 哈希）
- `code_challenge_method`: `S256`
- `state`: CSRF 防护随机字符串

**请求的权限范围** (`scopes`):
```javascript
[
  'https://www.googleapis.com/auth/cloud-platform',      // Google Cloud Platform 访问
  'https://www.googleapis.com/auth/userinfo.email',      // 用户邮箱
  'https://www.googleapis.com/auth/userinfo.profile',   // 用户资料
  'https://www.googleapis.com/auth/cclog',              // Cloud Code 日志
  'https://www.googleapis.com/auth/experimentsandconfigs' // 实验配置
]
```

#### 1.2 接收授权码

**自动回调模式**（本地环境）:
- 启动本地 HTTP 服务器监听 `localhost:51121`
- 用户授权后，Google 重定向到回调地址
- 服务器自动捕获授权码

**代码位置**: `src/auth/oauth.js` - `startCallbackServer()`

**手动模式**（远程服务器）:
- 用户复制授权 URL 到本地浏览器
- 授权后复制回调 URL 或授权码
- 手动粘贴到服务器

**代码位置**: `src/auth/oauth.js` - `extractCodeFromInput()`

#### 1.3 交换 Token

**代码位置**: `src/auth/oauth.js` - `exchangeCode()`

使用授权码和 PKCE verifier 交换访问令牌：

```javascript
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

{
  client_id: '...',
  client_secret: '...',
  code: '授权码',
  code_verifier: 'PKCE verifier',
  grant_type: 'authorization_code',
  redirect_uri: 'http://localhost:51121/oauth-callback'  // 必须与授权请求完全匹配
}
```

**返回**:
- `access_token`: 短期访问令牌（通常 1 小时有效）
- `refresh_token`: 长期刷新令牌（永久有效，除非撤销）
- `expires_in`: 访问令牌过期时间（秒）

#### 1.4 获取用户信息

**代码位置**: `src/auth/oauth.js` - `getUserEmail()`

```javascript
GET https://www.googleapis.com/oauth2/v1/userinfo
Authorization: Bearer {access_token}
```

**返回**: 用户邮箱地址

#### 1.5 发现项目 ID

**代码位置**: `src/auth/oauth.js` - `discoverProjectId()`

调用 Cloud Code API 的 `loadCodeAssist` 端点：

```javascript
POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
Authorization: Bearer {access_token}
Content-Type: application/json

{
  metadata: {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI'
  }
}
```

**返回**: 
- `cloudaicompanionProject`: 项目 ID（字符串或对象）
- `allowedTiers`: 允许的订阅层级
- `paidTier`: 付费订阅信息
- `currentTier`: 当前订阅层级

如果未找到项目，会尝试 **onboarding**（异步后台执行，不阻塞授权流程）。

---

## 保存的授权信息

### 存储位置

账户信息保存在配置文件：`~/.config/antigravity-proxy/accounts.json`

**代码位置**: `src/account-manager/storage.js`

### 账户数据结构

```json
{
  "accounts": [
    {
      "email": "user@example.com",
      "source": "oauth",
      "enabled": true,
      "refreshToken": "refreshToken|projectId|managedProjectId",
      "projectId": "project-id",
      "addedAt": "2026-02-06T06:00:00.000Z",
      "isInvalid": false,
      "invalidReason": null,
      "modelRateLimits": {},
      "lastUsed": null,
      "subscription": {
        "tier": "free",
        "projectId": "project-id",
        "detectedAt": "2026-02-06T06:00:00.000Z"
      },
      "quota": {
        "models": {},
        "lastChecked": null
      },
      "quotaThreshold": 0.1,
      "modelQuotaThresholds": {}
    }
  ],
  "settings": {},
  "activeIndex": 0
}
```

### 关键字段说明

#### `refreshToken`（复合格式）

**格式**: `refreshToken|projectId|managedProjectId`

**代码位置**: `src/auth/oauth.js` - `parseRefreshParts()`, `formatRefreshParts()`

- **refreshToken**: 实际的 OAuth refresh token（用于刷新 access token）
- **projectId**: GCP 项目 ID（可选，用于 `metadata.duetProject`）
- **managedProjectId**: Cloud Code 管理的项目 ID（可选，用于 API 调用）

**示例**:
```
1//0xxx...|my-gcp-project|managed-project-123
```

#### `source`

账户来源类型：
- `oauth`: OAuth 授权账户
- `manual`: 手动输入的 API Key
- `database`: 从 Antigravity 应用数据库提取

#### `subscription`

订阅信息：
- `tier`: `'free'` | `'pro'` | `'ultra'` | `'unknown'`
- `projectId`: 关联的项目 ID
- `detectedAt`: 检测时间（ISO 8601）

**代码位置**: `src/account-manager/credentials.js` - `extractSubscriptionFromResponse()`

#### `quota`

配额信息（按模型）：
```json
{
  "models": {
    "claude-sonnet-4-5-thinking": {
      "remainingFraction": 0.95,
      "resetTime": "2026-02-07T00:00:00.000Z"
    }
  },
  "lastChecked": "2026-02-06T06:00:00.000Z"
}
```

---

## 使用授权信息调用 API

### 1. 获取访问令牌

**代码位置**: `src/account-manager/credentials.js` - `getTokenForAccount()`

#### 1.1 Token 缓存

首先检查内存缓存（5 分钟有效期）：

```javascript
const cached = tokenCache.get(account.email);
if (cached && (Date.now() - cached.extractedAt) < TOKEN_REFRESH_INTERVAL_MS) {
  return cached.token;  // 使用缓存的 token
}
```

#### 1.2 刷新 Token

对于 OAuth 账户，使用 refresh token 获取新的 access token：

**代码位置**: `src/auth/oauth.js` - `refreshAccessToken()`

```javascript
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

{
  client_id: '...',
  client_secret: '...',
  refresh_token: 'refreshToken',  // 从复合格式中提取
  grant_type: 'refresh_token'
}
```

**返回**:
- `access_token`: 新的访问令牌
- `expires_in`: 过期时间

#### 1.3 错误处理

- **网络错误**: 不标记账户为无效，直接抛出异常
- **认证错误**: 标记账户为无效（`isInvalid: true`），需要重新授权

### 2. 获取项目 ID

**代码位置**: `src/account-manager/credentials.js` - `getProjectForAccount()`

#### 2.1 项目缓存

首先检查内存缓存：

```javascript
const cached = projectCache.get(account.email);
if (cached) {
  return cached;  // 使用缓存的项目 ID
}
```

#### 2.2 从 Refresh Token 解析

如果 refresh token 包含 `managedProjectId`，直接使用：

```javascript
const parts = parseRefreshParts(account.refreshToken);
if (parts.managedProjectId) {
  return parts.managedProjectId;
}
```

#### 2.3 发现项目

如果缓存和 refresh token 都没有，调用 `discoverProject()`：

**代码位置**: `src/account-manager/credentials.js` - `discoverProject()`

```javascript
POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
Authorization: Bearer {access_token}
Content-Type: application/json

{
  metadata: {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
    duetProject: 'projectId'  // 可选，从 refresh token 中提取
  }
}
```

如果未找到项目，尝试 **onboarding**（同步等待完成）。

#### 2.4 保存项目 ID

发现项目后，更新 refresh token 格式：

```javascript
account.refreshToken = formatRefreshParts({
  refreshToken: parts.refreshToken,
  projectId: parts.projectId,
  managedProjectId: project  // 新发现的项目 ID
});
```

### 3. 构建 API 请求

**代码位置**: `src/cloudcode/request-builder.js`

#### 3.1 构建请求头

```javascript
const headers = {
  'Authorization': `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  'User-Agent': 'antigravity/1.15.8 os/arch',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata': JSON.stringify({
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI'
  })
};

// Claude thinking 模型需要额外头部
if (modelFamily === 'claude' && isThinkingModel(model)) {
  headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
}
```

#### 3.2 构建请求体

```javascript
const payload = {
  project: projectId,  // 从 getProjectForAccount() 获取
  model: modelName,
  request: googleRequest,  // 转换后的 Google 格式请求
  userAgent: 'antigravity',
  requestType: 'agent',
  requestId: 'agent-' + crypto.randomUUID()
};
```

### 4. 发送 API 请求

**代码位置**: `src/cloudcode/message-handler.js` - `sendMessage()`

#### 4.1 非流式请求

```javascript
POST https://cloudcode-pa.googleapis.com/v1internal:generateContent
Authorization: Bearer {access_token}
Content-Type: application/json

{ payload }
```

#### 4.2 流式请求（Thinking 模型）

```javascript
POST https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
Authorization: Bearer {access_token}
Content-Type: application/json
Accept: text/event-stream

{ payload }
```

**代码位置**: `src/cloudcode/streaming-handler.js` - `sendMessageStream()`

### 5. 错误处理和重试

#### 5.1 账户选择

使用配置的策略选择账户：
- **Sticky**: 缓存优化（保持同一账户）
- **Round-Robin**: 负载均衡（轮询切换）
- **Hybrid**: 智能分配（默认，综合考虑健康度、令牌桶、配额、LRU）

#### 5.2 失败重试

- **网络错误**: 立即重试（最多 5 次）
- **速率限制 (429)**: 标记账户为限流，切换到下一个账户
- **配额耗尽**: 标记账户，切换到下一个账户
- **认证错误**: 标记账户为无效，切换到下一个账户

#### 5.3 端点回退

如果主端点失败，自动尝试备用端点：
1. `https://daily-cloudcode-pa.googleapis.com`（开发环境）
2. `https://cloudcode-pa.googleapis.com`（生产环境）

---

## 相关代码文件

### 核心文件

| 文件 | 功能 |
|------|------|
| `src/auth/oauth.js` | OAuth 授权流程（PKCE、token 交换、刷新） |
| `src/account-manager/credentials.js` | Token 和项目 ID 管理 |
| `src/account-manager/storage.js` | 账户配置持久化 |
| `src/cloudcode/request-builder.js` | API 请求构建 |
| `src/cloudcode/message-handler.js` | 非流式消息处理 |
| `src/cloudcode/streaming-handler.js` | 流式消息处理 |

### 配置文件

| 文件 | 功能 |
|------|------|
| `src/constants.js` | OAuth 配置、端点、头部定义 |
| `src/config.js` | 运行时配置 |

### 辅助文件

| 文件 | 功能 |
|------|------|
| `src/account-manager/onboarding.js` | 用户 onboarding（项目创建） |
| `src/cloudcode/model-api.js` | 模型和订阅信息 API |

---

## 安全注意事项

1. **PKCE**: 使用 PKCE 增强安全性，防止授权码拦截攻击
2. **State 参数**: 使用随机 state 参数防止 CSRF 攻击
3. **Token 缓存**: Access token 仅在内存中缓存，不持久化
4. **Refresh Token**: 以复合格式存储在配置文件中，包含项目信息
5. **权限最小化**: 只请求必要的 OAuth 权限范围

---

## 参考

- [OAuth 2.0 规范](https://oauth.net/2/)
- [PKCE 规范](https://oauth.net/2/pkce/)
- [Google OAuth 2.0 文档](https://developers.google.com/identity/protocols/oauth2)
- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth)（参考实现）
