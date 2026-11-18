# 电脑端 debug 包任务清单

## 目的

正式包登录时报"无法连接账户服务"（`network_unavailable`），但看不到底层原因。做一个只用于排错的 debug 包：装好后直接双击打开，所有操作的请求和返回都写进日志文件，用来定位问题。

## 已确认的需求

1. **只在 debug 包里开启**：打包脚本加 `--debug` 选项，只有带这个选项打出来的包才记日志，正式包里没有。不需要任何启动参数或环境变量。
2. **电脑端的所有操作都记，成功和失败都记**，共 9 类：

   | # | 类别 | 记什么 |
   |---|---|---|
   | 1 | 页面 → 主进程：账户操作 | 登录、注册、退出、查余额、看账本等每个账户操作的输入和结果 |
   | 2 | 页面 → 主进程：其他所有操作 | 主进程的全部处理入口（约 164 个）：窗口、控制电脑、语音、更新、设置、云端等，每次调用的参数和结果 |
   | 3 | 主进程 → 页面 | 主进程主动推给页面的消息，例如账户状态变化 |
   | 4 | 主进程 → 193 网关 | 每个账户接口的请求和返回 |
   | 5 | 主进程 ↔ 本机服务 | 本机服务的启动、就绪、退出、重启；双方的进程间消息，包括交 AI 令牌（`hezuo:product-ai`）、续期令牌（`hezuo:renew-ai-token`）、退出前结算（`hezuo:drain`） |
   | 6 | 页面 → 本机服务 | 所有 `/api/...` 请求和返回 |
   | 7 | 本机服务 → 页面 | 本机服务主动推给页面的实时消息：对话回复、Bot 状态、配置变化等 |
   | 8 | 本机服务 → 外部网络 | 所有出网请求：发往 193 的模型请求（流式回复按收到的顺序逐段记），以及 MCP 服务器、Composio、第三方应用、Bot 工具访问网页等其他请求 |
   | 9 | Bot 的本地动作 | 每次工具调用的开始、输出、结束：执行命令、读写文件、MCP 工具、内置浏览器操作、控制电脑 |

3. **每条日志的内容**：时间、哪一层、方法、地址、状态码、耗时、请求编号（`x-ai-request-id`，有的话）、请求正文、返回正文；失败时加上底层原因（如 `EHOSTUNREACH`、证书错误、超时）。
4. **打码**：密码、各种 token、`Authorization` 请求头、API 密钥换成 `***`，其余正文原样记。日志里会有邮箱、余额、对话内容。
5. **文件**：写到 `~/Library/Logs/Hezuo Product/debug.log`；满 10MB 换下一个文件（`debug-1.log`、`debug-2.log`……）；旧文件全部保留，不自动删。
6. **单一写入方**：本机服务的日志发给主进程，主进程管理的专用工作线程按接收顺序统一脱敏和写入同一组文件；不在主进程事件循环执行文件写入或正文脱敏。传日志本身的消息（`hezuo:debug-log`）不再记录，避免无限循环。

## 任务

| # | 任务 | 状态 |
|---|---|---|
| 0 | 补全提交：把联调分支、服务端分支合进当前目录 `feat/bot-panel-unify` | 已完成 |
| 1 | 撤掉之前临时加的改动：`control-plane-client.mjs` 里失败时 `console.error` 的那段；`entitlements.mac.plist` 里加的 `get-task-allow` | 已完成 |
| 2 | 新建 debug 日志模块：10MB 轮转、打码、只在 debug 包开启 | 已实现，轮转与脱敏测试通过 |
| 3 | 接入第 1 类：账户操作 | 已迁移统一 IPC 采集，账户测试通过 |
| 4 | 接入第 2 类：主进程其他所有处理入口 | 已实现，提前安装统一采集；真实 Electron IPC 验证通过 |
| 5 | 接入第 3 类：主进程推给页面的消息 | 已实现，真实 webContents 推送验证通过 |
| 6 | 接入第 4 类：主进程 → 193 网关 | 已实现，客户端测试通过 |
| 7 | 接入第 5 类：本机服务启停和双方进程间消息 | 已实现，生命周期及双向消息测试通过，排除日志传输递归 |
| 8 | 接入第 6 类：所有 `/api` 请求 | 已实现，HTTP/SSE/中止测试通过 |
| 9 | 接入第 7 类：本机服务推给页面的实时消息 | 已实现，事件测试通过 |
| 10 | 接入第 8 类：全部出网请求 | 部分完成：服务进程 fetch、HTTP/HTTPS 及内置浏览器网页网络元数据已接入；独立 MCP/命令行引擎等子进程内部网络未采集，不能标为完整 |
| 11 | 接入第 9 类：Bot 工具调用 | 已实现，完整原生数据私有采集，8 项事件测试通过 |
| 12 | 打包脚本加 `--debug` 选项 | 已实现，最新扩展版本标准构建及产物校验通过 |
| 13 | 单元测试：轮转、打码、非 debug 包不写日志、9 类各有记录；类型检查 | 本轮确定范围测试通过，服务端及前端类型检查通过；跨进程网络不在验收范围 |
| 14 | 打 debug dmg 放到桌面；装好后登录一次，读 `debug.log` 找出连不上 193 的原因 | 最新 debug DMG 已放桌面，旧 DMG 已删除；未安装或登录，193 根因尚未定位 |

