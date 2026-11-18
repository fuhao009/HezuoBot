# 03 · 下游扣费

本文所有数字均由脚本按 `packages/shared/task-billing.ts` 的整数语义实算得出，不是手推。实现时必须以共享函数为准，本文只固定语义与验收数值。

## 1. 不变量

1. 单位：整数**微积分**，1 积分 = 1,000,000 微积分。积分是服务额度，不是货币，不可兑换、不退款为现金。
2. 成本单位：整数**微美元**，1 USD = 1,000,000 微美元。仅内部核算。
3. 上界：任何金额 ≤ `9007199254740991`（2^53−1）。运算全程 BigInt，越界即 `400 billing_amount_overflow`，**不得截断或饱和**。
4. 向上取整：所有除法向上取整，不四舍五入。
5. 状态机：`reserved → streaming → review | settled`。`settled` 与 `review` 是终态，`settled` 不可再改金额。
6. 快照：准入时冻结价格、倍率、策略版本、渠道、服务档位、时间条件。事后改价不追溯。
7. 余额永不为负：`available ≥ 0` 由 CHECK 与条件 UPDATE 双重保证。
8. 只追加：`ledger_entry` 无 UPDATE/DELETE。

## 2. 计价公式

```text
numerator  = Σ ( tokens_i × rate_i )          单位：微美元 / 百万 token
cost_micro_usd        = ceil(numerator / 1e6)
charged_micro_points  = ceil(numerator × pointsPerCurrency × multiplierBps / 1e10)
```

`rate_i` 来自 `channel_model.cost_rates`（运营者录入的估算）。token 分类**互斥**：

```text
normal_input = input_tokens − cached_input_tokens − cache_write_tokens − cache_write_hour_tokens
numerator    = normal_input × rate.input
             + cached_input_tokens × rate.cached
             + cache_write_tokens × rate.write
             + cache_write_hour_tokens × rate.writeHour
             + output_tokens × rate.output
```

约束：`cached + write + writeHour ≤ input`，超出 `400 invalid_cache_partition`。输出 token 含推理 token，不重复计。

### 2.1 长上下文

`longThreshold` + `longInclusive` 决定是否换用 `longRates`：

- `longInclusive = true` → `input >= threshold`
- `longInclusive = false` → `input > threshold`
- 判定用**全部 input_tokens**（含缓存部分）
- 阈值与费率随请求快照锁定，不随后续配置变化

### 2.2 保守口径

| 情形 | 处理 | `cost_status` |
| --- | --- | --- |
| 上游未报告 `cachedInputTokens` | 全部输入按 `max(rate.input, rate.cached)` 计 | `conservative` |
| 上游未报告 `cacheWriteTokens` 且 `rate.write` 高于当前费率 | 抬到 `rate.write` | `conservative` |
| 上游未报告 `cacheWriteHourTokens` 且 `rate.writeHour` 更高 | 抬到 `rate.writeHour` | `conservative` |
| 已报告正数缓存写入但无对应费率 | **拒绝自动结算** → `review`，原因 `missing_cache_write_tariff` | `unknown` |
| 分区总量超过 input | **拒绝自动结算** → `review`，原因 `invalid_cache_partition` | `unknown` |
| usage 完全缺失 | 按已转发字符数保守估计，置 `review` | `unknown` |

`conservative` 与 `estimated` 都不是已确认的上游账单成本。人工结算只能确定**用户积分**，采购成本仍为 `unknown`。

## 3. 预占

### 3.1 输入预占

```text
remaining = context_tokens − max_output_tokens
max_input = vision ? remaining
                   : min(remaining, ceil(estimated_input_tokens × 1.5) + 2048)
```

- `estimated_input_tokens`：本地结构估计（ASCII 约 4 字符 1 token，非 ASCII 按字符类别加权），含工具定义与 instructions。**不是厂商 tokenizer**。
- `vision = true` 时按全部剩余上下文预占（图片 token 无法可靠估计）。
- 输出取 `min(请求的 max_output_tokens, 模型 max_output_tokens)`。

### 3.2 预占费率必须用 `worst()`

**这是最容易实现错的一处，单列说明。**

预占不能只用 `rate.input`。必须用 `worst()`：

```text
rateMax(row)  = max(row.input, row.cached, row.write ?? 0, row.writeHour ?? 0)
worst.input   = max(rateMax(base), rateMax(long))   // 若存在 longRates
worst.cached  = worst.input                          // 缓存读也按最贵算
worst.output  = max(base.output, long.output)
```

