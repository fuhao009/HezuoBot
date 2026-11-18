# 06 · Bot Studio

M4 的交付。Studio 是一个独立 Web 应用 + CLI，与桌面端共用同一份包格式。

## 1. 前置验证（T5a，阻断 M4）

**在写任何 Studio 代码之前，必须先证明**：无界面 Hezuo 服务能在容器内独立启动、连上网关、拿到模型响应、执行一次工具调用。

验证产物：

- 一个 Dockerfile 或 Podman 镜像，能 `run` 后在无桌面、无 GPU、无宿主挂载的条件下启动 headless 服务
- 一次真实模型调用的完整记录：请求 ID、实际模型、响应、耗时
- 一次工具调用的完整记录：工具名、输入、输出
- 资源占用实测：内存峰值、启动时间

**不通过则 M4 不开工**，且不允许"先用假模型顶上、以后再换真的"。这不是可裁剪项。

## 2. 包格式 v3（D-33）

### 2.1 目录结构

```text
my-bot/
  bot.yaml               # 包定义 + market + tests 声明
  soul.md                # 角色 / 系统提示
  skills/*/SKILL.md      # 技能
  playbooks/*.md
  tests/
    cases/*.yaml         # 开发者自测用例
    fixtures/            # 测试用初始文件与模拟工具输出
```

### 2.2 `bot.yaml` 的 `market` 段

```yaml
market:
  listing:
    slug: refactor-helper
    category: coding
    price_per_task_points: 0      # 一期必须为 0（D-13）
  models:
    - model: gpt-6.1-sol
      claims: [tools, long_context]
    - model: claude-sonnet-5
      claims: [tools, vision]
  permissions:
    tools: [shell, browser, files]
    network: [api.example.com]
    mcp: []
```

### 2.3 校验规则

| 规则 | 失败结果 |
| --- | --- |
| `price_per_task_points` 非 0 | `rejected: price_not_allowed_in_phase_1` |
| 声明的 `model` 不在 `public_model` 且 `examinable=false` | 允许提交但该模型 listing 永远 `unverified` |
| `claims` 含未知值 | `rejected: unknown_claim` |
| `permissions.network` 含通配符或 IP 字面量 | `rejected: network_wildcard_not_allowed` |
| 包含密钥（沿用 `packageSecretFindings`） | `rejected: secret_detected` |
| 包含绝对路径 | `rejected: absolute_path` |
| 路径穿越 / 越界符号链接 | `rejected: unsafe_path` |
| 包 > 4 MiB（沿用 `PACKAGE_MAX_BYTES`） | `rejected: too_large` |
| 未知字段 | **剥离**（沿用现有行为），不报错 |

v2 包可读入：`market` 视为空，`reviewState` 保持不可上架。v1 只读。

### 2.4 `bot_hash` 的精确范围

**这是成绩身份的一部分，实现必须逐字遵循。**

```text
参与哈希的文件（按路径字典序）：
  bot.yaml                    ← 含 market.models / claims / permissions
  soul.md
  skills/**/SKILL.md
  playbooks/**/*.md
  其他运行用文件（非 tests/、非 fixtures/、非头像）

不参与哈希：
  tests/**
  tests/fixtures/**
  market.listing.slug
  market.listing.category
  market.listing.price_per_task_points
  avatar / 外观资源

算法：
  hash = sha256( concat( for each file in sorted(paths): path + "\0" + sha256(content) + "\0" ) )
  路径统一用 "/" 分隔、小写化、去除前导 "./"
  内容统一 UTF-8，去除 BOM，行尾统一 LF
```

**结论**：改用例不改成绩；改价格/分类/slug 不改成绩；改提示、技能、权限、声明模型 **必须重考**。

## 3. 在线工作台

### 3.1 聊天调试

选「Bot 版本 + 模型（含路由组）」→ 发任务 → 看流式输出与工具审批。

- 审批走平台自己的 UI，不是桌面端的审批
- 审批决定只影响本次会话
- 会话内可随时 `stop`

### 3.2 Trace 面板

每个回合展示：

| 区块 | 内容 |
| --- | --- |
| 请求 | 系统提示、工具定义、上下文裁剪情况、估算 token |
| 响应 | 模型输出、stop reason |
| 工具 | 名称、输入、输出、耗时、是否被拒 |
| 计量 | input/cached/output tokens、成本（积分）、耗时 |
| 选路 | **渠道别名**（如 `ch-a`），不是地址或密钥 |

### 3.3 模型对比

同一用例在 2–5 个模型并行跑，表格对比：通过与否、轮数、成本、耗时。

约束：并行会话共享开发者的会话预算，**总成本不得超过会话 `maxCostPoints`**。

### 3.4 回放

保存一次会话的"模型输出 + 工具结果"，可在不调真实模型的情况下回放，用于调试工具与提示的接线。

**回放不得用于考试，也不产生任何考试分。** Trace 上必须标注 `replay: true`。

### 3.5 版本管理

每次保存生成不可变版本（`bot_hash`）。支持 diff、打标签、查看 lint 报告。

**上架和考试都针对具体版本**，不针对"最新版"。

### 3.6 静态检查（lint）

| 检查 | 说明 |
| --- | --- |
| 包格式 | schema 校验 |
| 密钥扫描 | 沿用 `packageSecretFindings` |
| 权限一致性 | 声明的 `tools` 与实际使用比对；用了没声明 → 警告；声明了没用 → 提示可精简 |
| 技能引用 | `skills/` 引用是否存在 |
| 提示长度 | 超过阈值警告 |
| 模型声明 | 是否 `examinable` |

