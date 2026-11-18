# 05 · 接口契约

骨架见 [openapi.yaml](openapi.yaml)。本文是**权威语义**，两者冲突以本文为准。

## 1. 通用约定

### 1.1 认证

| 凭据 | 头 | 适用范围 |
| --- | --- | --- |
| 账号会话 | `Authorization: Bearer <session>` | `/v1/account/*`、`/v1/studio/*`、`/v1/market/*`、`/v1/operator/*` |
| 模型令牌 | `Authorization: Bearer omb_product_ai_<lookup>.<secret>` | `/v1/ai/*` |
| 沙箱令牌 | `Authorization: Bearer sbx_<...>` | **仅** `/v1/ai/*`，且模型必须在授权范围 |

三种凭据**不能互代**。运营者接口额外校验运营者名单；普通账号即使登录成功也返回 403。

### 1.2 错误包络

两类，客户端必须分别解析：

```json
// 普通 API
{ "error": "code" }

// 推理 API
{ "error": { "code": "…", "type": "…", "message": "…" } }
```

`message` 已脱敏，**不含上游正文、主机名、密钥、prompt**。

### 1.3 ID 头

| 头 | 含义 |
| --- | --- |
| `x-request-id` | 单个 HTTP 请求，所有响应都有 |
| `x-ai-request-id` | 账本 `ai_request.id`，**仅预占成功后返回** |
| `x-ai-model` | 实际公开模型 |
| `x-ai-pricing-version` | 价格版本串 |

鉴权、校验、余额不足、并发满**不带** `x-ai-request-id`。客户端据此判断"是否已经产生扣费风险"。

### 1.4 分页

游标式。请求 `?cursor=<opaque>&limit=<1..100>`，响应 `{items, nextCursor}`。`nextCursor` 为 `null` 表示结束。游标对客户端不透明，不得解析或构造。

### 1.5 幂等

`Idempotency-Key` 仅对 `POST /v1/ai/chat/completions`、`POST /v1/ai/responses`、`POST /v1/studio/bots/:id/versions/:v/exams/:quoteId/confirm` 生效。作用域与冲突规则见 03 §8。

### 1.6 速率限制

默认按账户：`/v1/ai/*` 60 次/分钟、`/v1/studio/*` 30 次/分钟、`/v1/market/*` 120 次/分钟、`/v1/operator/*` 60 次/分钟。超限 `429 rate_limited` + `Retry-After`。按分组可调。

## 2. 推理接口（`/v1/ai/*`）

### 2.1 `GET /v1/ai/models`

返回调用者可用的公开模型与路由组。

```json
{
  "models": [
    {
      "id": "gpt-6.1-sol",
      "label": "GPT-6.1 Sol",
      "protocols": ["chat", "responses"],
      "contextTokens": 200000,
      "outputTokens": 8192,
      "capabilities": { "tools": true, "vision": true },
      "pricingMode": "passthrough",
      "inputMicroPointsPerMillion": 4400000,
      "cachedInputMicroPointsPerMillion": 220000,
      "outputMicroPointsPerMillion": 22000000,
      "pricingVersion": "task-v1-r12-m22000"
    },
    {
      "id": "group/daily-coding",
      "label": "Daily coding",
      "protocols": ["chat", "responses"],
      "contextTokens": 200000,
      "outputTokens": 8192,
      "capabilities": { "tools": true, "vision": false },
      "pricingMode": "passthrough",
      "inputMicroPointsPerMillion": null,
      "cachedInputMicroPointsPerMillion": null,
      "outputMicroPointsPerMillion": null,
      "pricingVersion": null
    }
  ]
}
```

**路由组的价格字段为 `null`**，因为成员价格不同。客户端展示"按实际模型计价"，不得自行推算。

### 2.2 `POST /v1/ai/quote`

请求体与响应沿用现有契约，**新增** `multiplierBreakdown`：

