# 网关 V2 · Bot Studio · 开放市场 —— 开发契约

> 状态：可实现规格（implementation-ready）。**未开发、未部署、未验证。**
> 本文档集取代 `docs/gateway-v2-and-bot-market.md`（该文件保留为评审历史，不再作为实现依据）。
> 目标读者：承接实现的外部开发团队。读完本目录即可建库、定义接口、排期、验收。
> 交付形态：本目录 10 份 Markdown + `schema.sql`（可直接 `psql -f` 的 PostgreSQL 16 DDL）+ `openapi.yaml`（OpenAPI 3.1 骨架）。

## 怎么读

| 文件 | 内容 | 谁先读 |
| --- | --- | --- |
| [00-scope-decisions.md](00-scope-decisions.md) | 范围、里程碑、**全部已拍板决策 D-01…D-46** | 全员第一天 |
| [01-architecture.md](01-architecture.md) | 进程拓扑、技术栈、可靠性边界、部署形态 | 后端负责人 |
| [02-upstream-routing.md](02-upstream-routing.md) | 供应商/渠道/密钥、健康熔断、路由组、故障切换、会话粘滞 | 网关开发 |
| [03-billing.md](03-billing.md) | 计价公式、预占结算、分组倍率、对账、账本恒等式 | 计费开发 + 财务 |
| [04-data-model.md](04-data-model.md) | 表设计说明、约束、状态机、迁移映射 | 后端 |
| [05-api-contract.md](05-api-contract.md) | 七组接口族、鉴权、幂等、错误码全表 | 前后端对接 |
| [06-bot-studio.md](06-bot-studio.md) | 包格式 v3、工作台、沙箱、Trace、CLI | Studio 开发 |
| [07-exam-market.md](07-exam-market.md) | 题库、抽题、评分、闸门、防作弊、市场与重审 | 考试/市场开发 + 运营 |
| [08-delivery-acceptance.md](08-delivery-acceptance.md) | 任务切片、依赖图、验收矩阵、放行门禁 | 项目经理 |
| [schema.sql](schema.sql) | 全部表、约束、索引、不可变触发器、预占/结算函数 | 后端 |
| [openapi.yaml](openapi.yaml) | 接口骨架，字段以 05 为准 | 前后端 |

## 三条硬约束（违反即返工）

1. **钱只能走一条路**：任何余额变化必须先改 `ai_request` 状态、再写 `ledger_entry`，且在同一事务内。禁止直接 `UPDATE balance`。`balance` 只由 `fn_ai_reserve` / `fn_ai_settle` / `fn_ai_release` / `fn_ai_adjust` 四个函数写入。
2. **不引上游代码**：New API 是 AGPL-3.0，只借鉴产品思路；Magpie 是 MIT，只借鉴路由思想。两者都不复制进本仓库。见 00 的 D-45。
3. **假夹具不算验收**：单元测试与假模型只能证明接线。模型相关里程碑（M1–M5）的验收必须用真实模型 + 独立观察，按 [08](08-delivery-acceptance.md) 的证据格式提交。

## 与现有代码的关系

现有 `gateway/control-plane/`（TypeScript + Cloudflare Worker 接口 + D1/SQLite，由 Miniflare 在 Linux 上宿主）是本设计的**前身**，不是要实现的目标。本设计把它升级为独立 Linux 服务，但**保留**：

- 对外协议 `/v1/ai/*`、`/v1/account/ai/*` 的路径、请求体与响应字段（客户端不改代码）。
- 积分账本的全部不变量：整数微积分、`reserved → streaming → review | settled`、准入时冻结价格快照、只追加审计、余额永不为负。
- 计价函数 `gateway/control-plane/src/task-billing.ts` 的整数语义（BigInt、向上取整、`MAX_SAFE_INTEGER` 上限）；当前仓库不存在 `packages/shared/task-billing.ts`，抽取共享实现前应以现有实现与测试为基线。
- 包格式 `packages/shared/package-format.ts`（从 v2 升到 v3，v2 仍可读）。

**不要求**兼容 Worker 运行时、D1 SQLite 方言、Cloudflare 绑定。见 [04](04-data-model.md#迁移映射)。

## 术语

| 词 | 含义 |
| --- | --- |
| 公开模型 `public_model` | 客户端看到的模型 ID，如 `gpt-6.1-sol`。一个公开模型可映射到多个渠道。 |
| 渠道 `channel` | 一个上游接入点 + 一组可用模型。 |
| 路由组 `route_group` | 对客户端表现为一个"混合模型"，ID 形如 `group/daily-coding`，内部由多个成员按策略选路。 |
| 微积分 | 金额单位。1 积分 = 1,000,000 微积分。积分是服务额度，**不是货币**，不可兑换。 |
| 微美元 | 成本估值单位。1 USD = 1,000,000 微美元。仅用于内部毛利核算，不对客户端暴露。 |
| `bot_hash` | Bot 版本的规范化内容哈希，考试成绩的身份之一。见 [06](06-bot-studio.md#bot_hash-的精确范围)。 |
| listing | 「Bot × 模型」的上架记录。一个 Bot 声明 N 个模型就有 N 条 listing，各自独立出分、独立上下架。 |
| 闸门 `gate` | 考试的一票否决项（越权、泄密、注入成功等）。触发即该场不通过，不看总分。 |

## 变更控制

- 本目录的任何契约变更走 PR，必须同时更新：正文、`schema.sql`（如涉及）、`openapi.yaml`（如涉及）、[08](08-delivery-acceptance.md) 的验收用例（如涉及行为）。
- 决策变更必须新增一条 `D-xx` 记录（不删旧条目），写明推翻哪一条、原因、谁批准、日期。
- 开发中遇到本契约未覆盖或互相矛盾的情形：**停下来问**，不要自行发明参数、错误码或公式。
