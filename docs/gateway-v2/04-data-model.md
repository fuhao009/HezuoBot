# 04 · 数据模型

完整 DDL 见 [schema.sql](schema.sql)。本文解释设计意图、约束理由、状态机和迁移映射。

## 1. 通用约定

| 约定 | 规则 |
| --- | --- |
| 主键 | `BIGSERIAL`（内部对象）或 `TEXT`（对外暴露的 ID，如 `ai_request.id`、`bot.id`）。对外 ID 用 UUIDv7 文本，可排序且不泄露数量。 |
| 金额 | `BIGINT`，`CHECK (x BETWEEN 0 AND 9007199254740991)`。**不用 `NUMERIC`**（D-02）。 |
| 时间 | `TIMESTAMPTZ`。业务展示统一 `Asia/Shanghai`，存储一律 UTC。 |
| 枚举 | 用 `TEXT + CHECK`，不用 PG `ENUM` 类型——加值不需要 `ALTER TYPE`，迁移更可控。 |
| 软删 | 只有 `account`、`channel`、`public_model`、`bot` 有 `enabled`/`status`；账本与审计**永不删除**。 |
| 审计 | `config_audit`、`ledger_entry`、`exam_audit`、`moderation_action`、`ai_billing_policy_audit`、`subsidy_audit` 只追加。 |

## 2. 表分组

### 2.1 上游与路由

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `provider` | `id, kind, name, base_url, enabled, revision` | `kind` 五值枚举 |
| `channel` | `id, provider_id, base_url, protocols, priority, weight, enabled, group_tags, revision` | `protocols` 用 `TEXT[]` |
| `channel_key` | `id, channel_id, encrypted_value, kid, status, cooldown_until, quota_hint, concurrency_limit, revision` | `encrypted_value` 是 `enc:v1:...` |
| `channel_model` | `channel_id, upstream_model, public_model_id, cost_rates, long_rates, long_threshold, long_inclusive` | 主键 `(channel_id, upstream_model)` |
| `public_model` | `id, label, protocols, context_tokens, output_tokens, capabilities, enabled, examinable, model_factor_bps, primary_channel_id, revision` | `id` 是客户端可见 ID |
| `route_group` | `id, strategy, constraints, pricing_mode, fixed_price_micro_points, enabled, revision` | `id` 形如 `group/xxx` |
| `route_group_member` | `group_id, member_type, member_id, weight, position` | 多态引用，应用层校验 |
| `channel_event` | `channel_id, key_id, from_status, to_status, reason, status_code, at` | 无响应正文 |
| `config_audit` | `actor_id, object_type, object_id, from_revision, to_revision, before_json, after_json, reason, request_id, at` | `before/after` 已脱敏 |

**为什么 `channel_model` 用 `(channel_id, upstream_model)` 作主键**：一个渠道可以同时提供多个公开模型，且同一上游模型在不同渠道的成本价可以不同。成本价必须跟着渠道走，不能挂在 `public_model` 上。

**为什么 `route_group_member` 用多态**：成员可以是模型也可以是组。用两列（`member_type` + `member_id`）而不是两个可空外键，避免"两列都填/都不填"的非法状态。参照完整性由应用层 + 创建时校验保证，**不用数据库外键**（PG 无法对多态外键做约束）。这是有意的取舍：牺牲 DB 层参照完整性，换取递归结构的简洁。所有写入路径必须走 `studio`/`admin` 的校验函数，禁止直接写表。

