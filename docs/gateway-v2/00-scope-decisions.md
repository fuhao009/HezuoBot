# 00 · 范围、里程碑与决策记录

本文把原稿 `gateway-v2-and-bot-market.md` 中所有「建议 / 待确认」项收敛为**已拍板决定**。开发方按本表实现，不需要再回来确认参数。

---

## 1. 一期范围

一期 = **M1–M5**，即网关 + 计费 + Bot Studio + 考试与市场，一次性交付。

M6（作者分成、套餐、意图路由、使用反馈驱动复考）**不进一期**，一期只做免费 Bot。理由与影响见 D-13、D-14。

不在范围：

- Windows / macOS 作为服务端部署（服务端统一 Linux）。
- 协议转换。一期只支持 OpenAI-compatible Chat Completions 与 Responses；不声称把 Anthropic / Gemini 原生协议转成 OpenAI 格式。
- 多租户隔离。网关运营方是信任边界，不是任意租户的 URL 代理。
- 复制 New API / Magpie 代码（见 D-45）。

## 2. 里程碑

| 里程碑 | 内容 | 出口条件（摘要，完整判据见 08） |
| --- | --- | --- |
| **M0** 契约基线 | 本目录评审通过；现有协议/包格式/计价函数盘点完成；隔离环境就绪 | 08 的验收矩阵可执行；迁移映射表签署 |
| **M1** 上游与路由 | PG 迁移、供应商/渠道/密钥、健康熔断、`order/weighted/rotate`、首字节前故障切换、会话粘滞 | 主渠道人为 5xx/429 时自动切备用，用户只扣一次；流中断不重试并按实际用量结算 |
| **M2** 计费升级 | 用户分组与系数、模型加成、单事务预占结算、幂等、对账、恒等式校验 | 1000 并发无负余额；同幂等键不重复扣费；03 的 5 个算例逐位一致 |
| **M3** 混合与 newapi | 路由组（含嵌套）、`cost/latency/usage/quota`、`newapi` 同步、管理后台上游/路由/定价页 | passthrough 按实际成员计价、预占取最贵候选；试算与实际选路一致 |
| **M4** Bot Studio | 包 v3、版本、工作台、Trace、模型对比、沙箱、CLI | 沙箱内用真实模型跑完含工具调用的用例；无法访问非白名单网络与宿主文件 |
| **M5** 考试与市场 | 题库、调度、评分、闸门、防作弊、有效期重考、市场前台、审核举报 | 一个 Bot 对两模型各出一分；硬编码答案被检出或在保密题失分；内容变更后旧成绩自动失效 |

M1 上线前必须具备**不低于现状**的安全预占/结算。不允许"M1 先破计费不变量、M2 再补"。

## 3. 决策记录

格式：`D-编号 · 决定`。每条给**结论**，以及在被推翻时需要付出的成本。
「原稿」列指向 `gateway-v2-and-bot-market.md` 的对应小节。

### 3.1 技术选型与部署

| # | 决定 | 推翻成本 | 原稿 |
| --- | --- | --- | --- |
| **D-01** | 实现语言 **TypeScript，Node 24 LTS**。理由：可直接复用 `packages/shared/task-billing.ts` 的 BigInt 计价、`package-format.ts` 的 zod schema，计价和包校验只有一份实现，不会漂移。 | 高。换语言要把计价公式、包格式校验、缓存分区规则在两端各实现并做一致性测试。 | 1 |
| **D-02** | 数据库 **PostgreSQL 16**。所有金额与 token 计数用 `BIGINT`，上限 `9007199254740991`（2^53−1），与 Node 安全整数同一上界。不用 `NUMERIC`（PG 的 numeric 无此上界，会掩盖溢出）。 | 中。schema 需重写，但账本语义不变。 | 1、7 |
| **D-03** | 缓存与队列 **Redis 7**（Streams 做队列，不用 BullMQ，减少一层依赖）。Redis **只承载可重建状态**：限流计数、会话粘滞、熔断窗口、队列。余额、幂等键、考试成绩、审计**一律只在 PG**。 | 低。 | 1 |
| **D-04** | 对象存储用**本地磁盘** `/var/lib/hezuo-gateway/objects/`，按内容哈希分片（`ab/cd/<sha256>`）。一期不引 MinIO。 | 低。抽象层 `storage.put/get/stat` 已隔离，后续换 S3/MinIO 只需换实现。 | 1 |
| **D-05** | 进程模型：每个 `*-api` / `worker-*` 一个独立 systemd 单元，**全部无状态**，状态只在 PG/Redis/对象存储。运行用户 `hezuo`（非 root），配置走 `EnvironmentFile`（0600）。 | 低。 | 1、10 |
| **D-06** | 反向代理 **Caddy**（自动 TLS 更简单），内部通信走 Unix socket 或 127.0.0.1。内网部署沿用现有 `--gateway-ca` 自签 CA 流程。 | 低。 | 10 |

