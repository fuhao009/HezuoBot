# 02 · 上游管理与混合路由

本文实现 M1（基础路由）与 M3（高级策略、`newapi`、嵌套）。

## 1. 三层模型

```text
provider（供应商）
  └── channel（接入点）
        ├── channel_key（密钥 1..n）
        └── channel_model（上游模型名 → 公开模型 映射 + 成本价）
```

| 层 | 关键字段 | 说明 |
| --- | --- | --- |
| `provider` | `id, kind, name, base_url, enabled` | `kind ∈ {openai, anthropic, gemini, openai_compatible, newapi}`。`base_url` 是该供应商的默认地址，渠道可覆盖。 |
| `channel` | `id, provider_id, base_url, protocols[], priority, weight, enabled, group_tags[], revision` | `protocols ⊆ {chat, responses}`。一期不做 messages 协议转换（D-13），存字段但不对外承诺。 |
| `channel_key` | `id, channel_id, encrypted_value, kid, status, cooldown_until, quota_hint, concurrency_limit` | `status ∈ {active, cooling, exhausted, disabled}`。 |
| `channel_model` | `channel_id, upstream_model, public_model_id, cost_rates, long_rates, long_threshold, long_inclusive` | 成本价是**运营者录入**的估算值，`source='operator_supplied_estimate'`。 |

### 1.1 一个公开模型可以有多个渠道（D-07）

原稿写"每个公开模型明确绑定一个渠道"，本契约放开：同一公开模型可被多个渠道提供，用于多上游冗余。

- `public_model.primary_channel_id` 指定默认渠道。
- 同模型的其余渠道作为**同模型候选**参与 `weighted` / `order` 之外的降级。
- 若这些渠道的成本价不同，结算时**按实际使用的那个渠道的成本价**（该渠道 `channel_model.cost_rates`），并在请求快照里锁定。这保证成本核算不串台。
- 管理后台必须展示"同一公开模型的价格差异"，避免运营者误以为只有一个价。

## 2. 密钥与地址安全

### 2.1 加密（D-08）

- 主密钥 `HEZUO_MASTER_KEY`：32 字节，base64 编码，来自 `EnvironmentFile`。
- 派生：`HKDF-SHA256(master, salt="hezuo", info="hezuo/channel-key/v1")` → 32 字节 AES 密钥。
- 每条密文：`kid`（主密钥版本，整数）、`iv`（12 字节随机）、`ct`、`tag`。合并存为 `enc:v1:<kid>:<base64(iv|ct|tag)>`。
- 读接口只返回 `hasKey: boolean`，**不返回明文、密文、末位字符**。

### 2.2 换址必须换钥（D-09）

- 修改 `base_url` 时请求体必须带 `key` 字段，否则 `400 key_required_on_url_change`。
- 不允许"留空表示保留旧钥"。这条比原稿更严格，因为"同 ID 同 URL 才保留"的判定在并发修改下不可靠。
- 地址校验：必须 `https://`；拒绝用户名密码、query、fragment；不跟随重定向。

### 2.3 威胁边界

运营者是信任边界，允许其配置内网 HTTPS 地址。因此：

- **不做** DNS rebinding 防护的承诺——字符串校验挡不住 DNS 变化，真正的防护在部署环境的网络策略（出口 ACL）。
- 文档与后台不得声称"已防 DNS rebinding"。
- 开发者（Bot 作者）**永远没有**配置上游地址的能力（D-36）。

## 3. 健康与熔断

### 3.1 探测

| 探测 | 频率 | 内容 | 成本上限 |
| --- | --- | --- | --- |
| 目录探测 | 每 60s | `GET /v1/models` | 免费（不推理） |
| 推理探测 | 每 10min | `max_output_tokens=1` 的最小 chat 请求 | `probe_cost_cap_micro_usd`，默认 1000/渠道/小时 |