### 2.2 账户与账本

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `account` | `id, email, user_group_id, enabled, activated_at, created_at` | |
| `user_group` | `id, name, group_factor_bps, allow_below_floor, limits, allowed_models` | `limits` 是 JSONB：并发、日请求、日积分 |
| `balance` | `owner_user_id PK, available, reserved, updated_at` | **只有函数能写**（D-02 配套权限） |
| `ai_token` | `id, owner_user_id, lookup_id, secret_hash, device_id, expires_at, revoked_at` | 模型令牌，只存哈希 |
| `ai_request` | 见 2.3 | 账本核心 |
| `request_attempt` | `request_id, attempt_no, channel_id, key_id, outcome, status_code, ttfb_ms, total_ms, affinity_broken, at` | 每次上游尝试一行 |
| `ledger_entry` | `id, owner_user_id, kind, amount_micro_points, request_id, reason, actor_id, op_id, created_at` | 只追加 |
| `ai_idempotency` | `owner_user_id, token_id, endpoint, idempotency_key, digest, request_id, created_at` | 唯一约束 |
| `points_bucket` | 二期套餐用，一期建表但不使用 | |
| `subsidy_audit` | `owner_user_id, request_id, floor_bps, applied_bps, actor_id, at` | 补贴组低于 floor 时写 |

### 2.3 `ai_request` 列设计

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | TEXT PK | UUIDv7 |
| `owner_user_id` | TEXT | |
| `token_id` | TEXT | 无外键（吊销令牌不能删历史） |
| `model` | TEXT | 客户端请求的模型（可能是 `group/…` 或 `auto-chat`） |
| `selected_model` | TEXT | 实际公开模型 |
| `endpoint` | TEXT | `chat` / `responses` |
| `state` | TEXT | `reserved/streaming/review/settled` |
| `pricing_version` | TEXT | 展示用价格版本串 |
| `input_rate/cached_rate/output_rate` | BIGINT | 展示费率快照（微积分/百万 token） |
| `max_input_tokens/max_output_tokens` | BIGINT | 预占依据 |
| `reserved_micro_points` | BIGINT | 准入冻结额，**永不修改** |
| `charged_micro_points` | BIGINT NULL | 终态才有 |
| `input_tokens/cached_input_tokens/output_tokens` | BIGINT NULL | 可信 usage |
| `cache_write_tokens/cache_write_hour_tokens` | BIGINT NULL | 缓存写入 |
| `billing_snapshot` | JSONB | **不可变**，见下 |
| `cost_micro_usd` | BIGINT NULL | 采购成本估算 |
| `cost_status` | TEXT | `estimated/conservative/unknown` |
| `settlement_reason` | TEXT | ≤200 字符 |
| `channel_id/key_id` | TEXT | 实际最终尝试的渠道与密钥 |
| `route_group_id` | TEXT NULL | 走了路由组时记录 |
| `concurrency_slot` | — | 不用列；并发靠状态计数查询 |
| `created_at/updated_at/settled_at` | TIMESTAMPTZ | |

`billing_snapshot` 一旦写入不可变（触发器 `ai_request_snapshot_immutable`）。它包含：策略 revision、`pointsPerCurrency`、`multiplierBps`（合成后的 effective）、`tariffId`、`complexity/score/reasons`、`rates/longRates/longThreshold/longInclusive`、`reservedMicroPoints`、`maxCostMicroCurrency`、`startedAt`、`serviceTier`、`channelId`。

**为什么不把倍率拆成三列**：倍率合成规则会演进（比如未来加更多系数）。快照存 JSONB 可保留当时的完整合成依据，比若干列更耐变化，且它只读不查。需要按倍率聚合的场景用 `effective_bps` 单独冗余一列（有索引）。

### 2.4 状态机

```text
                  ┌──────────────┐
   准入成功 ──────►│   reserved   │
                  └──────┬───────┘
        写出首字节         │
                  ┌──────▼───────┐
                  │  streaming   │
                  └──┬────────┬──┘
       结算成功       │        │  断流/用量异常/超时
             ┌───────▼──┐  ┌──▼────────┐
             │ settled  │  │  review   │
             └──────────┘  └───┬───────┘
                               │ 人工向下调整
                          ┌────▼─────────┐
                          │   settled    │
                          └──────────────┘
```

合法迁移：