`debug-log.mjs`、`debug-http.ts` 及四层接入来自本次开发会话；四层版本相关测试和标准构建已通过，代码未提交。九类扩展须另外验证，不能沿用四层包的验证结论。

本轮验证：服务端 `tsc -p desktop/tsconfig.server.json` 和前端 `tsc -b desktop` 通过。隔离 fake-engine 实例创建 DebugProbe，发送 `hello` 后进入 settled，消息包含 `hello from fake claude` 和 Bash 工具活动；该验证证明正常对话未被破坏，不代表真实模型或跨进程网络已验收。

真实 Electron 隔离测试通过：导入时注册的 IPC、renderer invoke/sendSync、同步 `false` 回复日志、webContents 主动推送及监听器移除/once 语义。主进程、账户、出网、服务事件测试已通过。过度打码修复后日志核心 12 项与服务端 23 项测试通过，保留 input_tokens、output_tokens、cached_input_tokens、max_output_tokens、tokenId、monkey，并继续遮蔽凭据；内置浏览器 2 项 Node 测试和真实 Electron 网络测试通过。

最新产物：`~/Desktop/Hezuo-0.1.141-arm64-debug.dmg`（294 MB），2026-11-14 20:59 替换。标准构建（含类型检查）、应用深度签名校验、DMG 校验和及 `product-debug.json` 标记检查通过。桌面旧四层 debug 包和 0.1.139 signed 包已删除。未安装或访问真实账户；第 8 类仍为部分覆盖。

### 日志阻塞修复

21:23:20 的 AI 能力更新在 96.6 秒后才收到 `ok: true`，超过 15 秒确认期限，产生 `capability_unavailable`。离线重放同一条 115725 字节记录，仅脱敏即耗时 40727 毫秒：凭据字段正则对含大量下划线和连字符的长标识触发灾难性回溯。改为有界扫描后，相同 Node 调用耗时 20.9 毫秒；该测量不输出或保存私人正文。

主进程改用私有日志工作线程，仅按有界快照排队，不执行正文脱敏或磁盘写入。默认最多排队 64 MiB 估算数据和 4096 条记录；超限明确停止接收并报告诊断失败，排空已接受记录，不静默丢弃、不回退到同步写入。正常退出等待排空，5 秒未完成则明确报告失败。工作线程阻塞时能力确认仍可完成的回归测试已通过；确认期限仍为 15 秒。

## 已找到的接入点

| 类别 | 位置 |
|---|---|
| 1 账户操作 | `desktop/electron/product-account-ipc.mjs`：`register()` 是所有账户操作的唯一入口 |
| 2 主进程其他处理入口 | `ipcMain.handle` / `ipcMain.on` 共约 164 处，分布在 `main.mjs`（92 处）和 `cua.mjs`、`updater.mjs`、`desktop-prefs.mjs` 等 19 个文件。在 `main.mjs` 最早处统一包装这两个方法，所有注册都会经过它 |
| 3 主进程推给页面 | 各处 `webContents.send(...)`，例如 `product-account-ipc.mjs` 的 `publish()` |
| 4 主进程 → 193 网关 | `desktop/electron/control-plane-client.mjs`：`request()` 是所有账户接口的唯一出口；`main.mjs` 第 756、2875 行创建这个客户端 |
| 5 本机服务启停 | `main.mjs` 启动本机服务的函数（`utilityProcess.fork`、`spawn`、`exit` 事件，现在只写进 `server.log`） |
| 5 进程间消息 | 主进程：`main.mjs` 的 `proc.on("message")` 和各处 `proc.postMessage` / `serverProc.postMessage`。本机服务：`desktop/server/index.ts` 的 `utilityParentPort.on("message")` 和 `utilityParentPort.postMessage` |
| 6 `/api` 请求 | `desktop/server/index.ts`：`handleRequest`（第 12749 行）是所有 `/api` 请求的入口 |
| 7 本机服务推给页面 | `desktop/server/index.ts`：`broadcast()`（第 4835 行），所有实时消息都从这里发出 |
| 8 发往 193 的模型请求 | `desktop/electron/product-ca.mjs`：`createPinnedHttpsFetch()`，带内置证书的产品包里所有模型请求都经过它（`desktop/server/drivers/pinned-trust.ts` → `openai-compat.ts` → `openai-chat.ts`） |
| 8 其他出网请求 | 本机服务里约 35 个文件直接调用 `fetch`。在本机服务启动时统一包装全局 `fetch`，再加 Node 的 `http`/`https` 请求 |
| 9 Bot 工具调用 | `desktop/server/harness/bus.ts`：`EventBus.deliver()`（第 280 行），所有引擎的运行事件都经过它；工具相关的是 `item.started`、`item.output`、`item.completed`（类型定义在 `packages/shared/runtime-events.ts`） |
| 9 控制电脑 | `desktop/electron/cua.mjs` 和本机服务里的控制电脑调用 |
| 本机服务发日志给主进程 | `utilityParentPort.postMessage`（`desktop/server/index.ts`）；主进程在 `main.mjs` 的 `proc.on("message")` 接收 |
| 现有日志目录 | `main.mjs` 第 517 行 `LOG_DIR = app.getPath("logs")`，即 `~/Library/Logs/Hezuo Product/` |