### 3.2 上游与路由

| # | 决定 | 推翻成本 | 原稿 |
| --- | --- | --- | --- |
| **D-07** | 上游三层：`provider → channel → channel_key`。一个渠道可挂多个公开模型映射（`channel_model`）。**一个公开模型可以同时映射到多个渠道**（原稿是"每个公开模型明确绑定一个渠道"，这里放开，否则多上游冗余做不到）。公开模型的默认渠道由 `public_model.primary_channel_id` 指定，其余渠道作为同模型的其他候选。 | 中。放开后需要处理"同模型多渠道"的价格差异，已由 D-16 覆盖。 | 2.1、gateway-channels.md |
| **D-08** | 密钥加密：AES-256-GCM，主密钥 `HEZUO_MASTER_KEY`（32 字节 base64）来自环境变量，**不进数据库、不进 Git、不进日志**。域分离：`HKDF(master, info="hezuo/channel-key/v1")`。每条密文存 `{kid, iv, ct, tag}`，`kid` 支持主密钥轮换。 | 中。轮换要用 `kid` 做双密钥过渡期，已在 schema 预留。 | 2.1、gateway-channels.md |
| **D-09** | 换 `base_url` 必须重新输入密钥，同事务提交。只改密钥不改地址时，旧密钥保留语义取消——**一律要求显式提供新密钥**，不做"同 ID 同 URL 时留空即保留"。 | 低。运营体验稍差，但杜绝了旧凭据被送往新主机的整类风险。 | 2.1、2.5 |
| **D-10** | 冷却结束探测用 **Redis 原子租约** `SET probe:{channel}:{key} 1 NX PX 30000`，只允许 1 个探测请求。手动 `disabled` 优先于自动恢复，自动流程不得把人工停用改回可用。 | 低。 | 2.5 |
| **D-11** | 健康探测节奏：`/models` 每 60 秒；真实推理探测每 10 分钟，用 `max_output_tokens=1` 的最小请求，单渠道每小时成本上限 `probe_cost_cap_micro_usd`（默认 1000 微美元 = 0.001 USD）。探测成本计入运营成本，**永不计入用户扣费**。 | 低。 | 2.3 |
| **D-12** | 熔断参数：滑动窗口 5 分钟；连续 5 次可重试错误 **或** 窗口成功率 < 50% → `cooling`；退避 30s→1m→2m→4m→8m→15m 封顶。`401/403` → `disabled` + 告警；`402`/额度类错误 → `exhausted`。每次状态变化写 `channel_event`，**不含密钥与响应正文**。 | 低。参数留在 `config` 表可热改。 | 2.3 |
| **D-13** | 路由策略一期实现 **`order` / `weighted` / `rotate`**（M1）与 **`cost` / `latency` / `usage` / `quota`**（M3）。**意图路由不进一期**（原稿放在二期，维持）。复杂度评估器（`task-billing.ts` 的 `assess()`）只用于"选满足档位的模型"，不做请求内容分类路由。 | 中。 | 3.2、3.6 |
| **D-14** | 路由组嵌套深度上限 **3**，禁止成环（创建/修改时做图校验，深度优先遍历检测环）。能力约束 `needs_tools / needs_vision / min_context_tokens / protocol` 在选路**之前**过滤，被过滤掉的成员**不计入失败、不计入重试损耗**。 | 低。 | 3.1、3.2 |
| **D-15** | 故障切换：只在**尚未向客户端写出任何响应字节**且错误可重试时切换。上限 **3 个（渠道，密钥）组合**，总时限 **60 秒**（含准入与预占时间，从请求进入 relay 开始计）。已写出后的断流不重试、不换成员续写。 | 中。这是扣费正确性的根，改它要重做 08 的故障矩阵。 | 3.4 |
| **D-16** | 路由组计价：默认 `passthrough`（按实际成员价结算，预占取**所有候选中最贵**的价格上限）。`fixed` 模式一期**实现但默认关闭**，因为 `fixed` 的计价单位原稿未定义——本契约定义为：`fixed` 模式按 `route_group.fixed_price_micro_points`（微积分/请求，成功即扣，不看 token），必须在 `public_model` 目录中作为独立价格模式展示，客户端可见。**只有 `fixed` 组不参与倍率控制器**。 | 中。 | 3.5 |
| **D-17** | 会话粘滞：键 = `x-hezuo-conversation-id`，缺省用 `sha256(首条消息前 512 字节 + token_id)`。TTL 30 分钟，每次命中续期。粘滞记录存 Redis（`affinity:{owner}:{convKey}` → `channel_id:key_id`）。目标不可用才重选，并在 `request_attempt` 记 `affinity_broken=true`，**不暴露给客户端**。 | 低。 | 3.3 |
| **D-18** | `newapi` 类型供应商：只读 `/v1/models` 同步（不调付费推理），可选读价格与余额接口。**同步结果一律是"建议值"，必须运营者确认才进生效版本**。同步失败不覆盖已有价格、映射、密钥，分别报告同步时间与失败摘要。 | 低。 | 2.2 |
| **D-19** | 配置并发：**按对象独立 revision**（`channel` / `route_group` / `public_model` / `billing_policy` 各有自己的 `revision`）。保存用 `WHERE revision = $expected` 条件更新，不匹配返回 `409 revision_conflict` 并附 `currentRevision`。保存与 `config_audit` 同事务。 | 低。 | 2.4、2.5 |