原因是缓存写入价常高于普通输入价。以 `gpt-6.1-sol` 为例：`input` 2 USD/M，但 `write` 2.5 USD/M。若预占只按 `input`，一旦命中缓存写入就会预占不足。因此预占按 **2.5 USD/M** 计。

**这就是算例 B 中 `worstIn = 2,500,000` 而不是 2,000,000 的原因。**

### 3.3 路由组预占

`passthrough` 组取**所有候选成员的最大预占**（D-22）。理由：切换成员时不能追加冻结，否则用户余额会被二次占用。代价是预占偏大——用户看到的可用余额更保守，这是可接受的保守偏差。

`fixed` 组按 `fixed_price_micro_points` 预占（等于实际扣费，无差额）。

### 3.4 原子性

预占必须是**一条语句**，不能"先查后扣"：

```sql
UPDATE balance
   SET available = available - $reserve,
       reserved  = reserved + $reserve,
       updated_at = now()
 WHERE owner_user_id = $owner
   AND available >= $reserve;
-- 0 行受影响 → 402 insufficient_balance，不得继续
```

与写 `ai_request`、写预占流水、幂等认领在同一事务内。任一步失败整笔回滚，不留孤儿预占。

### 3.5 并发上限

每账户同时处于 `reserved`/`streaming` 的请求数上限按分组（默认 8）。超限 `429 ai_busy` + `Retry-After: 2`，**不预占**（D-31）。并发计数用 PG 条件查询，Redis 只做加速，Redis 计数丢失不能放大可预占数。

## 4. 结算

### 4.1 规则

```text
charged <= reserved  →  退还差额 (reserved − charged)，置 settled
charged >  reserved  →  在 available 内补扣
                        补扣成功 → settled
                        余额不足 → 扣到 0，置 review，原因 usage_exceeds_reservation
```

现有实现用一条 CASE 表达式同时处理，保持该写法（单语句原子）。

### 4.2 只有成功/部分成功的尝试计费

- 最终成功或部分成功的尝试 → 计费
- 被放弃的重试尝试 → **不计费**，成本进运营指标 `retry_loss`
- 全部尝试失败 → 释放全部预占，`settled` + `charged = 0` + `no_successful_attempt`（D-24）

### 4.3 部分结算

流式中途断开：用已收到的 usage；无 usage 则按已转发字符数保守估计。置 `review`。运营者可事后**向下**调整（只能退款，不能加扣）。

### 4.4 超时

`streaming` 超过 **10 分钟**无结算 → `worker-settle` 转 `review`，`stale_reservation`，按预占 **100%** 保留冻结（D-25）。冻结额留在 `reserved`，**不得同时计入 `charged`**（否则恒等式双算）。

## 5. 倍率

### 5.1 合成

```text
raw      = floor(controller_bps × group_factor_bps × model_factor_bps / 1e8)
clamped  = clamp(raw, minMultiplierBps, maxMultiplierBps)
floorBps = ceil((10000 + overheadBps) × 10000 / (10000 − targetMarginBps))

effective = allow_below_floor ? clamped : max(clamped, floorBps)
```

### 5.2 成本下限优先（D-21，原稿未定义）

原稿只说"夹紧到 `[min, max]`"，没说夹紧后仍低于成本下限怎么办。本契约：

- **非补贴组**：`effective = max(clamped, floorBps)`。即成本下限是硬地板，任何分组/模型系数的组合都不能把它压破。
- **补贴组**（`allow_below_floor = true`）：允许低于，且每次低于 floor 的结算写一条 `subsidy_audit`。
- 保存策略时校验 `minMultiplierBps ≤ floorBps ≤ maxMultiplierBps`，不满足 `400 invalid_billing_policy`。这与现有 `saveBillingPolicy` 的校验一致。

### 5.3 控制器

维持现有行为：按窗口样本、目标毛利、运营开销调整，限制单次步长与冷却，revision 比较交换写入。控制器只调 `controller_bps`，不改分组/模型系数。

- 窗口内 `review` + `unknown cost` 占比 > 10% → 最多上调一步
- 已知成本样本毛利低于目标 → 最多上调一步
- 否则最多下调一步回到 floor
- 无新终态数据不调整（避免空转涨价）

## 6. 算例（验收必须逐位一致）

统一参数：`pointsPerCurrency = 1000`（1 USD = 1000 积分），`multiplierBps = 22000`（2.2×，即 `overhead=1000`、`targetMargin=5000` 时的 floor）。

### 算例 A — 基本结算

`gpt-6.1-sol`，费率 input 2 / cached 0.1 / output 10 USD/M。