- 探测使用**渠道内状态为 `active` 的一个密钥**，轮转使用，避免只测一把。
- 探测结果写 `channel_event` 与 Redis 窗口；**探测产生的上游成本计入运营成本，永不计入任何用户扣费**（D-11）。
- 探测超时 10 秒，失败重试 1 次。

### 3.2 状态机

```text
       ┌──────────┐  连续 5 次可重试错误 / 窗口成功率<50%
       │  active  │ ─────────────────────────────────┐
       └────┬─────┘                                  ▼
            │                                    ┌─────────┐
            │  401/403                           │ cooling │
            ├──────────────────────► ┌──────────┐└────┬────┘
            │                        │ disabled │     │ 冷却到期
            │  402/额度耗尽           └──────────┘     │ 放行 1 个探测
            ▼                             ▲           │ 成功→active
       ┌───────────┐                      │           │ 失败→退避加倍
       │ exhausted │──────────────────────┘           │
       └───────────┘   运营者手动处理 / 探测恢复       └──► 回到 cooling
```

- 退避序列：30s → 1m → 2m → 4m → 8m → 15m（封顶）。
- **手动 `disabled` 优先**：运营者手动停用的密钥，自动恢复流程不得改动（D-10）。
- 冷却到期恢复用 Redis 原子租约 `SET probe:{channel}:{key} NX PX 30000`，只放 1 个探测。抢不到租约就等下一轮。
- 所有状态变化写 `channel_event(channel_id, key_id, from_status, to_status, reason, status_code, at)`，`reason` 是枚举短码（如 `consecutive_5xx`、`rate_limited`、`auth_failed`、`quota_exhausted`、`probe_recovered`、`manual_disable`），**不含响应正文与密钥**。

### 3.3 窗口指标

Redis key `health:{channel}:{key}`，ZSET 存最近 5 分钟每次调用 `(ts, ok|retryable|fatal, ttfb_ms)`，到期裁剪。派生：成功率、P95 TTFB、429 计数、5xx 计数。

## 4. 路由组

### 4.1 概念

`route_group` 对客户端是一个公开模型，ID 形如 `group/daily-coding`。成员可以是：

- 一个 `public_model`（`member_type='model'`）
- 另一个 `route_group`（`member_type='group'`，深度上限 3）

`/v1/ai/models` 只返回组本身的 ID、显示名、能力标签、价格模式——**不返回成员列表**。

### 4.2 策略

| 策略 | 选择规则 | 里程碑 |
| --- | --- | --- |
| `order` | 按 `position` 取第一个可用成员；不可用才下一个 | M1 |
| `weighted` | 同 `priority` 内按 `weight` 加权随机（用确定性 PRNG，见 4.5） | M1 |
| `rotate` | 按 `rotate:{group}` 计数器轮转，`INCR` 后取模 | M1 |
| `cost` | 满足约束且成本价最低 | M3 |
| `latency` | 近期 P95 TTFB 最低（样本 < 20 视为未知，排最后） | M3 |
| `usage` | 近期用量最少（按 5 分钟窗口 token 数） | M3 |
| `quota` | 优先 `quota_hint` 显示即将重置且仍有余量的密钥；无 `quota_hint` 时退化为 `weighted` | M3 |

### 4.3 能力约束

成员/组上可设：

- `needs_tools`：请求带 `tools` 时必须满足
- `needs_vision`：请求带图片时必须满足
- `min_context_tokens`：模型上下文上限必须 ≥ 该值
- `protocol`：必须匹配请求协议

**过滤发生在选路之前。** 被过滤掉的成员：

- **不计入失败**，不计入重试损耗
- 不写 `request_attempt`
- 不消耗 3 次尝试配额

这条与 D-14 一致，是验收必测项（08 的故障矩阵）。

### 4.4 深度与环

创建/修改时校验：

1. 从该组出发做 DFS，深度 > 3 拒绝 `400 route_depth_exceeded`
2. 父链上再次遇到同一组 ID → `400 route_cycle`
3. 成员指向的 `public_model` / `route_group` 必须存在且启用 → `400 route_member_invalid`
4. 组内不能有重复成员 → `400 route_duplicate_member`