| 从 | 到 | 允许 |
| --- | --- | --- |
| `reserved` | `streaming` | ✅ 写出首字节 |
| `reserved` | `settled` | ✅ 上游快速失败、零扣费释放 |
| `reserved` | `review` | ✅ 准入后异常 |
| `streaming` | `settled` | ✅ 正常结算 |
| `streaming` | `review` | ✅ 断流、usage 异常、超时 |
| `review` | `settled` | ✅ 人工结算 |
| `settled` | 任意 | ❌ |
| `review` | `reserved`/`streaming` | ❌ |

数据库用触发器强制（`ai_request_state_transition`），应用层同规则。

### 2.5 Bot 与市场

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `developer` | `account_id PK, verified, created_at` | 任何注册用户都有一行 lazily 创建 |
| `bot` | `id, owner_id, slug UNIQUE, category, status, created_at` | `slug` 全局唯一（D-46 段） |
| `bot_version` | `id, bot_id, semver, bot_hash, package_ref, market_manifest, lint_report, created_at` | **不可变**；`(bot_id, semver)` 唯一 |
| `bot_model_claim` | `bot_version_id, model_id, claims` | `(bot_version_id, model_id)` 唯一 |
| `exam_suite` | `id, category, suite_version, status` | |
| `exam_case` | `id, suite_id, definition, weight, difficulty, visibility, tags` | `visibility ∈ {public, hidden}` |
| `exam_quote` | `id, bot_version_id, model_id, estimated_points, max_cost_points, expires_at, confirmed_at` | D-40 |
| `exam_run` | `id, quote_id, bot_version_id, model_id, suite_version, upstream_fingerprint, state, budget_micro_points, budget_used, total_score, dimension_scores, gate_failed, gate_reason, report_ref, started_at, finished_at` | 身份四元组见 D-43 |
| `exam_case_result` | `exam_run_id, case_id, variant, run_no, passed, score, trace_ref, failure_summary` | 唯一 `(exam_run_id, case_id, variant, run_no)` |
| `listing` | `id, bot_id, model_id, bot_version_id, state, level, score, exam_run_id, valid_until, stale_since` | `(bot_id, model_id)` 唯一 |
| `install` | `id, account_id, bot_id, bot_version_id, model_id, installed_at` | |
| `feedback` | `id, install_id, rating, reason, created_at` | 一期建表不使用（M6） |
| `report` | `id, listing_id, reporter_id, reason, category, state, created_at` | `category ∈ {safety, quality, other}` |
| `moderation_action` | `id, object_type, object_id, action, actor_id, reason, at` | 只追加 |
| `exam_audit` | `id, exam_run_id, action, actor_id, reason, at` | 只追加 |
| `rubric_model_allowlist` | `model_id, enabled` | 评分模型白名单 |

### 2.6 运维

`outbox`、`config_sequence`、`worker_lease`、`reconcile_run`。

## 3. 关键约束

### 3.1 金额与余额

```sql
-- balance 只能通过函数写
CHECK (available BETWEEN 0 AND 9007199254740991)
CHECK (reserved  BETWEEN 0 AND 9007199254740991)
```

`fn_ai_reserve` / `fn_ai_settle` / `fn_ai_release` / `fn_ai_adjust` 四个函数是**唯一**写入路径。`hezuo_app` 角色对 `balance` 只有 `SELECT`。

### 3.2 不可变快照

`ai_request.billing_snapshot` 与 `bot_version` 的 `bot_hash`、`package_ref` 在 UPDATE 时被触发器拒绝修改。

### 3.3 状态迁移

触发器比较 `OLD.state` 与 `NEW.state`，非法迁移 `RAISE EXCEPTION`。

### 3.4 幂等唯一

```sql
UNIQUE (owner_user_id, token_id, endpoint, idempotency_key)
```

`ledger_entry.op_id` 按业务类型分作用域唯一：`UNIQUE (kind, op_id)`，允许同一 `op_id` 在不同 `kind` 下存在（预占/结算/退款各是一次独立操作），但同 `kind` 内重复即冲突。