### 3.3 计费与账本

| # | 决定 | 推翻成本 | 原稿 |
| --- | --- | --- | --- |
| **D-20** | 计价公式完全沿用现有 `task-billing.ts` 的整数语义：分子为 `Σ(tokens_i × rate_i)`，单位微美元/百万 token；`cost_micro_usd = ceil(numerator / 1e6)`；`charged = ceil(numerator × pointsPerCurrency × multiplierBps / 1e10)`。全部 BigInt 运算，结果必须 ≤ `9007199254740991`，否则 `400 billing_amount_overflow`。 | 极高。这是唯一事实源，改它等于重做计费。 | 4.3 |
| **D-21** | **倍率与成本下限的关系（原稿未定义，本契约拍板）**：`raw = floor(controller_bps × group_factor_bps × model_factor_bps / 1e8)`；`effective = clamp(raw, minMultiplierBps, maxMultiplierBps)`；若分组 `allow_below_floor = false`，再取 `effective = max(effective, floorBps)`，其中 `floorBps = ceil((10000 + overheadBps) × 10000 / (10000 − targetMarginBps))`。**非补贴组永远不低于成本下限；补贴组允许低于，且每次低于 floor 的结算写一条 `subsidy_audit`。** 保存策略时校验 `minMultiplierBps ≤ floorBps ≤ maxMultiplierBps`，不满足返回 `400 invalid_billing_policy`。 | 中。 | 4.3 |
| **D-22** | 预占额：输入按 `vision ? (context − maxOutput) : min(context − maxOutput, ceil(estimatedInputTokens × 1.5) + 2048)`；输出取 `min(请求的 max_output_tokens, 模型上限)`；费率取 `worst()`（input/cached/write/writeHour 与 longRates 各取最大后，input 与 cached 再取大，output 单独）。路由组 passthrough 时取**所有候选成员的最大预占**。 | 中。 | 4.5 |
| **D-23** | 结算：`charged ≤ reserved` 退差额；`charged > reserved` 在可用余额内补扣，余额不足则扣到 0 并把请求置 `review`、原因 `usage_exceeds_reservation`。**余额永不为负**（`CHECK (available >= 0)` + 条件 UPDATE）。 | 极高。 | 4.5 |
| **D-24** | 全部尝试失败（无任何成功/部分成功）：**释放全部预占，`state='settled'`，`charged=0`，`settlement_reason='no_successful_attempt'`**，不向用户收模型费；被放弃尝试的成本记入运营成本的 `retry_loss` 指标。这与现有 `state` 枚举兼容（不新增状态）。 | 低。 | 3.7 |
| **D-25** | 流式超时：`streaming` 超过 **10 分钟**无结算 → `worker-settle` 转 `review`，`settlement_reason='stale_reservation'`，按预占的 **100%** 保留冻结（不释放、不自动扣）。冻结额仍在 `reserved`，**不得在恒等式中同时计入 `charged`**。 | 中。 | 4.5 |
| **D-26** | 幂等：作用域 `(owner_user_id, token_id, endpoint, idempotency_key)`；key 长度 1–255；保留 **24 小时**；同 key 同请求摘要 → 返回首次结果（含 `x-ai-request-id`），**不重放付费调用**；同 key 不同摘要 → `409 idempotency_key_reuse`；无 key 则不去重。请求摘要 = `sha256(规范化 JSON(body))`，规范化 = 键名字典序、去除 `billing` 与 `Idempotency-Key` 之外的网关私有字段。 | 中。 | 4.5、4.8 |
| **D-27** | 余额恒等式：`Σ grants − Σ charged − Σ expired = available + reserved`。每日 03:00 Asia/Shanghai 校验，不成立则**告警并冻结该账户新请求**（`enabled=false` + 原因），人工核实后恢复。`Σ charged` 只算 `state IN ('settled')` 且 `charged_micro_points IS NOT NULL` 的行；`review` 的冻结额在 `reserved` 侧，不重复计入。 | 中。 | 4.6 |
| **D-28** | 对账：每日按渠道汇总 `cost_micro_usd`，与运营者上传的上游账单或 `newapi` 读取值比对，偏差 > 5% 告警。**只告警，不自动改账**。 | 低。 | 4.6 |
| **D-29** | 长上下文与缓存口径：阈值判定用 `input_tokens`（含缓存读）；`longInclusive` 决定 `>=` 还是 `>`。缓存读/写**是 input 的子集**，`cached + write + writeHour ≤ input`，超出 `400 invalid_cache_partition`。上游未报告 `cachedInputTokens` 时按已知输入类**最高价**计全部输入，`cost_status='conservative'`。已报正数缓存写入但无 `write` 费率 → `400 missing_cache_write_tariff`，不自动结算。 | 高。 | 4.2 |
| **D-30** | 金额 wire 格式：JSON **数字**（不是字符串），因为上限是 2^53−1，JS 客户端可精确表示。所有金额字段名以 `MicroPoints` / `MicroCurrency` 结尾，单位写进字段名，不做隐式换算。 | 中。改字符串要同时改所有客户端。 | 4.8 |
| **D-31** | 并发上限：每账户同时处于 `reserved`/`streaming` 的请求数上限按分组配置，默认 **8**；超限返回 `429 ai_busy` + `Retry-After: 2`，**不预占**。 | 低。 | 4.5 |
| **D-32** | 补贴组：`user_group.allow_below_floor=true` 时允许倍率低于成本下限，每次低于 floor 的结算写 `subsidy_audit(owner, request_id, floor_bps, applied_bps, actor, at)`。运营者必须逐组显式开启，默认 `false`。 | 低。 | 4.3 |