校验在应用层与数据库约束双重保证：数据库存 `route_group_member`，应用层负责图校验（SQL 无法高效表达递归环检测），但**读取时仍做一次深度断言**，防止历史数据被手工改坏。

### 4.5 确定性随机

`weighted` 不能每次用 `Math.random()`，否则试算与复现都做不到。规则：

```text
seed = sha256(group_id + ":" + request_id)
index = 用 seed 作种子的 PRNG，取 [0, total_weight)
```

这样同一 `request_id` 重放得到同一选择，试算页可以用模拟 `request_id` 复现（D-19 的试算要求）。管理后台的试算结果必须标注"基于模拟 request_id，实际请求会不同"。

## 5. 选路流程（伪代码）

```text
fn select_route(request):
  # 1. 展开
  graph = expand(group_id)                    # 已校验深度与环
  if graph.depth > 3: reject route_depth_exceeded

  # 2. 能力过滤（不计失败）
  candidates = graph.members.filter(m =>
      satisfies(request, m.constraints))
  if candidates.empty: reject no_eligible_route_member

  # 3. 健康过滤（不计失败，但记录）
  healthy = candidates.filter(m =>
      m.channel.enabled && m.key.status == active)

  # 4. 粘滞优先（D-17）
  if affinity = redis.get(affinity_key(request)):
     if affinity in healthy: return affinity

  # 5. 按策略排序
  ordered = apply_strategy(healthy, group.strategy, request)

  # 6. 没健康候选时，退回"冷却中但可能已恢复"的候选（只放 1 个）
  if ordered.empty:
     cooled = candidates.filter(m => m.key.status in {cooling, exhausted})
                             .filter(recently_recovered)
     if cooled.empty: reject all_channels_unavailable
     ordered = cooled.take(1)

  return ordered
```

## 6. 故障切换（扣费正确性的核心）

### 6.1 首字节边界

**定义：向客户端写出任何响应字节。** 不是首个 token，不是收到上游响应头，不是发出心跳。

实现要求：

- relay 内部有单一布尔 `bytes_written`，由响应写入层统一置位，**不允许**各处自行判断。
- 一旦 `bytes_written = true`，禁止任何重试与成员切换。
- 允许在上游响应头到达后、首字节写出前切换——但**不得为了"争取切换机会"而延迟或缓冲首字节超过 1 秒**。这个缓冲窗口是固定的 1 秒，不是可配置项。

### 6.2 错误分类

| 分类 | 情形 | 可重试 |
| --- | --- | --- |
| 连接失败 | DNS、TCP、TLS、连接超时 | ✅ |
| 首字节前超时 | 上游 30s 内无响应头 | ✅ |
| 429 | 上游限流 | ✅ |
| 5xx | 上游网关/内部错误 | ✅ |
| 额度耗尽 | 明确的 quota 类错误码/文案 | ✅ |
| 400 类 | 请求本身有问题 | ❌ |
| 内容策略拒绝 | 安全拒绝 | ❌ |
| 客户端取消 | 客户端断开 | ❌ |
| 已写出后任何错误 | 包括断流 | ❌ |

### 6.3 限制

- 最多 **3 个（渠道，密钥）组合**（D-15）
- 总时限 **60 秒**，从请求进入 relay 起算，**含准入与预占时间**
- **重试不重置计时器、不新增用户预占**。预占在准入时已按最贵候选冻结，切换不追加冻结。
- 每次尝试写一行 `request_attempt(request_id, attempt_no, channel_id, key_id, outcome, status_code, ttfb_ms, total_ms, affinity_broken, at)`，`outcome ∈ {success, retryable_error, fatal_error, abandoned, partial}`
- **只有最终成功/部分成功的尝试产生扣费**。被放弃的尝试不提现在用户流水，只进运营指标 `retry_loss`。