```text
usage: input 12,000（其中缓存命中 8,000）、output 1,500
normal_input = 4,000

numerator = 4,000 × 2,000,000 + 8,000 × 100,000 + 1,500 × 10,000,000
          = 23,800,000,000

cost_micro_usd       = 23,800   (0.0238 USD)
charged@2.2×         = 52,360,000 微积分  (52.36 积分)
charged@1.0×         = 23,800,000 微积分  (23.80 积分)
```

### 算例 B — 预占

同模型，`estimated_input_tokens = 10,000`，`context = 200,000`，`max_output = 4,096`。

```text
max_input = min(200000−4096, ceil(10000×1.5)+2048) = min(195,904, 17,048) = 17,048

worst.input  = max(2, 0.1, 2.5, 0) = 2.5 USD/M = 2,500,000   ← 注意是 write 费率
worst.output = 10,000,000

numerator            = 17,048 × 2,500,000 + 4,096 × 10,000,000
                     = 42,620,000,000 + 40,960,000,000
                     = 83,580,000,000

reserved_micro_points = ceil(83,580,000,000 × 1000 × 22,000 / 1e10) = 183,876,000 微积分
max_cost_micro_usd    = 83,580
```

### 算例 C — 结算退差

```text
reserved = 183,876,000
charged  =  52,360,000   （算例 A）
refund   = 131,516,000
```

### 算例 D — 缓存保守口径

上游未报告 `cachedInputTokens`，`gpt-6.1-sol`。

```text
remaining_rate = max(input 2, cached 0.1) = 2 USD/M
               → 但 write 2.5 > 2，抬到 2.5 USD/M = 2,500,000
numerator = 12,000 × 2,500,000 + 1,500 × 10,000,000 = 45,000,000,000
charged   = 99,000,000 微积分
cost_status = conservative
```

对比算例 A（52,360,000）：保守口径**故意多算**，防止漏收。这是设计意图，不是 bug。

### 算例 E — 倍率与成本下限

```text
floorBps = ceil((10000+1000) × 10000 / (10000−5000)) = ceil(110,000,000 / 5,000) = 22,000

controller = 22,000, group = 8,000, model = 12,000
raw     = floor(22000 × 8000 × 12000 / 1e8) = floor(21,120) = 21,120
clamped = clamp(21,120, 10000, 50000) = 21,120
非补贴组 effective = max(21,120, 22,000) = 22,000   ← 被抬回成本下限
补贴组   effective = 21,120，写 subsidy_audit

对照：group = 10,000, model = 12,000 → raw = 26,400 → effective = 26,400（高于 floor，不变）
```

### 算例 F — 路由组 passthrough 预占取最贵

同算例 B 的输入规模，两个候选成员：

```text
gpt-6.1-sol      reserved =   183,876,000
claude-sonnet-5  reserved = 6,548,166,452   （worstIn = 116,352,000 即 writeHour）
group reserved (max)     = 6,548,166,452
```

若实际用 `gpt-6.1-sol` 结算 52,360,000，则退还 `6,495,806,452`。预占偏大是 passthrough 的固有代价。

### 算例 G — 长上下文

`gpt-6-luna`，`longThreshold = 272,000`，`longInclusive = true`。

```text
input = 300,000 >= 272,000 → 使用 longRates（input 0.2 / output 0.75 USD/M）
usage: input 300,000、output 1,000
numerator = 300,000 × 200,000 + 1,000 × 750,000 = 60,000,000,000 + 750,000,000
          = 60,750,000,000
charged   = 133,650,000 微积分
```

临界值测试：`input = 272,000` 用 longRates（inclusive），`input = 271,999` 用 base rates。

### 算例 H — 溢出边界（D-48）

单请求最坏情形：2,000,000 上下文、最贵费率 1010 USD/M、全量输出。

| `pointsPerCurrency` | `maxMultiplierBps` | 结果 |
| --- | --- | --- |
| 1,000 | 22,000 | 4,444,000,000,000 ✔ |
| 1,000 | 50,000 | 10,100,000,000,000 ✔ |
| 100,000 | 50,000 | 1,010,000,000,000,000 ✔ |
| 1,000,000 | 1,000,000 | 202,000,000,000,000,000 ✘ 溢出 |

**结论**：默认与常规策略都安全；但把 `pointsPerCurrency` 和 `maxMultiplierBps` 同时拉满会让最贵模型的单请求无法表示。因此新增保存时校验：

> **D-48** 保存 `billing_policy` 时，对每个已发布费率计算 `ceil(max(rate) × 该模型 maxContextTokens × pointsPerCurrency × maxMultiplierBps / 1e10)`，任一结果 > 2^53−1 则 `400 billing_price_limit`，拒绝保存。现有 `saveBillingPolicy` 已有类似的费率级校验（含 ×6 的 ultrafast 预留），本条把它扩展到**上下文维度**。