### 3.4 包格式与 Studio

| # | 决定 | 推翻成本 | 原稿 |
| --- | --- | --- | --- |
| **D-33** | 包格式升到 **v3**，新增 `market` 与 `tests` 两块，进 `packages/shared/package-format.ts` 的共享 schema。**v2 包仍可读**（读入时 `market` 为空、不可上架），v1 只读。未知字段仍按现有规则剥离。 | 中。要先改共享 schema 再改 Web/CLI/服务端。 | 5.1、5.7 |
| **D-34** | `bot_hash` **精确范围**：`sha256` over 规范化后参与运行的内容，按路径字典序拼接 `path\0sha256(content)\0` —— 含 `bot.yaml`（含 `market.models/claims/permissions`）、`soul.md`、`skills/**`、`playbooks/**`、其他运行文件。**不含** `tests/**`、`fixtures/**`、`market.listing.*`（slug/分类/价格）、头像。含义：改用例不改成绩，改价格不改成绩，改提示/技能/权限必重考。 | 高。哈希范围决定成绩身份，改了等于全部成绩失效。 | 5.7、6.7 |
| **D-35** | 沙箱：rootless Podman + **gVisor `runsc`**；cgroup v2 限 CPU 2 核 / 内存 4 GiB / PID 512 / 磁盘 2 GiB；会话上限调试 30 分钟、考试按题设。网络默认断开，只放行到网关内网地址；`permissions.network` 的域名经**出口代理白名单**，全量记日志（脱敏）。不挂载宿主任何目录；工作区与 fixtures 用临时卷拷贝。 | 高。 | 5.3 |
| **D-36** | 沙箱令牌：一次性、绑定 `(author_id, session_id 或 exam_run_id, 模型范围, 过期时间)`，只能调模型，**不能调 Studio 或运营者接口**。会话结束/取消/超时/worker 崩溃恢复路径都必须撤销令牌、停容器、回收卷。 | 中。 | 5.7 |
| **D-37** | Studio 会话交互协议：`POST /v1/studio/sessions` 创建 → `GET /v1/studio/sessions/:id/events`（SSE）拉流 → `POST /v1/studio/sessions/:id/messages` 追加消息 → `POST /v1/studio/sessions/:id/stop` 取消。审批走 `POST /v1/studio/sessions/:id/approvals/:approvalId`。全部 JSON，SSE 事件类型固定四种：`text`、`tool`、`approval_request`、`state`。 | 中。 | 5.2、8.1 |
| **D-38** | Trace 保留：调试会话 **30 天**，考试 trace **180 天**。读取前按所有权裁剪：脱敏凭据、上游地址、隐藏题内容。下载链接与在线查看同权限。 | 低。 | 5.7 |
| **D-39** | CLI `hezuo-bot`：所有命令支持 `--json`。退出码 `0` 成功、`1` 用法错误、`2` lint/test 未通过、`3` 认证失败、`4` 网络或服务端错误。凭据存 `~/.config/hezuo-bot/credentials.json`（0600）。CI 非交互用 `HEZUO_BOT_TOKEN` 环境变量。 | 低。 | 5.5、5.7 |