lint 是**警告为主、拒绝为辅**：只有安全类（密钥、路径穿越）才拒绝。

## 4. 沙箱（D-35、D-36）

### 4.1 隔离

| 维度 | 配置 |
| --- | --- |
| 运行时 | rootless Podman + gVisor `runsc` |
| CPU | 2 核 |
| 内存 | 4 GiB |
| PID | 512 |
| 磁盘 | 2 GiB（临时卷） |
| 会话时长 | 调试 30 分钟；考试按题设 |
| 宿主挂载 | **无**。工作区与 fixtures 用 `podman cp` 拷入临时卷 |
| 网络 | 默认断开 |

### 4.2 网络白名单

- 只放行到网关内网地址（模型调用）
- `permissions.network` 的域名经**出口代理**放行
- 代理必须校验：域名、解析目标 IP、重定向链、直连 IP 绕过、DNS 绕过
- IPv4 与 IPv6 都要测
- 全量记录网络行为，**脱敏令牌与载荷**

网关例外**只允许模型调用**，不能借此访问管理接口。

### 4.3 令牌

```text
sandbox_token:
  scope:    ["ai:chat", "ai:responses"]
  models:   [声明且 examinable 的模型]
  budget:   maxCostPoints
  session:  session_id 或 exam_run_id
  expires:  会话结束或最长时长
```

**不能**调 Studio、运营者、账号接口。会话结束/取消/超时/worker 崩溃恢复都必须撤销令牌、停容器、回收卷。

清理失败：留记录、告警、重试。**不得宣称清理完成**。

### 4.4 孤儿清理

`worker-settle` 每 5 分钟扫描：

- 超过 `expires_at` 仍运行的容器 → 强制停止
- 没有对应活跃会话的卷 → 回收
- 令牌已过期但容器仍在 → 停止并告警

指标 `sandbox_orphans`，> 0 持续 10 分钟告警。

## 5. 自测用例格式

```yaml
id: refactor-001
title: 把函数拆成两个
prompt: "把 src/util.ts 里的 parse 函数拆成 parseHeader 和 parseBody，并更新调用处"
workspace: fixtures/refactor-001/
checks:
  - type: file_contains
    path: src/util.ts
    pattern: "function parseHeader"
  - type: command
    run: "npm test"
    expect_exit: 0
  - type: tool_not_used
    tool: network
limits: { max_turns: 20, max_cost_points: 500, timeout_seconds: 600 }
```

检查类型：

| type | 参数 | 判定 |
| --- | --- | --- |
| `file_exists` | `path` | 存在即通过 |
| `file_contains` | `path, pattern`（正则） | 匹配即通过 |
| `file_not_contains` | `path, pattern` | 不匹配即通过 |
| `command` | `run, expect_exit` | 退出码匹配 |
| `tool_used` | `tool` | 至少调用一次 |
| `tool_not_used` | `tool` | 一次都没调用 |
| `final_message_matches` | `pattern` | 最终回复匹配 |
| `rubric` | `criteria, max_score` | 评分模型打分（见 07） |

`command` 在容器内执行，**检查脚本本身在容器外**，只回传结果。

## 6. CLI

安装：`npm i -g @hezuo/bot-cli`，或单文件二进制。

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `login` | 存凭据到 `~/.config/hezuo-bot/credentials.json`（0600） | 0/3 |
| `init` | 建目录骨架 | 0/1 |
| `lint` | 本地静态检查 | 0/2 |
| `test --model <id>` | 经平台沙箱执行 `tests/cases` | 0/2/4 |
| `publish` | 上传版本（不提交上架） | 0/4 |
| `submit --version <v>` | 提交上架 / 申请考试 | 0/4 |
| `status` | 版本与 listing 状态 | 0/4 |

非交互认证：`HEZUO_BOT_TOKEN` 环境变量优先于凭据文件。

`--json` 输出统一为：

```json
{ "ok": true, "command": "test", "data": { ... } }
{ "ok": false, "command": "test", "error": { "code": "…", "message": "…" } }
```

## 7. 开发者额度

- 调试消耗**开发者本人**的积分
- 每个新开发者一次性试用额度，运营者可配、可关闭
- 会话级上限：`maxTurns`（默认 30）、`maxCostPoints`（默认 500）、`timeoutSeconds`（默认 1800）
- 超限自动 `stop`，返回 `session_limit_exceeded`

## 8. Trace 裁剪规则

读取 trace 前必须裁剪：

| 内容 | 处理 |
| --- | --- |
| 上游密钥、令牌 | 移除 |
| 上游地址、主机名 | 替换为渠道别名 |
| 沙箱令牌 | 移除 |
| 隐藏题的题面/答案 | 移除（考试 trace 尤其） |
| 用户敏感信息 | 按配置打码 |

下载链接与在线查看**同权限**，不能靠"下载"绕过裁剪。

保留期：调试 30 天、考试 180 天（D-38）。

## 9. 数据与对象存储

| 对象 | 路径 | 何时写 |
| --- | --- | --- |
| 包 | `objects/<ab>/<cd>/<sha256>` | 版本上传 |
| trace | `objects/<ab>/<cd>/<sha256>` | 会话结束 / 每回合 |
| 成绩单报告 | `objects/<ab>/<cd>/<sha256>` | 考试完成 |

写入顺序：**先写对象并校验摘要，再提交 PG 引用**。对象写成功但 PG 失败 → 孤儿，由定时任务清理；PG 成功但对象丢失 → 告警且**不返回坏下载地址**。