## 已知限制

- **Bot 内置浏览器打开的网页**：已单独接入 Electron 会话的地址、方法、状态码、耗时、重定向和失败原因，2 项 Node 测试及真实 Electron 隔离测试通过。此路径不记录返回正文；浏览器工具动作与网页网络请求是两类不同记录。
- **第 2 类里有模块在导入时就注册处理入口的**：如果注册发生在包装之前，就会漏记。动手时逐个核对这 19 个文件。
- **日志量**：第 7、8、9 类数量很大，对话一次可能写几 MB。按 10MB 一个文件轮转，旧文件不删，需要定期手动清理。
- **采集进程边界**：服务进程内的 `fetch`/`http` 包装不能覆盖独立 MCP/命令子进程或远程服务的网络请求。内置浏览器使用独立 Electron 会话采集元数据，不能据此宣称第 8 类全部完成。
- **安装与登录**：用户已要求卸载现有 App。最新 debug 包仅交付桌面，未重新安装或登录真实账户。
- **自由文本凭据**：按字段、协议头、URL、序列化正文和已知工具参数打码；任意命令输出、网页文本或对话中未标识的秘密不能保证自动识别。debug 日志仍按敏感数据保管，不能公开上传。

## 构建与隐私

```sh
HEZUO_PRODUCT_SERVICE_URL=https://192.168.66.193:18487 \
CSC_NAME='Hezuo Local Signing' \
pnpm exec node scripts/package-product.mjs \
  --platform mac --arch arm64 --debug --lan-origin \
  --gateway-ca .hezuo-scratch/remote-gateway-193/gateway-cert.pem
```

`--debug` 将 `product-debug.json` 打进资源目录；只有安装包读取到该标记才启用日志，无需启动参数或环境变量。不带 `--debug` 的构建不包含该标记，并拒绝残留标记混入正式产物。

日志包含邮箱、余额、提示词、模型回复和本地 API 正文。即使凭据已打码，也不要公开上传日志；排错结束后手动清理日志并换回正式包。自签名包未公证，首次打开可能需要右键打开。

流式 SSE 以完整事件为最小安全打码单位增量记录，事件内跨网络分块的凭据不会提前写出。

服务进程的出网响应随业务读取记录并传递取消，避免诊断副本提前拉取。主进程账户客户端仍使用响应副本，慢消费者可能增加内存占用；该开销只存在于 debug 包。

## 相关遗留（不属于 debug 包，但还没收尾）

- 代码已统一到 `feat/bot-panel-unify`（当前目录 `HezuoBot`）：合并了联调分支 `integ/desktop-gateway` 和服务端 `backend/gateway-beta` 的全部提交（`75e6f31be`）。之后只在这个目录开发和打包。
- `electron-builder.yml` 的本地网络用途声明 `NSLocalNetworkUsageDescription` 已提交。
- 打包脚本直接用 `node` 运行时找不到 `electron-builder`（只在 `node_modules/.bin` 里），要用 `pnpm` 运行或把 `.bin` 加进 `PATH`。
- `desktop/server/mcp-bridge.test.ts` 的 `Promise.withResolvers` 已获准改为等价的 ES2023 写法；该测试与打包配置测试共 48 项通过。
- 自签名证书 `Hezuo Local Signing` 已导入本机钥匙串。签名版 dmg 在桌面 `Hezuo-0.1.139-arm64-signed.dmg`，首次打开会被 Gatekeeper 拦，要右键打开。
- 签名、本地网络权限、`--lan-origin` 打包的交接文档还没写。