### 算例 I — 账本恒等式

```text
grants = 10,000,000,000
charged = 52,360,000
expired = 0
reserved = 183,876,000    （一笔在途）

左：grants − charged − expired = 9,947,640,000
右：available + reserved       = 9,947,640,000
成立
```

## 7. 对账

### 7.1 渠道对账

每日按渠道汇总 `cost_micro_usd`，与运营者上传的上游账单或 `newapi` 读取值比对。

- 偏差 > 5% → 告警
- **只告警，不自动改账**（D-28）
- 偏差原因分四类记录：汇率/币种、阶梯价、缓存字段缺失、上游计费口径差异

### 7.2 恒等式校验

每日 03:00 Asia/Shanghai 校验 `Σ grants − Σ charged − Σ expired = available + reserved`。

```text
Σ charged  只统计 state = 'settled' AND charged_micro_points IS NOT NULL
review 的冻结额在 reserved 侧，不重复计入 charged
```

不成立 → 告警 + 冻结该账户新请求（`enabled = false`，写审计原因），人工核实后恢复。

## 8. 幂等

### 8.1 作用域（D-26）

`(owner_user_id, token_id, endpoint, idempotency_key)`

- `idempotency_key` 长度 1–255，只允许 `[A-Za-z0-9._:-]`
- 保留 24 小时，过期记录由 `worker-settle` 清理
- 无 key 不去重

### 8.2 摘要与冲突

```text
digest = sha256(规范化 JSON(body))
规范化 = 键名字典序；去除 billing 字段；SSE/流标头不影响摘要
```

- 同 key + 同 digest + 请求已完成 → 返回首次结果（含 `x-ai-request-id`），**不重放付费调用**
- 同 key + 同 digest + 请求仍在执行 → 返回原请求 ID 与 `state`，不重放字节流
- 同 key + 不同 digest → `409 idempotency_key_reuse`
- 首次认领用 `INSERT ... ON CONFLICT DO NOTHING`，零行受影响则读获胜行

### 8.3 与账本的关系

幂等键**不替代**账本条件。即使幂等认领成功，预占仍需条件 UPDATE 成功才算准入。

## 9. 管理接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/operator/billing` | `{revision, policy, controller}` |
| POST | `/v1/operator/billing` | `{revision, reason, policy}`，revision 比较交换 |
| GET | `/v1/operator/billing/metrics` | 窗口指标、分模型统计、最近请求、只读费率 |
| GET | `/v1/operator/user-groups` | 分组与系数 |
| POST | `/v1/operator/user-groups` | 创建/修改，审计 |
| POST | `/v1/operator/accounts/:id/balance` | `{operationId, amountMicroPoints, reason}`，经 `fn_ai_adjust` |

**不提供**任何直接编辑 `available`/`reserved` 的接口或后台表单。

## 10. 客户端可见的错误

| HTTP / code | 何时 | 客户端行为 |
| --- | --- | --- |
| 402 `insufficient_balance` | 预占时余额不足 | 显示余额，停止自动重试 |
| 402 `budget_exceeded` | 预占额 > `billing.maxMicroPoints` | 重新报价或调整输出上限 |
| 429 `ai_busy` | 并发已满，未预占 | 按 `Retry-After` 排队 |
| 503 `ai_temporarily_unavailable` | 上游未响应前失败，已零扣费 | 稍后重发，不视为扣费 |
| 503 `ai_temporarily_busy` | 上游 429 且无候选 | 稍后重发 |
| 409 `idempotency_key_reuse` | 同 key 不同 body | 用新 key 或改回原 body |
| 400 `billing_amount_overflow` | 金额越界 | 联系运营者，不要重试 |

`x-ai-request-id` 只在预占成功后返回。鉴权/校验/余额/并发失败**不带**——客户端必须区分。

## 11. 与客户端协议的兼容

现有 `POST /v1/ai/quote` 与预算 `billing.maxMicroPoints` 的语义**完全不变**。本设计只新增：

- `POST /v1/ai/quote` 响应增加 `multiplierBreakdown: {controllerBps, groupFactorBps, modelFactorBps, effectiveBps, floorBps}`（可选字段，老客户端忽略）
- 请求头新增 `Idempotency-Key`、`x-hezuo-conversation-id`（可选）
- 模型目录中路由组以普通模型 ID 出现，价格模式由 `pricingMode: "passthrough"|"fixed"` 标识

老客户端不改代码即可工作。