### 3.5 listing 唯一

```sql
UNIQUE (bot_id, model_id)
```

一个 Bot 在一个模型上只有一条 listing。活跃版本变更时更新该行的 `bot_version_id`，不新增行。

## 4. 索引

| 表 | 索引 | 用途 |
| --- | --- | --- |
| `ai_request` | `(owner_user_id, created_at DESC, id DESC)` | 流水分页 |
| `ai_request` | `(state, created_at)` WHERE `state IN ('reserved','streaming')` | 超时扫描（部分索引） |
| `ai_request` | `(created_at DESC, id DESC)` WHERE `billing_snapshot IS NOT NULL` | 计费指标窗口 |
| `request_attempt` | `(request_id, attempt_no)` | 故障切换明细 |
| `channel_event` | `(channel_id, at DESC)` | 后台状态灯 |
| `ledger_entry` | `(owner_user_id, created_at DESC, id DESC)` | 流水 |
| `exam_run` | `(state, created_at)` | 队列深度 |
| `exam_case_result` | `(exam_run_id)` | 成绩单 |
| `listing` | `(state, model_id, score DESC)` | 市场列表 |
| `outbox` | `(available_at) WHERE claimed_at IS NULL` | dispatcher |

## 5. 迁移映射（D1/SQLite → PG）

现有 `gateway/control-plane/migrations/` 的表需映射。这是 M0 的交付物，必须先盘点实际 schema 再执行。

| 现有 D1 | 新 PG | 处理 |
| --- | --- | --- |
| `account_ai_balances` | `balance` | `available_micro_points` → `available`、`reserved_micro_points` → `reserved`；均为微积分，逐账户核对；`enabled/activated_at` 属于新 `account`，不能遗漏 |
| `account_ai_tokens` | `ai_token` | 直接映射 |
| `account_ai_requests` | `ai_request` | 增加 `selected_model`、`route_group_id`、`effective_bps`；`billing_snapshot` 由 TEXT 转 JSONB |
| `account_ai_adjustments` | `ledger_entry` | `kind` 映射：`grant/enable/disable/settle` → 同名 + 新增 `reserve/settle_refund/substitute` |
| `ai_channel_catalog`（`snapshot_json` 单行） | `provider`+`channel`+`channel_key`+`channel_model`+`public_model` | **拆表**。公开模型 ID 必须保持不变 |
| `ai_billing_policy` | `billing_policy` | JSONB 化；`multiplier_bps` 保留 |
| `ai_billing_policy_audit` | `billing_policy_audit` | 直连 |
| `ai_channel_audit` | `config_audit` | 合并，`object_type='channel_catalog'` |

#### 5.0.1 设计边界与共同规则

当前 18 个迁移文件离线重放得到 26 张业务表；上表覆盖 8 张，其余 18 张的设计去向在下表逐项确定。设计决策已定，不再以“尚无映射”阻塞设计；**所有行的实施状态均为「待上线门禁」**，不构成生产/现网切换签署，也不代表部署 D1 已核对、T0 已验收。本节仅定义目标，不执行迁移、不导出 D1 数据、不修改 `schema.sql`。

- 新 PG `public.account` 是业务账户；新增 `identity` schema 存认证身份/凭据，新增 `device` schema 存设备安装/端点。下表新增对象尚未落入 DDL，DDL、权限、认证适配与迁移实现均为**待上线门禁**。`public.install` 是市场 Bot 安装记录，不得用来接收设备安装。
- 既有用户、安装、凭据 ID 原样保留。旧 `user.id` 是业务主体键，映射到 `identity.auth_user.id = public.account.id`；旧 `account.id` 仅是认证凭据行 ID，绝不能用作新业务账户 ID。用户外键均按旧 `user.id` 关联；发现孤儿、重复身份或邮箱唯一冲突即阻断，不自动合并账户或丢弃行。
- 认证 camelCase 字段按下表转换为 snake_case，由认证适配层显式绑定。旧认证 `date` 列需按适配器实际存储格式验证；安装、端点、审计的 epoch 毫秒转 UTC `TIMESTAMPTZ`（毫秒除以 1000），空值仍为空，不得猜秒/毫秒。部署格式核验与逐列对账为**待上线门禁**。
- 密码只保留既有哈希，不解密、不重哈希未知明文；OAuth/推送秘密以独立用途密钥加密，迁移日志与普通审计不得包含密码哈希、令牌或密文正文。身份凭据与设备秘密仅授予专用服务角色，`hezuo_app` 不得泛读。旧 D1 在切换后隔离只读保留，限制为迁移核验与审计用途，不再作为在线认证回退或双写目标；保留期与受控销毁为**待上线门禁**。