### 6.4 上游响应错误透传

客户端只收到稳定脱敏错误：

| 情形 | 返回 |
| --- | --- |
| 全部尝试可重试失败 | `503 ai_temporarily_unavailable` |
| 上游 429 且无其他候选 | `503 ai_temporarily_busy` |
| 上游 4xx 请求错误 | 原状态码 + 脱敏 message，**不含上游正文** |
| 无健康候选 | `503 all_channels_unavailable` |

**绝不回传**：上游响应正文、上游主机名、key ID、内部模型名。

## 7. 会话粘滞

- 键：`x-hezuo-conversation-id`（客户端可传）；缺省 `sha256(首条消息前 512 字节 + token_id)`
- Redis：`affinity:{owner_user_id}:{convKey}` → `{channel_id}:{key_id}`，TTL 30 分钟，命中续期
- 破坏条件：目标不健康、能力不再满足、实例被删
- 破坏时记 `request_attempt.affinity_broken = true`，**不对客户端暴露**
- 粘滞不影响预占（预占仍按全部候选最贵计算）

## 8. `newapi` 类型供应商（M3）

### 8.1 同步

| 动作 | 接口 | 副作用 |
| --- | --- | --- |
| 同步模型 | `GET /v1/models` | 只读；产出**建议列表** |
| 同步价格 | 可选，上游支持时 | 产出**建议成本价** |
| 同步余额 | 可选 | 写 `channel_key.quota_hint` |

### 8.2 建议值必须人工确认（D-18）

`POST /v1/operator/providers/:id/sync` 返回：

```json
{
  "syncedAt": 1763318400000,
  "models": {
    "discovered": ["gpt-4o", "claude-sonnet-4"],
    "unmapped": ["gpt-4o"],
    "suggested": [{ "upstreamModel": "claude-sonnet-4", "publicModelId": "claude-sonnet-4", "costRates": { "...": "..." } }]
  },
  "balance": { "available": 12.5, "currency": "USD" },
  "failed": []
}
```

- 返回值**不写入生效配置**。运营者在后台逐项确认后才进生效 revision。
- 同步失败**不覆盖**已有价格、映射、密钥。三个部分（模型/价格/余额）分别报告成功与失败。
- 上游不可达时返回 `200` 但 `failed` 数组带原因；不用 5xx 掩盖部分成功。

### 8.3 用量字段解析

上游返回的 usage 若含缓存的读写字段，按 03 的口径解析。缺失时走保守口径。**不猜测上游字段含义**：认不出的字段忽略并记 `unknown_usage_field` 指标，不作计价依据。

## 9. 配置生命周期

### 9.1 对象级 revision（D-19）

每个可配置对象有 `revision` 整数。保存请求必须带 `revision`：

- 匹配 → 更新，`revision + 1`
- 不匹配 → `409 revision_conflict`，响应带 `currentRevision` 与当前对象（脱敏），运营者人工合并
- 首次创建不带 `revision`

禁止"无条件覆盖"。整份目录一次保存的方式取消（原稿 2.4 的"50 渠道内可保留"不再采用），改为按对象保存。

### 9.2 审计

每次变更（成功或失败）写 `config_audit(actor_id, object_type, object_id, from_revision, to_revision, before_json, after_json, reason, request_id, at)`。

- `before_json`/`after_json` 必须**剔除密钥字段**，只保留 `hasKey`
- 失败（revision 冲突）也记录，因为这是并发冲突的证据
- 原因 `reason` 必填，1–500 字符，不含控制字符

### 9.3 上限

| 对象 | 上限 |
| --- | --- |
| 供应商 | 50 |
| 渠道 | 200 |
| 每渠道密钥 | 10 |
| 公开模型 | 500 |
| 路由组 | 50 |
| 路由组成员（单组） | 20 |
| 用户分组 | 20 |

超限 `400 limit_exceeded`，附具体对象名。
