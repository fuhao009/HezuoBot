# 01 · 架构与部署

## 1. 进程拓扑

```text
                        客户端（桌面 Hezuo / 外部 SDK / 浏览器）
                                       │ HTTPS
                                       ▼
                          ┌────────────────────────┐
                          │  Caddy（TLS 终止）      │
                          └────────────┬───────────┘
        ┌──────────────┬───────────────┼───────────────┬──────────────┐
        ▼              ▼               ▼               ▼              ▼
   relay-api      account-api     studio-api      market-api     admin-api
   /v1/ai/*       /v1/account/*   /v1/studio/*    /v1/market/*   /v1/operator/*
        │              │               │               │              │
        └──────────────┴───────────────┴───────────────┴──────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
             PostgreSQL 16         Redis 7          对象存储（本地磁盘）
             唯一事实源             可重建状态          Bot 包 / trace / 产物

   后台进程（systemd）：
     worker-health    渠道探测、熔断状态推进
     worker-exam      考试队列消费、沙箱调度
     worker-settle    stale_reservation、对账、恒等式校验、过期考试重排

   沙箱宿主：rootless Podman + gVisor(runsc)，每会话一容器
```

`admin-web` 与 `studio-web` 是两个独立前端，与 API 同源不同路径（或子域名）。

## 2. 技术栈

| 层 | 选型 | 理由 / 约束 |
| --- | --- | --- |
| 语言 | TypeScript，Node 24 LTS | 复用 `packages/shared/*` 的计价与包校验（D-01） |
| HTTP | Fastify | 原生支持 SSE、schema 校验、低开销；不用 Express |
| 校验 | zod（已在用） | 与共享包一致，避免两套规则 |
| 数据库 | PostgreSQL 16 | `BIGINT` + 条件 UPDATE 实现原子账本（D-02） |
| 迁移 | `node-pg-migrate`，纯 SQL 文件 | 迁移必须可读可审计，不用 ORM 自动生成 |
| 队列 | Redis Streams + 消费者组 | 至少一次投递；业务幂等由 PG 唯一约束兜底（D-03） |
| 缓存 | Redis | 限流、粘滞、熔断窗口、探测租约 |
| 对象存储 | 本地磁盘，内容哈希分片 | `ab/cd/<sha256>`；接口 `put/get/stat/delete` 可替换（D-04） |
| 进程 | systemd | 每进程一单元，非 root 用户 `hezuo`（D-05） |
| 反向代理 | Caddy | 自动 TLS；内网可换自签 CA（D-06） |
| 指标 | Prometheus `/metrics` + 自建告警 | 关键指标见第 7 节 |
| 日志 | 结构化 JSON 到 stdout，systemd/journald 收口 | 禁止输出密钥、上游正文、prompt |

不引入 ORM 的理由：本系统的核心是账本不变量，ORM 会把 `INSERT ... ON CONFLICT` 和带条件的 `UPDATE` 隐藏起来，而这些正是正确性所在。所有金额相关 SQL 必须是可审读的显式语句，集中在 `schema.sql` 的函数里。

## 3. 模块边界

| 模块 | 输入 → 输出 | 禁止事项 |
| --- | --- | --- |
| `relay-api` | 已鉴权模型请求、配置与价格快照 → 模型响应、`ai_request`/`request_attempt`、结算结果 | 不让上游响应直接改余额；不泄露渠道地址、密钥、上游模型名 |
| `account-api` | 账户身份、合法额度操作 → 余额、流水、令牌权限 | 不提供绕过账本的写入口；运营后台也走同一套函数 |
| `studio-api` | 作者身份、包/版本、调试与考试申请 → 不可变版本、会话、受限 trace | 不直接执行包内命令；不在进程内起沙箱 |
| `market-api` | 登录身份、模型筛选、安装/举报 → 展示、授权下载、记录 | 只消费有效成绩与审核状态；安装不放宽客户端运行批准 |
| `admin-api` | 运营身份、对象 revision、原因 → 配置新版本、操作结果、脱敏审计 | 配置不能改历史请求快照 |
| `worker-health` | 渠道配置、探测配额 → 健康指标、状态事件 | 探测成本不能写成用户扣费 |
| `worker-exam` | 已确认且有预算的考试任务 → 沙箱运行、评分产物 | 检查脚本与保密题不进 Bot 容器；不绕开准入与预算 |
| `worker-settle` | 超时/未完成记录、对账资料 → review、恢复调度、告警 | 不重复扣费、不自动覆盖上游账单差异 |

**唯一写入账户余额的地方**是 `schema.sql` 里的四个函数：`fn_ai_reserve`、`fn_ai_settle`、`fn_ai_release`、`fn_ai_adjust`。应用层只有 `EXECUTE` 权限，对 `balance` 表无 `UPDATE` 权限（见第 5 节）。

## 4. 可靠性边界

### 4.1 事务边界

| 操作 | 事务内必须完成 | 事务外 |
| --- | --- | --- |
| 准入 | 幂等认领 → 校验启用/并发/模型权限 → 写 `ai_request` → 条件扣 `balance` → 写预占流水 | 转发上游 |
| 结算 | 锁请求行 → 校验未终态 → 写 usage/成本/charged → 退差或补扣 → 写流水 → 置终态 | 响应下游 |
| 配置保存 | 校验 → 条件 `UPDATE ... WHERE revision=` → 写 `config_audit` | 发布 revision 通知 |
| 出分 | 校验考试身份 → 写 `exam_run` 终态 → 派生 `listing` | 通知作者 |

**上游调用永远在事务之外。** 不允许持事务等网络。

### 4.2 向队列投递