#### 5.0.2 十八张表的逐表去向

| 旧 D1 表 | 决策与列级映射要点 | 理由 | 备选方案及不采用原因 | 实施状态 |
| --- | --- | --- | --- | --- |
| `user` | 迁至 `identity.auth_user`，并投影到 `public.account`。`id/name/email/emailVerified/image/createdAt/updatedAt` → `id/name/email/email_verified/image/created_at/updated_at`，验证位转布尔；`public.account.id/email/created_at/updated_at` 取同一用户，`user_group_id='default'`。业务账户 `enabled` 仅在 `account_ai_balances.enabled=1` 且生命周期未禁用/删除时为真，无余额行默认假；`activated_at` 取余额表。删除用户的认证/业务邮箱使用同一个无冲突匿名标识，`deleted_at` 取有效删除审计时间，缺失则门禁失败。 | 保留用户 ID 与登录资料，区分“可登录身份”和“已开通 AI 业务”。 | 将全部资料塞进 `public.account`：混淆认证资料与账本主体；重新注册：破坏所有权与历史关联。 | 待上线门禁 |
| `account` | 迁至 **`identity.auth_credential`**，不直接写 `public.account`。`id/accountId/providerId/userId` → `id/provider_account_id/provider_id/user_id`，后者引用 `identity.auth_user.id`；`password` → `password_hash` 原样保留哈希；`accessToken/refreshToken/idToken` → `access_token_encrypted/refresh_token_encrypted/id_token_encrypted`，逐项用途加密；`accessTokenExpiresAt/refreshTokenExpiresAt/scope/createdAt/updatedAt` → `access_token_expires_at/refresh_token_expires_at/scope/created_at/updated_at`。保留认证提供商唯一约束语义。 | 登录凭据与业务账户隔离，避免同名复制、密码泄漏及主体错配。 | 原表同名复制：明确禁止；全部强制重绑登录：不必要地中断密码和 OAuth 登录。 | 待上线门禁 |
| `session` | **不迁移活动会话**。`id/token/userId/expiresAt/createdAt/updatedAt/ipAddress/userAgent` 均不导入 PG；切换后 `identity.auth_session` 从空表签发新会话，原会话与旧签名/验证路径停止接受。 | 避免跨运行时沿用旧 bearer 会话，建立明确的认证失效边界。 | 原样迁移 session：扩大旧 token 风险且依赖旧适配器兼容；D1 在线校验：形成双库认证回退。 | 待上线门禁 |
| `verification` | **不迁移**。`id/identifier/value/expiresAt/createdAt/updatedAt` 不复制；新 `identity.auth_verification` 为空，旧验证码、重置链接、验证流程全部失效，用户重新发起。 | 一次性证明不跨切换复用，避免重放或已消费状态丢失。 | 只迁未过期值：仍存在消费竞态与令牌格式兼容风险。 | 待上线门禁 |
| `rateLimit` | **不迁移** `id/key/count/lastRequest`；新认证限流存储从空状态启动，但对旧限流覆盖的路由执行下述冷启动保护。 | 运行时计数非业务记录，不绑定旧库适配器；不能借清空计数获得额外尝试。 | 复制计数到 PG：将旧认证限流实现固化进新平台；无保护直接清空：允许跨切换暴力重试。 | 待上线门禁 |
| `account_lifecycle` | 迁至 `identity.account_lifecycle`，`user_id/disabled/deleted/password_change_required` 同名映射，三个位转布尔，`user_id` 引用认证用户；同时将禁用/删除状态投影到 `public.account.enabled=false`，删除时间/匿名邮箱按 `user` 行规则处理；`password_change_required` 继续在认证入口强制执行，不能当成普通资料字段忽略。 | 防止已封禁、已删除或待改密账户在迁移后复活，保留认证与业务双层控制。 | 只映射业务 `enabled`：丢失登录禁用与强制改密语义。 | 待上线门禁 |
| `account_lifecycle_audit` | 迁至只追加 `identity.account_lifecycle_audit`。`operation_id/operator_user_id/user_id/kind/reason/body_hash/created_at` 同名保留、时间转换；操作者 ID 保留历史值，不因操作者删除而级联抹除。**`password_hash` 不迁到 PG**，旧值仅随隔离只读 D1 保留，不能继续以插入审计触发密码修改；迁移来源/摘要另作受限核验记录。 | 保留封禁、删除、改密历史与幂等标识，去除历史秘密和旧隐式副作用。 | 复制含密码哈希的审计触发器：泄漏秘密并可能重放改密；只留旧库不迁审计：新后台无法连续追溯。 | 待上线门禁 |
| `installations` | 迁至 `device.installation`。`id/owner_user_id/client_instance_id/display_name/platform/app_version/created_at/updated_at/last_seen_at/last_rotation_at/revoked_at` 同名映射，时间转换；`owner_user_id` 引用 `public.account.id`，保留 owner/client 唯一性、撤销状态和历史安装 ID。 | 保持现有设备所有权与重连能力，与市场 Bot `public.install` 分离。 | 映射到市场 `install`：对象含义不符；强制重新绑定全部设备：丢失既有安装关联。 | 待上线门禁 |
| `installation_credentials` | 迁至 `device.installation_credential`。`id/installation_id/lookup_id/secret_hash/created_at/expires_at/last_used_at/revoked_at` 同名映射；保留哈希、查找键和失效/撤销时间，不恢复明文、不延长有效期，`installation_id` 引用设备安装；旧库认证路径停用。 | 在切换后保持设备协议连续，又不引入凭据明文。 | 全部吊销并重发：可作泄漏事件应急手段，本次正常迁移不采用，以免无人值守设备失联。 | 待上线门禁 |
| `installation_endpoints` | 迁至 `device.installation_endpoint`。`installation_id/hostname/tunnel_name/tunnel_id/dns_record_id/status/generation/provider_account` 同名保留；`last_reconciled_at/delete_requested_at/last_error_code/created_at/updated_at/cleanup_attempts/last_cleanup_attempt_at/reclaim_requested_at` 同名映射、时间转换。`lease_owner/lease_expires_at` 清空，仅在旧 worker 停止且原租约已失效后导入；旧 `provisioning` 归 `pending` 重对账，其余状态保留，按资源 ID 接管而非盲目创建。**不对安装或账户设置级联删除**，包括孤立端点也须保留以清理远端资源。 | 不能遗失 Tunnel/DNS 清理凭据与失败重试历史，防止重复创建或双 worker 接管。 | 重新创建端点：可能产生孤儿资源、重复 DNS 与费用；强外键级联删除：抹除清理线索。 | 待上线门禁 |
| `installation_push_devices` | 迁至 `device.installation_push_device`。`installation_id/token_hash/environment/created_at/updated_at/last_sent_at` 同名映射；`token` → `token_encrypted`，保持原 `(installation_id, token_hash)` 主键语义与环境边界；已撤销安装不发送推送，解密及环境匹配验证通过前暂停发送。 | 保留移动通知注册关系，避免原始推送 token 落普通业务表。 | 全部丢弃等待客户端重注册：离线设备可能长期丢失通知。 | 待上线门禁 |
| `managed_endpoint_capacity` | **不迁移派生快照**。`id/scan_page/tunnel_count/dns_record_count/reclaim_pending/checked_at/capacity_rejected_at/capacity_rejected_code/updated_at` 不复制；由新端点协调器按提供商重新完整扫描，结果写 `device.endpoint_capacity`，扫描完成前拒绝新建端点但继续清理。 | 旧分页游标与容量计数无法证明切换时资源总量，不能作为准入依据。 | 原样迁移快照：易造成过量准入或永久假性满额。 | 待上线门禁 |
| `managed_endpoint_account_capacity` | **不迁移派生快照**。`provider_account` 作为提供商账号关联键从端点/部署配置恢复；`scan_page/tunnel_count/dns_record_count/reclaim_pending/dormant_endpoints/checked_at/capacity_rejected_at/capacity_rejected_code/updated_at` 重新扫描计算，结果写 `device.endpoint_account_capacity`，不得把旧 `scan_page` 当恢复游标。 | 多提供商账号必须逐账号核算，历史计数不具有资源所有权事实效力。 | 沿用旧账号快照：漏计休眠端点和切换期间的外部变化。 | 待上线门禁 |
| `control_action_rate_limits` | **不迁移** `user_id/action/window_started_at/attempts/updated_at`；新账户动作限流按原 `user_id + action` 语义初始化，并执行冷启动保护。 | 保留防滥用边界但不把临时窗口当永久业务数据。 | 同名复制到 PG：保留旧时间窗口实现且增加状态搬运；裸重置：可绕过操作频控。 | 待上线门禁 |
| `installation_action_rate_limits` | **不迁移** `installation_id/action/window_started_at/attempts/updated_at`；新设备动作限流保留 `installation_id + action` 隔离维度，端点变更入口执行冷启动保护。 | 防止账户限流误替代设备限流，也避免切换获得新操作额度。 | 合并进账户计数：不同设备相互影响且弱化安装认证边界。 | 待上线门禁 |
| `otp_recipient_rate_limits` | **不迁移** `recipient_key/window_started_at/attempts/updated_at`；新 OTP 收件人限流重新计算受保护的收件人键，发送入口执行冷启动保护；禁止把 `recipient_key` 当作邮箱反解/导出。 | 临时计数不应延续旧键派生实现，验证码发送不能因切换放大。 | 复制旧收件人键：新旧键算法不一致时会产生两套限流；仅按 IP 限流：无法覆盖分布式攻击同一收件人。 | 待上线门禁 |
| `highlevel_flows` | **不迁移在线流程**。`lookup/ciphertext/created_at/claimed_at/callback_at` 均不导入 PG，旧回调停止接收；切换前停止创建并允许有限排空，剩余流程失效，返回受控失败并要求重新发起；旧密文只留隔离只读 D1，不自动解密重放。 | 该表承载短期敏感流程，缺少新版对应契约，复制 claimed/callback 状态不能保证恰好一次。 | 原样搬迁后续跑：依赖旧密钥和外部回调，可能重放；长期保留旧写服务：违反只读和单写边界。 | 待上线门禁 |
| `highlevel_ip_rate_limits` | **不迁移** `ip_key/action/window_started_at/attempts/updated_at`；旧流程入口关闭，新平台如提供替代流程必须使用自己的 IP/动作限流并执行冷启动保护，不延用旧 `ip_key`。 | 不为退役流程引入永久运行依赖，同时不允许替代入口通过换实现绕过冷却。 | 迁移旧 IP 桶：旧流程已经退役，保留其派生键无业务收益。 | 待上线门禁 |