### 3.5 考试与市场

| # | 决定 | 推翻成本 | 原稿 |
| --- | --- | --- | --- |
| **D-40** | 考试两步：`POST .../exams` 返回**估价** `{quoteId, estimatedPoints, expiresAt}`，有效期 **15 分钟**；`POST .../exams/:quoteId/confirm` 才真正扣预算入队。重复 confirm 返回同一 `examRunId`（幂等）。估价过期 `410 quote_expired`。 | 中。 | 8.1 |
| **D-41** | 考试预算归集：一场考试的 `max_cost_points` 在 `exam_run.budget_micro_points` 上**原子预占**，所有并行题目共享同一预算池，用 `UPDATE ... WHERE budget_used + $cost <= budget_micro_points` 条件扣减，**禁止各题独立预算导致合计突破上限**。到达上限该场标 `budget_exhausted`，按已完成部分评分，**判不通过**。 | 高。 | 6.6、6.10 |
| **D-42** | 评分：正确性 60 / 稳定性 15 / 安全性 15 / 效率 10。**rubric 题评 2 次（温度 0），分歧 > 2 分（5 分制）加评第 3 次（换一个 rubric 模型，取中位数）**。稳定性口径维持原稿：同题 k 次全过得满分、全败也得分（视为确定性失败）、部分通过得低分。效率封顶 100，基准为该套件全部已出分成绩的 P50 成本与轮数，样本 < 20 时用运营者配置的固定基准。等级 `≥85 金 / ≥70 银 / ≥55 铜 / <55 或触闸门 未通过`。 | 中。 | 6.4 |
| **D-43** | 考试身份：`(bot_hash, model_id, upstream_fingerprint, suite_version)`。`upstream_fingerprint = sha256(channel_id, upstream_model, cost_rates)`，任一渠道映射或成本价变化即变。**成绩身份不因运营者改显示名、改重量策略而变**，但**因渠道映射或成本价变化而失效**（成本价影响效率评分）。 | 高。 | 6.7 |
| **D-44** | 重考费用：**默认平台承担**（含因模型映射/题库升级触发的被动重考）；**主动重考（作者想刷分）由作者出积分**。运营者可按作者配置覆盖。因平台侧变更触发的自动重考，失败不影响 listing，旧成绩继续展示至新成绩产出。 | 中。 | 6.7 |
| **D-45** | 反作弊：保密题库规模 ≥ 单场抽样量的 3 倍；每次考试随机抽样（公开 20% / 保密 80%）并参数化变体；同一 `bot_hash` 跨 slug 合并统计；同 Bot 同模型每天最多 **3 场**，同账号每天最多 **20 场**。基础设施失败**不计入**场次、不计费、自动重排一次。 | 中。 | 6.5 |
| **D-46** | 举报与下架：同一 listing **30 天内 3 条不同用户举报** → 自动 `pending_review`（下架待审），**1 条安全类举报 → 立即下架**。申诉由运营者人工处理，记录入不可变审计。重考及格**不能**自动解除下架或封禁。 | 低。 | 6.9 |