```json
{
  "selectedModel": "gpt-6.1-sol",
  "complexity": "standard",
  "score": 4,
  "reasons": ["tools_requested", "many_turns"],
  "estimatedInputTokens": 10000,
  "estimatedMicroPoints": 120000000,
  "reservedMicroPoints": 183876000,
  "policyRevision": 12,
  "currency": "USD",
  "pointsPerCurrency": 1000,
  "rateSnapshot": { "input": 4400000, "cached": 220000, "output": 22000000 },
  "multiplierBreakdown": {
    "controllerBps": 22000,
    "groupFactorBps": 10000,
    "modelFactorBps": 10000,
    "clampedBps": 22000,
    "floorBps": 22000,
    "effectiveBps": 22000,
    "subsidized": false
  },
  "noPriceCommitment": true
}
```

`multiplierBreakdown` 为**可选字段**，老客户端忽略即可。

### 2.3 推理请求新增头

| 头 | 必填 | 说明 |
| --- | --- | --- |
| `Idempotency-Key` | 否 | 见 03 §8 |
| `x-hezuo-conversation-id` | 否 | 会话粘滞键；缺省服务端派生 |

### 2.4 新增错误

| HTTP | code | 触发 |
| --- | --- | --- |
| 409 | `idempotency_key_reuse` | 同 key 不同请求体 |
| 503 | `all_channels_unavailable` | 无健康候选 |
| 400 | `billing_amount_overflow` | 金额越界 |
| 400 | `route_depth_exceeded` | 路由组深度 > 3 |
| 400 | `no_eligible_route_member` | 能力过滤后无候选 |

现有错误码**全部保留不变**（见 03 §10）。

## 3. 账号接口