#### 5.0.3 待上线门禁（非生产切换签署）

1. **待上线门禁：DDL 与适配。** 后续单独实现 `identity`、`device` 对象、索引/唯一约束、最小角色权限和审计不可变保护，并验证认证适配器、密码哈希算法、令牌加密/轮换和历史 ID 关联。本轮不修改 `schema.sql`；表级设计已定不等于数据库可直接部署。
2. **待上线门禁：部署核验与数据对账。** 单独授权执行阶段再核对实际部署 schema、数据格式、全表行数与摘要；验证用户/业务账户一对一、账户禁用与删除优先级、凭据有效期、端点资源 ID、余额与账本恒等式。不迁移的表不向 PG 复制，仍随旧 D1 受限只读保留；不一致不得切换，不因本节设计决策自动批准导出或迁移。
3. **待上线门禁：冷启动保护。** 所有不迁移的限流表对应入口，先停旧写入口，再等待各入口实际配置的最长有效限流窗口届满，新服务在此期间拒绝相应敏感操作；OTP 还须覆盖发送冷却窗口。窗口长度由旧运行配置与代码核验，不臆造常量、不回退到无限流。验证新限流已启用后才开放入口；普通请求是否开放不得绕过相同操作入口。
4. **待上线门禁：单写与恢复。** 旧认证会话/验证码/流程失效、旧安装认证与端点 worker 停写、原租约失效、新端点资源扫描、推送解密验证均通过后才允许接管。旧库只读，不做双写或旧会话回退；PG 产生新账本写入后禁止直接切回 D1。生产切换、迁移执行、D1 导出和最终放行均未签署。