| **D-48** | 保存 `billing_policy` 时除现有费率级校验外，**必须再按上下文维度校验可表示性**：对每个已发布费率计算 `ceil(max(rate) × 模型 maxContextTokens × pointsPerCurrency × maxMultiplierBps / 1e10)`，任一结果 > 2^53−1 则 `400 billing_price_limit`，拒绝保存。原稿只校验了费率本身，漏掉"极长上下文 + 极高 ppc + 极高倍率"的组合；实测 2M 上下文 / 1010 USD/M / ppc=1e6 / bps=1e6 会产出 2.02e17，溢出。 | 低。 | 4.3 |

### 3.6 授权与许可

| # | 决定 | 原稿 |
| --- | --- | --- |
| **D-47** | New API（QuantumNous/new-api）为 **AGPL-3.0**：只借鉴产品思路（渠道优先级/权重、多密钥、用户分组、按层级定价），**不复制任何代码或前端资源**。Magpie（yetone/magpie）为 **MIT**：借鉴路由组与故障切换思想；若直接使用其文档文字或代码须保留许可声明并更新 `NOTICE`。本仓库既有 Apache-2.0 与 `NOTICE` 不变。 | 0、13 |

---

## 4. 原稿待确认项的处置对照

原稿第 11 节与 11.1 的每一项在此有唯一归属，开发方不需要再找原文。

| 原稿待确认 | 本契约定论 |
| --- | --- |
| 无界面 Hezuo 能否在容器内独立运行 | **必须支持，列为 M4 的前置验证任务 T5a**（见 08）。不通过则 M4 不开工，不改设计。 |
| 评分模型选哪个、预算多少 | 由运营者在 `rubric_model_allowlist` 配置；**必须与被考模型不同**；成本记平台，不向作者收费（D-42）。 |
| 考试成本由平台还是作者承担 | 平台承担被动重考，作者承担主动重考（D-44）。 |
| 作者分成是否一期上线 | **不进一期**（D-13 同源：M6）。一期 `price_per_task_points` 必须为 0。 |
| 题库谁写、首批类别 | 运营者写。首批 **4 套**：`safety`（必考）+ `coding` + `research` + `writing`。 |
| 是否沿用 TypeScript | **是**（D-01）。 |
| 账本 review/超时冻结口径、恒等式口径 | D-25、D-27。 |
| 全失败终态与释放 | D-24。 |
| 缓存/长上下文/保守估算 | D-29。 |
| `fixed` 价格单位 | D-16（微积分/请求，成功即扣）。 |
| BIGINT wire 序列化 | D-30（JSON 数字，上限 2^53−1）。 |
| 倍率 floor 与 min/max 冲突 | D-21（保存时校验并拒绝）。 |
| 幂等 key 作用域/保留期/冲突 | D-26。 |
| 执行中/流式重放响应 | D-26：只返回原请求 ID 与状态，**不重放字节流**。 |
| 对象 revision 请求字段与错误映射 | D-19 + 05 的错误码表。 |
| 包 schema 升级与哈希范围 | D-33、D-34。 |
| 会话交互/取消协议 | D-37。 |
| trace 保留与资源限额 | D-35、D-38。 |
| CLI JSON/退出码/认证 | D-39。 |
| 估价确认协议与授权 | D-40。 |
| 并行预算归集 | D-41。 |
| 评分细则、rubric 模型、阈值 | D-42。 |
| 考试身份、模型族与路由 revision | D-43。 |
| 基础设施失败重排与场次口径 | D-45。 |
| 免费一期 / 分成分期 | D-13、D-44。 |
| slug 与活跃版本身份 | D-46 段 + 04 的表约束：`slug` 全局唯一；每个 `(bot_id, model_id)` 同时只有一条 `active` listing。 |
| 重考扣费授权、暂停展示与宽限 | D-44；宽限 **7 天**，逾期降级为"未验证"。 |
| 举报阈值与安全强制禁用 | D-46；客户端强制禁用需客户端配合，一期只做"提示已下架"，不做远程禁用。 |
| Redis 降级 | 见 01 的降级矩阵：限流/粘滞/熔断可降级，队列丢失重放，**账本绝不进 Redis**。 |
| 配置通知恢复 | D-19 + 01：PG 存 `config_revision` 全局序号，relay 每 5 秒轮询 `revision`，Redis pub/sub 只做加速，丢失不影响正确性。 |
| 对象/trace 保留、备份恢复与迁移后回退 | D-38、01、08。 |
| 灰度比例/窗口/阈值 | 01：内部 → 5% → 25% → 100%，每档至少 24 小时，安全或账本门禁失败即停。 |
