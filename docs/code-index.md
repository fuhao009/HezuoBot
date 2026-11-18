# 项目代码索引

## 使用

本地 SQLite FTS5 全文索引，无网络请求，不上传源码。它索引当前工作区文本，包含未提交文件；不是编译器符号索引或验收结果。

```sh
python3 scripts/code-index.py build
python3 scripts/code-index.py search 'request_sign_in' --limit 8
python3 scripts/code-index.py search '"pendingNewBot"'
python3 scripts/code-index.py search 'takeover AND browser' --limit 10
```

数据库：`.hezuo-scratch/code-index.sqlite`，已被仓库忽略。修改代码后重新执行 `build`。搜索输出为文件路径、80 行文本块的起始行及命中摘要；起始行不是精确命中行。查询使用 SQLite FTS5 语法，含标点的词用双引号包裹。

范围：Git 跟踪文件及非忽略的新文件中常见源码、配置、文档。排除依赖、构建产物、第三方源码、参考仓库、锁文件和 `.env*`。不读取用户应用数据或网关数据库。索引不做凭据识别，因此不要共享数据库。

TypeScript/JavaScript LSP 已在 `.omp/lsp.json` 配置，覆盖 TS/TSX/JS/JSX/MJS/CJS/MTS/CTS。使用本机有效 Node 和独立安装在 `~/.local/share/hezuobot-lsp` 的 `typescript-language-server@4.3.4`，不修改产品依赖。配置含本机绝对路径，换机器需调整。修改配置后通过 `xd://lsp` 执行 `reload`（`file: "*"`）。已验证 `new-bot.ts` 符号发现、`Action` 到 `state/store.tsx` 的跨文件定义跳转，以及 `makeNewBot` 的 8 处引用（定义、弹窗导入与调用、测试导入与调用）。`desktop/tsconfig.json` 纳入整个 `src`；打开弹窗并执行定义查询后，引用结果已包含调用文件，不再只有自身定义。这证明该前端路径可用，不代表所有独立 TS 项目已完成引用验证。SQLite 全文索引与 LSP 各自独立；手机端 Swift/Kotlin LSP 按当前范围暂缓。

## codebase-memory-mcp

已建立项目 `HezuoBot` 的 moderate 语义图索引，初次结果为 65,731 节点、354,786 关系；2,197 文件按规则排除，12 文件局部解析缺口，0 文件完全无法解析。已实际使用 search_graph 查找 makeNewBot，并使用 trace_path 确认 SimpleNewBotDialog.save 调用链。源码修改后应检查索引新鲜度，不能用旧图代替源码；缺口结合 LSP 与源码核实。

## 最新刷新

手机端、网关身份切换和浏览器来源修正后已刷新 codebase-memory-mcp：2026-11-15T08:38:20Z，状态 ready，56,993 节点、303,248 关系；9 个文件局部解析缺口、0 个完全解析失败、1,987 个文件按规则排除。自动同步未启用（not_session_project），代码任务完成后显式刷新。当前打包聊天验收仍有 MCP 故障，索引 ready 不等于功能验收通过。

## 模块导航

| 范围 | 职责与入口 |
|---|---|
| `desktop/src/` | React 界面；`App.tsx` 组织页面与弹窗，`state/store.tsx` 管理动作和状态，`components/` 为界面组件，`lib/` 为客户端逻辑，`locales/` 为文案 |
| `desktop/electron/` | 桌面主进程；`main.mjs` 为 package.json 指定入口，`preload.cjs` 为桥接入口；`embedded-browser-runtime.mjs` 与 `embedded-browser-surface.mjs` 管理嵌入浏览器 |
| `desktop/server/` | 本机服务与 Bot 执行；`dev-server.ts` 为开发启动入口，`index.ts` 含请求登录流程；`routes/bots-create.ts` 接收 Bot 创建配置 |
| `desktop/companion/` | 电脑伴随服务；`src/index.ts` 为 `pnpm companion` 入口 |
| `gateway/local/` | 本地网关；`local-gateway.mjs` 提供 init/start/status/stop/service/operator 命令；通用 companion 中继供远程电脑连接使用 |
| `gateway/control-plane/` | 网关控制平面；独立 workspace 的类型检查、测试与 dry-run 命令 |
| `packages/shared/` | 跨端契约；`wire` 消息类型、`bot-profile.ts` 配置限制、`sign-in-request` 登录结果 |
| `scripts/` | 构建、打包、隔离验证；`package-product.mjs` 产品打包，`control-hezuo.ts` 隔离控制入口 |
| `docs/` | `current-batch.md` 是唯一当前需求文档；`verification/README.md` 为验证规范；`gateway-deployment-193.md` 为部署规范 |
| `apps/`、`connector/`、`enterprise/`、`evals/`、`deploy/` | 已删除；不能据此推断整批部署与实机验收完成 |