### 5.1 迁移硬门禁

1. 导出 D1 全表，记录行数与摘要。
2. 导入 PG 后校验：逐账户余额相等、请求状态计数相等、`Σ grants − Σ charged − Σ expired` 恒等式成立、渠道密钥可解密（用主密钥试解第一条并核对长度）。
3. **任一不一致不切换。**
4. 停服窗口内切换，旧库只读保留，不可双写。
5. PG 已发生新账本写入后，**不得直接切回旧库**（01 §6.5）。

### 5.2 触发器改写

D1 的触发器改为 PG 的"单事务 + 行锁/条件 UPDATE"：

| 原 SQLite 机制 | PG 实现 |
| --- | --- |
| `BEFORE INSERT ... RAISE(ABORT)` 限流（令牌每设备 2 个） | `CONSTRAINT` 无法表达；改用 `fn_issue_ai_token` 内 `SELECT ... FOR UPDATE` + 计数 |
| `AFTER INSERT ON account_ai_adjustments` 驱动结算 | 改为应用层显式调用 `fn_ai_settle`，**去掉隐式触发器**（隐式副作用难排查） |
| `BEFORE UPDATE` 防篡改（`billing_snapshot` 不可变） | 保留为 PG 触发器 `ai_request_snapshot_immutable` |
| `AFTER INSERT/UPDATE ON ai_channel_catalog` 审计 | 保留为 `config_audit` 触发器 |

**为什么去掉结算的隐式触发器**：原实现靠"插入调整行自动结算"，读代码时看不出结算发生在哪。PG 版本改为显式函数调用，`fn_ai_settle` 内部完成锁、写 usage、写流水、置终态，可读可测。

## 6. 数据保留

| 数据 | 保留 | 清理方式 |
| --- | --- | --- |
| `ai_request` / `ledger_entry` | 永久 | 不删 |
| `request_attempt` | 90 天 | 分区表按 `at` 月分区，`DROP PARTITION` |
| `exam_case_result` | 永久 | 不删（成绩证据） |
| 调试 trace | 30 天 | `worker-settle` 删对象 + 清引用 |
| 考试 trace | 180 天 | 同上 |
| `ai_idempotency` | 24 小时 | 定时删除 |
| `outbox` | 7 天（已投递） | 定时删除 |
| 通知/审计 | 永久 | 不删 |

删除用户账户时：`account.enabled=false`、邮箱替换为匿名标识、`ai_token` 全部吊销，**账本与审计保留**。这与现有 `account-lifecycle.ts` 的行为一致。