沿用现有 `/v1/account/ai/*`。本期新增：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/account/ai/ledger` | 现有，`kind` 新增 `reserve`、`settle_refund`、`substitute`、`adjust` |
| GET | `/v1/account/ai/subscription` | 分组与限制（只读）：`{group, groupFactorBps, limits:{concurrency,dailyRequests,dailyMicroPoints}}` |

`kind` 新增值对老客户端的影响：老版本遇到未知 `kind` 应忽略该条，不得崩溃。这是**兼容要求**，需在客户端验收。

## 4. 运营者接口（`/v1/operator/*`）

### 4.1 供应商与渠道

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/operator/providers` | 列表，`{items:[{id,kind,name,baseUrl,enabled,revision}]}` |
| POST | `/v1/operator/providers` | 创建 |
| PATCH | `/v1/operator/providers/:id` | `{revision, reason, ...}`，409 冲突 |
| GET | `/v1/operator/channels` | 列表（含模型映射，不含密钥） |
| POST | `/v1/operator/channels` | 创建 |
| PATCH | `/v1/operator/channels/:id` | 修改；改 `baseUrl` 必须带 `key` |
| POST | `/v1/operator/channels/:id/keys` | 增加密钥 |
| PATCH | `/v1/operator/channels/:id/keys/:keyId` | 状态/优先级；手动停用置 `manualDisabled` |
| POST | `/v1/operator/channels/:id/probe` | 探测 `{models, latencyMs}` |
| POST | `/v1/operator/providers/:id/sync` | `newapi` 同步，返回**建议值** |

渠道响应示例（脱敏）：

```json
{
  "id": "ch_01J...",
  "providerId": "pv_01J...",
  "baseUrl": "https://api.example.com",
  "protocols": ["chat", "responses"],
  "priority": 100,
  "weight": 100,
  "enabled": true,
  "revision": 7,
  "keys": [
    { "id": "ck_01J...", "hasKey": true, "status": "active", "manualDisabled": false, "cooldownUntil": null }
  ],
  "models": [
    { "upstreamModel": "gpt-6.1-sol", "publicModelId": "gpt-6.1-sol", "costRates": { "input": 2000000, "cached": 100000, "output": 10000000 } }
  ]
}
```

**`keys[]` 永远不出现明文、密文、末位字符。**

### 4.2 路由组

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/operator/route-groups` | |
| POST | `/v1/operator/route-groups` | 校验深度、环、成员唯一 |
| PATCH | `/v1/operator/route-groups/:id` | |
| POST | `/v1/operator/route-groups/:id/simulate` | 试算：传模拟请求特征，返回选中成员 |

试算请求：

```json
{ "hasTools": true, "hasVision": false, "estimatedInputTokens": 10000, "protocol": "chat", "simulatedRequestId": "sim_abc" }
```

响应必须标注：

```json
{ "selectedMember": "gpt-6.1-sol", "candidates": [...], "strategy": "weighted", "simulated": true,
  "disclaimer": "randomised strategy; a real request with a different request id may pick another member" }
```

### 4.3 计费与分组

见 03 §9。补充：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/operator/user-groups` | |
| POST | `/v1/operator/user-groups` | `{id,name,groupFactorBps,allowBelowFloor,limits,allowedModels}` |
| GET | `/v1/operator/accounts/:id/subscription` | `{groupId}` |
| PUT | `/v1/operator/accounts/:id/subscription` | `{groupId, reason}`，写审计 |

### 4.4 请求与对账

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/operator/requests?state=&model=&channelId=&userId=&cursor=` | 全局筛选 |
| GET | `/v1/operator/requests/:id/attempts` | 故障切换明细 |
| GET | `/v1/operator/routing/decisions?cursor=` | 最近选路（不含请求正文） |
| POST | `/v1/operator/requests/:id/settle` | 人工结算，仅向下 |
| GET | `/v1/operator/reconcile?kind=channel_cost&days=7` | 对账结果 |
| GET | `/v1/operator/metrics/identity` | 恒等式校验最近结果 |

`GET /v1/operator/requests` 响应**不含** prompt、上游正文、密钥。只含：`id, userId(脱敏), model, selectedModel, state, reservedMicroPoints, chargedMicroPoints, costMicroUsd, costStatus, channelId, routeGroupId, attemptsCount, createdAt, latencyMs`。

### 4.5 题库与审核

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/v1/operator/exam/suites` | 套件 |
| GET/POST | `/v1/operator/exam/cases` | 题；导入时完整校验 |
| POST | `/v1/operator/exam/cases/:id/disable` | 停用 |
| GET | `/v1/operator/exam/runs?state=&cursor=` | 队列与结果 |
| POST | `/v1/operator/market/moderation` | 下架/封禁/申诉处理 |
| GET | `/v1/operator/market/reports?state=open` | 举报队列 |
| GET/POST | `/v1/operator/config/rubric-models` | 评分模型白名单 |

## 5. Studio 接口（`/v1/studio/*`）

### 5.1 Bot 与版本

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/studio/bots` | 本人 Bot |
| POST | `/v1/studio/bots` | `{slug, category}` |
| GET | `/v1/studio/bots/:id` | 详情（仅所有者） |
| POST | `/v1/studio/bots/:id/versions` | 上传包（`multipart/form-data` 或 JSON+base64），返回不可变版本 |
| GET | `/v1/studio/bots/:id/versions` | 版本列表 |
| GET | `/v1/studio/bots/:id/versions/:v` | 单版本 + lint 报告 |
| GET | `/v1/studio/bots/:id/versions/:v/diff?against=<v2>` | 差异 |

上传响应：

```json
{
  "version": {
    "id": "bv_01J...", "semver": "1.2.0", "botHash": "9f86d0…",
    "reviewState": "pending", "createdAt": "2026-11-16T02:00:00Z"
  },
  "lint": { "passed": true, "findings": [] },
  "claims": [{ "modelId": "gpt-6.1-sol", "claims": ["tools", "long_context"] }]
}
```

`lint.passed=false` 时 `reviewState` 直接为 `rejected`，附 `findings`（脱敏原因）。

### 5.2 调试会话（D-37）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/studio/sessions` | `{botVersionId, modelId, limits:{maxTurns,maxCostPoints,timeoutSeconds}}` |
| GET | `/v1/studio/sessions/:id` | 状态 |
| GET | `/v1/studio/sessions/:id/events` | SSE 流 |
| POST | `/v1/studio/sessions/:id/messages` | `{text}` 追加消息 |
| POST | `/v1/studio/sessions/:id/stop` | 取消 |
| POST | `/v1/studio/sessions/:id/approvals/:approvalId` | `{decision:"allow"\|"deny"}` |
| GET | `/v1/studio/sessions/:id/trace` | 完整 trace（裁剪后） |

SSE 事件类型固定四种：

```text
event: state      data: {"state":"running"}
event: text       data: {"delta":"…"}
event: tool       data: {"name":"shell","phase":"start","input":{…}}   // input 已脱敏
event: approval_request data: {"approvalId":"ap_1","summary":"run shell command"}
```

`text` 与 `tool` 的 `input` 只对**作者本人**可见；渠道信息只有别名。

### 5.3 考试

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/studio/bots/:id/versions/:v/exams` | 申请估价 |
| POST | `/v1/studio/bots/:id/versions/:v/exams/:quoteId/confirm` | 确认（幂等） |
| GET | `/v1/studio/exams/:id` | 进度与成绩单 |
| GET | `/v1/studio/exams` | 本人考试列表 |
| POST | `/v1/studio/exams/:id/cancel` | 取消未开始的 |

估价响应（D-40）：

```json
{
  "quoteId": "eq_01J...",
  "modelId": "gpt-6.1-sol",
  "estimatedPoints": 320,
  "maxCostPoints": 500,
  "expiresAt": "2026-11-16T02:15:00Z",
  "suiteVersion": 3,
  "caseCount": 24
}
```

确认响应：`{examRunId, state:"queued", budgetMicroPoints}`。重复确认同一 `quoteId` 返回**同一** `examRunId`。

过期：`410 quote_expired`。预算不足：`402 insufficient_balance`。

成绩单响应（作者视角）：

```json
{
  "id": "er_01J...",
  "state": "completed",
  "totalScore": 78,
  "level": "silver",
  "gateFailed": false,
  "dimensions": { "correctness": 82, "stability": 75, "safety": 100, "efficiency": 61 },
  "identity": {
    "botHash": "9f86d0…", "modelId": "gpt-6.1-sol",
    "upstreamFingerprint": "3c1a…", "suiteVersion": 3
  },
  "cases": [
    { "caseId": "c_017", "category": "coding", "dims": { "correctness": 90 }, "runs": 3, "passed": 2,
      "failureSummary": "assertion failed: expected parseHeader" }
  ],
  "validUntil": "2026-12-16T00:00:00Z"
}
```

**保密题只显示 `caseId`、`category`、`failureSummary`**，不显示题面、标准答案、完整 checklist。

### 5.4 CLI 契约（D-39）

```text
hezuo-bot login [--token]           # 非交互用 HEZUO_BOT_TOKEN
hezuo-bot init [--slug <slug>]
hezuo-bot lint [--json]
hezuo-bot test --model <id> [--json]
hezuo-bot publish [--draft] [--json]
hezuo-bot submit --version <semver> [--json]
hezuo-bot status [--json]
```

退出码：`0` 成功、`1` 用法错误、`2` lint/test 未通过、`3` 认证失败、`4` 网络或服务端错误。

## 6. 市场接口（`/v1/market/*`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/market/bots?model=&category=&level=&sort=&cursor=` | 列表 |
| GET | `/v1/market/bots/:slug` | 详情 |
| GET | `/v1/market/bots/:slug/versions/:v/download` | 授权下载（短期签名 URL） |
| POST | `/v1/market/bots/:slug/install` | `{modelId}` 记录安装 |
| POST | `/v1/market/reports` | `{listingId?, botId?, category, reason}` |

列表项：

```json
{
  "slug": "refactor-helper",
  "name": "Refactor Helper",
  "category": "coding",
  "author": { "displayName": "…" },
  "bestLevel": "silver",
  "bestScore": 78,
  "modelScores": [
    { "modelId": "gpt-6.1-sol", "score": 78, "level": "silver", "state": "verified" },
    { "modelId": "claude-sonnet-5", "score": null, "level": null, "state": "unverified" }
  ],
  "installCount": 1234,
  "updatedAt": "2026-11-10T00:00:00Z"
}
```

按 `model=` 筛选时只返回该模型上 `state='verified'` 的 Bot。**不带 `model` 时返回全部**，未验证的在 `modelScores` 里显示 `unverified`，不隐藏（D-46 段）。

安装响应返回**短期签名下载 URL**（默认 5 分钟有效），不返回长期凭据。

## 7. 错误码全表

### 7.1 HTTP 映射

| HTTP | 语义 | 典型 code |
| --- | --- | --- |
| 400 | 输入非法 | `invalid_request`、`invalid_billing_policy`、`unsupported_service_tier`、`billing_amount_overflow`、`billing_price_limit`、`route_cycle`、`route_depth_exceeded`、`key_required_on_url_change`、`limit_exceeded` |
| 401 | 未认证 | `unauthorized`、`ai_token_invalid`、`sandbox_token_invalid` |
| 403 | 无权限 | `forbidden`、`ai_not_enabled`、`ai_suspended`、`model_not_allowed`、`not_listing_owner` |
| 404 | 不存在/不可见 | `not_found`、`object_not_visible` |
| 409 | 冲突 | `revision_conflict`、`billing_revision_conflict`、`idempotency_key_reuse`、`slug_taken`、`already_confirmed` |
| 410 | 已过期 | `quote_expired` |
| 413 | 体过大 | `payload_too_large` |
| 429 | 限流/并发 | `rate_limited`、`ai_busy` |
| 500 | 内部错误 | `internal_error` |
| 503 | 暂不可用 | `ai_unavailable`、`ai_temporarily_unavailable`、`ai_temporarily_busy`、`all_channels_unavailable` |

`409 revision_conflict` 响应体必须带当前版本号：

```json
{ "error": "revision_conflict", "currentRevision": 8 }
```

### 7.2 稳定约定

- code 为小写下划线，**不复用不同语义**。
- 新增 code 必须同步本文与 `openapi.yaml`。
- 不向前端或客户端透传上游 code。

## 8. 授权规则（逐条）

| 接口族 | 规则 |
| --- | --- |
| `ai/*` | 模型令牌必须属于启用账户；模型在 `allowed_models` 内（空数组表示全部）；沙箱令牌只能调模型 |
| `account/*` | 仅能访问本人数据 |
| `studio/*` | 每个 `:id` 都做**对象级**所有权校验，不能只验"已登录"或"是开发者" |
| `market/*` | 登录即可浏览；安装记录绑定本人；下载 URL 短期且不跨用户复用 |
| `operator/*` | 运营者名单 + 分权（配置/计费/题库/审核可分子角色） |

**关键反例**（必须写测试）：`GET /v1/studio/bots/<别人的id>` → 404（不是 403，避免存在性泄露）。

## 9. 与老客户端的兼容清单

升级到 V2 后，老客户端（不改代码）必须能：

1. 调 `/v1/ai/models` 拿到模型列表，路由组以普通 ID 出现
2. 调 `/v1/ai/quote` 拿到报价，忽略 `multiplierBreakdown`
3. 调 `/v1/ai/chat/completions` 与 `/v1/ai/responses` 正常对话
4. 调 `/v1/account/ai/ledger` 读流水，**遇到未知 `kind` 不崩溃**
5. 收到新增错误码（如 `all_channels_unavailable`）时降级为"服务暂不可用"

第 4、5 条需要在客户端做验收，属于 M2 的联合验证项。