业务写库与投递队列之间用 **transactional outbox**：`outbox(id, topic, payload, available_at, claimed_at)`，与业务同事务插入；dispatcher 轮询 `available_at <= now() AND claimed_at IS NULL`，用 `FOR UPDATE SKIP LOCKED` 认领后投 Redis Stream。这样"库里写了但消息没发出去"不会丢任务；重复投递由消费者幂等兜底。

### 4.3 Redis 降级矩阵

Redis 只存可重建状态，但不同用途的降级行为不同，必须逐项明确：

| 用途 | Redis 不可用时的行为 | 是否影响账本 |
| --- | --- | --- |
| 限流计数 | **fail-closed**：按本地内存计数 + PG 兜底查询；不无上限放行 | 否 |
| 会话粘滞 | **fail-open**：不粘滞，正常选路；缓存命中率下降 | 否 |
| 熔断窗口 | **fail-open**：不冷却，视为全部健康；由 PG 的 `channel_event` 事后补偿 | 否 |
| 探测租约 | **fail-closed**：不发探测，等 Redis 恢复 | 否 |
| 队列 | **重放**：outbox 里的记录仍在，dispatcher 继续重试；不丢任务 | 否 |
| 配置 pub/sub | **降级**：relay 退回 5 秒轮询 PG `config_revision` | 否 |

**任何情况下不允许把余额、幂等键、考试成绩放进 Redis。** PG 不可用时 relay 停止接受新扣费请求（返回 `503 ai_unavailable`），不能"先在 Redis 排队再承诺已预占"。

### 4.4 配置热生效

PG 有全局单调序号 `config_revision`（`config_sequence` 表，每次配置类写入 `nextval`）。relay 进程：

1. 每 5 秒 `SELECT last_value FROM config_sequence`；
2. 变大则重载受影响对象，本地建不可变快照；
3. Redis pub/sub 只做加速，丢失不影响正确性；
4. **缓存未完整加载新版本时保留旧快照**，不拼接半新半旧配置；加载失败告警但继续用旧快照服务，因为已预占请求本就用自己的快照；
5. 全局 revision 落后超过 60 秒 → 告警，并把 relay 标记为 `degraded`（管理后台可见），但**不拒绝请求**。

## 5. 数据库角色与权限

| 角色 | 权限 |
| --- | --- |
| `hezuo_owner` | schema owner，仅迁移使用 |
| `hezuo_app` | 业务表 `SELECT/INSERT/UPDATE`；`ledger_entry`、`config_audit`、`exam_audit`、`moderation_action`、`ai_billing_policy_audit` **只有 `SELECT/INSERT`**；`balance` **只有 `SELECT`**（写入必须经函数） |
| `hezuo_readonly` | 只读，给报表与排障 |
| `hezuo_migrate` | 迁移专用，可 DDL |

不可变表用**双保险**：应用角色无 `UPDATE/DELETE` 权限 + 触发器 `RAISE EXCEPTION`。只有 owner 能改。

## 6. 部署

### 6.1 目录

```text
/opt/hezuo-gateway/           程序与 node_modules
/opt/hezuo-gateway/bin/       hezuo-bot CLI
/etc/hezuo-gateway/
  env                        EnvironmentFile，0600
  master.key                 HEZUO_MASTER_KEY，0600，单独备份
/var/lib/hezuo-gateway/
  objects/                   包、trace、产物
  logs/
```

### 6.2 systemd 单元

每个服务一个 unit，`Type=simple`，`Restart=always`，`RestartSec=3`。共同加固：

```ini
User=hezuo
Group=hezuo
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/hezuo-gateway
EnvironmentFile=/etc/hezuo-gateway/env
```

`worker-exam` 额外需要访问 Podman socket，单独给权限，且**不与 API 进程同机同 cgroup**，避免考试负载拖垮转发。

### 6.3 就绪与存活

- `/healthz`：进程活着即 200。
- `/readyz`：PG 可连、主密钥可加载、`config_revision` 可读、对象存储可写。（Redis 不列入 readyz，见降级矩阵。）
- 未就绪时 Caddy 返回 503，不接流量。

### 6.4 备份

PG 每日全量 + WAL 归档。**备份必须同时包含 `/etc/hezuo-gateway/master.key`**，否则渠道密钥永久无法解密。两者分开存放、分别授权。每月做一次恢复演练并记录结果——备份完成不等于恢复可用。

### 6.5 迁移与回退

- 迁移用 expand/contract：先加列/加表，双写，再切读，最后删旧。灰度期不做不可逆删列。
- **PG 已经发生新的账本写入后，不得直接切回旧库。** 必须先停写、逐账户对账、由负责人批准做数据回迁或向前修复。详见 08。
- 代码回滚必须保证当前 schema 向后兼容（因为 expand 阶段已存在新列）。

## 7. 监控与告警

必须暴露的指标：

| 指标 | 类型 | 告警阈值（建议） |
| --- | --- | --- |
| `relay_requests_total{model,state}` | counter | — |
| `relay_reserve_latency_seconds` | histogram | P99 > 200ms |
| `relay_settle_latency_seconds` | histogram | P99 > 500ms |
| `relay_upstream_ttfb_seconds{channel}` | histogram | P95 > 10s |
| `channel_health{channel,key,status}` | gauge | 某模型全部渠道 `cooling` |
| `billing_identity_violations` | gauge | > 0 立即告警 |
| `billing_review_ratio` | gauge | > 10% 持续 15 分钟 |
| `reconcile_deviation_ratio{channel}` | gauge | > 5% |
| `exam_queue_depth` / `exam_queue_age_seconds` | gauge | age > 30 分钟 |
| `outbox_pending` | gauge | > 1000 或最老记录 > 5 分钟 |
| `sandbox_orphans` | gauge | > 0 持续 10 分钟 |
| `audit_write_failures` | counter | > 0 |

告警接收方与值班表由运营方在部署时填写，不写在代码里。