## 本批改动导航

### A：右侧面板

- 页面挂载：`desktop/src/App.tsx`。
- 状态及动作：`desktop/src/state/store.tsx` 的 `computerOpen`、`toggleComputer`、`openSignIn`、`activityOpen`。
- 聊天入口：`ChatView.tsx`、`ChatMoreMenu.tsx`。
- 旧面板：`ComputerPanel.tsx`、`bot-panel/PanelShell.tsx`、`BotSettingsDialog.tsx`。
- 其他入口：`TeamMapPage.tsx`、`onboarding/GuidedTour.tsx`、`lib/page-open.ts`、`lib/place-view.ts`。

### B：浏览器接管

- 请求：`desktop/server/index.ts` 的 `requestSignIn`，消息 `kind: "signin"`。
- 卡片：`desktop/src/components/SignInRequestCard.tsx`；回答协议 `done` / `cancel`。
- 现有预览控制：`BrowserPanel.tsx`、`browser/StreamSurface.tsx`、`lib/browser-control.ts`。
- 原生浏览器：`desktop/electron/main.mjs`、`embedded-browser-runtime.mjs`、`embedded-browser-surface.mjs`。
- 当前实现缺口：移除 BrowserPanel 后没有它创建的 viewerId，原生 attach 权限、独立 Bot 窗口、关闭交还和卡片完成尚需端到端接通。

### C：新建 Bot

- 入口：`Sidebar.tsx` 派发 `newBot`，`state/store.tsx` 存储待创建动作，`App.tsx` 挂载弹窗。
- 新弹窗：`SimpleNewBotDialog.tsx`；头像复用 `BotProfileAvatarCard.tsx`。
- 创建：`lib/new-bot.ts` 的 `freeName`、`newBotDraft`、`makeNewBot`，底层 `create-configured-bot` 与 `bot-creation-draft`。
- 服务端：`desktop/server/routes/bots-create.ts`；上限 `packages/shared/bot-profile.ts` 的 `BOT_PROFILE_LIMITS.soul`。
- 当前工作区实现未验收，翻译和集成仍有未完成项。

## 开发与验证入口

先设置有效 Node：

```sh
export PATH="$HOME/.local/nodejs/node-v24.16.0-darwin-arm64/bin:$PATH"
```

| 用途 | 当前命令 |
|---|---|
| 前端开发 | `pnpm dev` |
| 本机服务开发 | `pnpm dev:server` |
| Electron 开发 | `pnpm dev:desktop` |
| 前端类型检查 | `pnpm exec tsc -b desktop` |
| 本机服务类型检查 | `pnpm exec tsc -p desktop/tsconfig.server.json` |
| 定向 Vitest | `pnpm exec vitest run <测试文件>` |
| Electron node 测试 | `pnpm test:electron` |
| 产品打包 | `pnpm package -- --lan-origin --gateway-ca <pem>` |
| 隔离假引擎 | `node --experimental-strip-types scripts/control-hezuo.ts launch` |

`pnpm package` 是唯一产品打包入口。本轮仅修改代码并执行编译与定向测试，未运行打包或部署。服务/对话验证使用隔离数据，不对用户正在使用的 app 做变更验证。
