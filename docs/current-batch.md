# 第 1 批需求：精简电脑端界面，统一为 HezuoBot

> 状态：开发中。完成并验收后，整份移到 `docs/archive/`，下一批另开新文档。
>
> 文档规则：每一批需求只有这一份文档，电脑端、网关、手机端的改动都写在这里，不拆成多份。做完一批归档一批。

### 基线整理与验证（2026-11-14）

- 已有面板式浏览器接管改动：6 个定向测试文件初次运行 159 通过、1 条旧文案断言失败；删除固定措辞测试后，该文件 29 项通过，其余 5 个文件此前已通过。
- `pnpm exec tsc -b desktop` 与已有改动代码的定向 `oxlint --deny-warnings` 通过。
- 隔离预览初次因 `@/` 别名未解析而空白；共享预览入口显式加载 `desktop/vite.config.ts` 后恢复。真实页面验证接管获得控制、关闭面板、重新打开保留测试页。
- 隔离日志：`server-1794666972296-56650.log`（系统临时目录的 `hezuo-verification-evidence/`）；重新打开截图：`/var/folders/s0/5h112y2d3495p65t6p7cph400000gn/T/omp-sshots-15cdecb9c2bb0b2e.webp`。
- 以上仅为已有改动的基线验证，不代表 A/B/C 或独立浏览器窗口接管验收通过；Cookie、真实登录和多 Bot 窗口仍未验证。

## 这一批做什么

| # | 需求 | 范围 |
|---|---|---|
| A | 去掉 Bot 对话右侧的整个面板 | 电脑端界面 |
| B | 需要用户登录、扫码时，聊天里提示接管浏览器；接管时浏览器窗口到前台，关掉窗口就交还给 Bot | 电脑端界面、主进程 |
| C | 新建 Bot 时选头像、填提示词 | 电脑端界面 |
| D | 项目只剩 HezuoBot：去掉 OpenMausBot 等所有旧名字、上游作者和上游服务；删掉不用的功能；只打一种安装包 | 电脑端、网关、手机端、仓库 |

## 先后顺序

1. **先做 A、B、C**：改动集中在电脑端界面，量小，先交付。
2. **再做 D**：改动量很大（几千个文件），而且会改文件名、目录名。A、B、C 合进来之后再开始，避免冲突。
3. D 内部按"D5. 分几步做"的顺序，每步单独提交、单独验收。

## 上一批遗留，带到这一批

上一批的文档都已归档到 `docs/archive/`。下面是归档时还没做完的事项，这一批要么做完，要么写明不做：

| 来源 | 遗留事项 | 这一批怎么处理 |
|---|---|---|
| `archive/desktop-beta-todo.md` D0 | 拖拽合组：打包 app 里实拖验收；空分组的删除入口 | A 去掉右侧面板后，在打包 app 里重新验收侧栏拖拽 |
| `archive/desktop-beta-todo.md` D1 | 真实 token 数：发一句"你好"不超过 8000 输入 token，没在 193 上验证。实测带网页的对话已到 14 万–26 万 token | 在 193 上验证；超出就单独列为问题 |
| `archive/desktop-beta-todo.md` D2、D3、D4 | 退出登录不冻结积分、自动选模型、工具调用不追问：没在 193 上实测 | 在 193 上实测 |
| `archive/desktop-beta-todo.md` D6 | 左下角还写"点数余额"，其他地方叫"积分" | 统一成"积分" |
| `archive/desktop-beta-todo.md` D12 | macOS 签名和公证：没有 Developer ID 证书 | 不在这一批做，等证书 |
| `archive/desktop-beta-todo.md` D13 | 真实手机和远程配对没测 | D 改完手机端后一起测 |
| `archive/desktop-debug-build-todo.md` | debug 日志：打码规则会漏掉 `companionToken`、`fishKey`、`openrouterKey` 等字段；第 8 类子进程网络记不到；193 连不上的根因没定位 | 修打码规则（按字段名最后一个词判断）；193 连接问题现在已能登录，确认后关闭 |
| `archive/gateway-beta-delivery.md` | S3 中转站后台对账；`beta-a` 账号的待复核结算和删除 | 不在这一批做，留到统一测试 |
| `archive/gateway-admin-console-todo.md`、`archive/gateway-admin-development-spec.md` | 管理后台重新设计 | 不在这一批做，下一批单独开 |
| `archive/desktop-bot-control-phase1-todo.md` | Bot 全对话操控第一期，全部未开始 | 不在这一批做 |

## A、B、C：精简 Bot 面板、浏览器接管、新建 Bot

### 背景

现在 Bot 对话右侧有一个面板，分"详情 · 活动 · 资料库 · 电脑"四页，"电脑"下面又有"屏幕 · 浏览器 · 数据 · 文件"。产品只保留聊天，需要用户动手时在聊天里给一个提示。

另外，内置浏览器在面板里一直显示"Starting the browser…"，看不到网页：内置浏览器不发截图帧，面板却在等第一帧（`desktop/src/components/BrowserPanel.tsx` 第 225 行显示遮罩，第 388 行只在收到截图帧时撤掉）。面板去掉后，这个问题随之消失，不用单独修。

### 需求（已和产品确认）

#### A. 去掉整个右侧面板

1. Bot 对话右侧的面板全部不显示：详情、活动、资料库、电脑，以及电脑下的屏幕、浏览器、数据、文件。
2. 打开面板的所有入口都去掉：标题栏的按钮、菜单项、快捷键，以及代码里自动打开面板的地方（`toggleComputer` / `computerOpen` 共 11 处，见"接入点"）。
3. **只是不显示，功能保留**：Bot 照样能用浏览器、读写文件、查数据、控制电脑。本机服务和主进程的相关接口不改。
4. 聊天区域占满原来面板的位置。

#### B. 浏览器接管：只在需要用户时提示

1. **什么时候提示**：只在 Bot 自己做不了、需要用户本人操作的时候，例如登录、扫码、验证码。也就是现在 Bot 调用 `request_sign_in`、聊天里出现"需要登录"卡片（`SignInRequestCard`）的时候。Bot 只是打开、浏览网页时**不提示**。
2. **提示的样子**：聊天里只留一张卡片，只说明一件事，例如：
   > Hezuo 需要你在浏览器里登录 passport.baidu.com。
   >
   > [接管浏览器]　[取消]
   - 卡片上不再有"打开""保存登录信息""完成"等其他按钮。
   - 卡片不写技术细节，不提"内置浏览器""标签页"。
3. **点"接管浏览器"**：
   - 弹出 Bot 正在用的浏览器窗口，放到最前面，并且获得焦点；
   - 窗口里就是 Bot 当前的网页，跟 Bot 用的是同一个浏览器、同一份登录状态；
   - 用户可以直接在窗口里点击、输入、扫码；
   - Bot 等着，不再操作这个浏览器。
4. **交还给 Bot：关掉窗口**
   - 用户关掉这个浏览器窗口，就算交还，Bot 接着做。
   - 关窗口时**不能关掉网页、不能丢掉登录状态**：只是把窗口收起来，网页和 Cookie 保留，Bot 继续用同一个页面。
   - 关掉后，聊天里的卡片变成"已交还给 Hezuo"，不能再点。
5. **点"取消"**：等同于现在卡片上的取消，Bot 收到"用户取消"，不弹窗口。
6. **窗口已经开着**：再点一次"接管浏览器"，只把窗口拉到最前面，不开第二个。
7. **多个 Bot**：每个 Bot 的浏览器窗口各自独立，窗口标题写明是哪个 Bot，例如"Hezuo 的浏览器"。

#### C. 新建 Bot 时选头像、填提示词

1. 现在点侧栏的"新建机器人"会直接建一个随机名字的 Bot，不弹窗口。改成先弹一个**新建窗口**，填完再建。
2. 窗口里只有这几项：
   - **头像**：
     - 默认头像（吉祥物形象），可以换颜色、换形象；
     - 上传图片作为头像。
     - 复用设置页现有的头像组件 `BotProfileAvatarCard`。
   - **名字**：必填，预先填一个不重名的名字（沿用现在的 `freeName`）。
   - **提示词**：一个多行输入框，写这个 Bot 要做什么、怎么做。
     - 可以不填；
     - 最多 24,000 字节，跟现有的 SOUL.md 上限 `BOT_PROFILE_LIMITS.soul` 一致；
     - 写进 Bot 的 `soul`（SOUL.md），进系统提示的"Standing instructions"那一段。
3. 底部两个按钮：**创建**、**取消**。点创建后建好 Bot，选中它，进入对话。
4. 窗口里**不要**其他选项：模型、权限、电脑、技能、记忆、所属部门等都用默认值。
5. 建好后，设置里照样能改头像、名字、提示词。

### 验收

#### A. 右侧面板
- [ ] Bot 对话里看不到右侧面板，也找不到打开它的入口。
- [ ] 之前会自动打开面板的情况（Bot 登录、打开浏览器、控制电脑、新手引导）都不再打开面板，也不报错。
- [ ] 让 Bot "打开百度，读一下首页标题"，Bot 照样能完成并回复。

#### B. 浏览器接管
- [ ] 让 Bot "打开百度"：只回复内容，不出现任何接管提示。
- [ ] 让 Bot "登录百度"：聊天里出现一张卡片，只有"接管浏览器""取消"两个按钮。
- [ ] 点"接管浏览器"：浏览器窗口出现在最前面，显示的是百度登录页，能看到二维码。
- [ ] 窗口已开时再点一次：不开第二个窗口，只把现有窗口拉到前面。
- [ ] 在窗口里扫码登录后关掉窗口：卡片变成"已交还"；Bot 接着检查，结果是"已登录"。
- [ ] 关窗口后让 Bot "刷新一下百度首页"：仍是登录状态，没有被退出。
- [ ] 点"取消"：不弹窗口，Bot 回复用户取消了登录。
- [ ] 两个 Bot 各自要求登录：各自弹出自己的窗口，标题能区分，互不影响。

#### C. 新建 Bot
- [ ] 点"新建机器人"弹出窗口，只有头像、名字、提示词三项和创建、取消两个按钮。
- [ ] 不改任何东西直接创建：Bot 用默认头像和预填的名字。
- [ ] 换颜色或形象、上传图片：侧栏头像和对话里的头像都是新选的。
- [ ] 提示词填"你只用中文回答，每次回答不超过三句话"，创建后发"介绍一下你自己"：回复是中文、不超过三句。
- [ ] 提示词超过 24,000 字节：创建按钮不可点，并提示超长。
- [ ] 点取消：不创建任何 Bot。
- [ ] 名字为空：创建按钮不可点。

#### A、B、C 通用
- [ ] 前端类型检查 `npx tsc -b desktop` 通过；改到的文件 `npx oxlint --deny-warnings` 无新警告。
- [ ] 改到的组件和状态都有单元测试；删掉的组件，相关测试一起删掉，不留跳过的测试。
- [ ] 中文、英文文案都补全，新文案不出现英文占位。
- [ ] 每项验收附截图或日志。没通过的单独列出，不要写成已通过。

### 接入点

| 功能 | 位置 |
|---|---|
| 右侧面板外壳 | `desktop/src/App.tsx` 第 460–476 行：`BotSettingsDialog`、`ComputerPanel` |
| 面板页签 | `desktop/src/components/bot-panel/PanelShell.tsx`、`page-registry`；电脑子页 `desktop/src/components/computer-panel-tabs.ts` |
| 打开面板的状态 | `desktop/src/state/store.tsx`：`computerOpen`、`toggleComputer`（第 1489 行）、`openSignIn`（第 1480 行，会自动打开面板） |
| 自动打开面板的其他地方 | `App.tsx`、`ChatView.tsx`、`TeamMapPage.tsx`、`bot-panel/ComputerTab.tsx`、`bot-panel/PanelShell.tsx`、`bot-settings/AccessSection.tsx`、`onboarding/GuidedTour.tsx`、`lib/page-open.ts`、`lib/place-view.ts` |
| 登录卡片 | `desktop/src/components/SignInRequestCard.tsx`：`open()` 第 117 行，`answer("done" \| "cancel")` 第 59 行 |
| 本机服务发起登录请求 | `desktop/server/index.ts`：`requestSignIn()`（第 11737 行），生成 `kind: "signin"` 的消息 |
| 浏览器独立窗口 | `desktop/electron/main.mjs` 第 1324 行 `createFallbackWindow`（现在标题是 "Hezuo Browser"）；`desktop/electron/embedded-browser-surface.mjs`：`fallbackHost()`，关窗口时（`closed` 事件）现在会**关掉所有网页**，要改成只收起窗口 |
| 新建 Bot 入口 | `desktop/src/components/Sidebar.tsx` 第 1155、1679 行发 `{ type: "newBot" }`；`desktop/src/state/store.tsx` 第 2611 行；`desktop/src/lib/new-bot.ts` 的 `makeNewBot` 直接调 `POST /api/bots` |
| 新建 Bot 接口 | `desktop/server/routes/bots-create.ts`：已接受 `name`、`avatarUrl`、`color`、`mascotBody`、`soul` |
| 头像组件 | `desktop/src/components/BotProfileAvatarCard.tsx` |
| 现有新建窗口（可参考，不要整套搬过来） | `desktop/src/components/NewBotDialog.tsx` |
| 提示词上限 | `packages/shared/bot-profile.ts`：`BOT_PROFILE_LIMITS.soul = 24_000` |

### 注意

1. **关窗口不能关网页**：现在独立窗口的 `closed` 事件会把里面的网页全部关掉（`embedded-browser-surface.mjs` 第 27–31 行）。这里必须改，否则用户扫码后一关窗口，登录状态就丢了。
2. **接管期间 Bot 不能操作浏览器**：沿用现有的接管机制（`接管控制` / `browser.control.take`），窗口打开就算用户接管，关掉就交还。
3. **不改本机服务的接口**：`request_sign_in` 工具、`kind: "signin"` 消息、卡片的 `done` / `cancel` 回传都保留，只改界面怎么展示、窗口怎么开关。
4. **不区分版本**：项目只有电脑端、网关、手机端三部分，没有单独的开源版。直接改，不加版本判断。
5. 遵守仓库 `AGENTS.md` 的注释规则。

## D：项目只剩 HezuoBot

### 目标

1. 仓库里只有 **HezuoBot**。`OpenMausBot`、`MausBot`、`OMB`、`ogb`、上游作者名字和上游网址全部去掉，不留兼容代码，不留迁移代码。
2. 项目只有三部分：**电脑端**（`desktop/`）、**网关**（`gateway/`）、**手机端**（`mobile/`），加上它们共用的 `packages/shared/` 和构建脚本 `scripts/`。
3. 所有联网功能只连你们自己的网关（现在是 `https://192.168.66.193:18487`），不连任何上游服务器。
4. 只打一种安装包。

### 现状（2026-11-14，`feat/bot-panel-unify`）

统计排除了 `node_modules`、打包产物（`release/`、`dist*`）、`.omb-scratch`、`third_party`、`references`、`.git`。

| 旧名字 | 文件数 | 出现次数 |
|---|---|---|
| `OpenMausBot` | 274 | 9,660 |
| `openmausbot` | 445 | 1,660 |
| `MausBot` | 302 | 10,547 |
| `mausbot` | 497 | 1,989 |
| `OMB_`（环境变量前缀） | 921 | 5,375 |
| `omb-` | 1,047 | 2,708 |
| `omb_` | 198 | 508 |
| `ogb`（`window.ogb` 等） | 441 | 1,167 |
| `milind-soni`、`Milind`、`Omkar` | 约 140 | 约 850 |

运行代码里直接连上游服务器的有：
- `accounts.openmausbot.com`：`desktop/electron/companion-account-service.mjs`、`cloud-account.mjs`；
- `cloud.openmausbot.com`："我的云端"；
- `device.openmausbot.com`：手机远程连接；
- `desktop/server/devs-report-send.ts`：把 bug 报告发给上游作者；
- `desktop/server/highlevel/relay.ts`：HighLevel 集成的中继；
- `desktop/src/lib/whats-new.ts`："新功能"链接；
- `desktop/electron/managed-composio.mjs`：第三方应用连接（Composio）默认走上游作者的 `openmausbot-composio.milindsoni201.workers.dev`。

你们的网关已经有手机中继：`gateway/local/local-gateway/companion-relay.mjs`。手机用同一个 Hezuo 账号登录网关，网关通过电脑主动连上来的通道转发给电脑。电脑端连它的代码已经在：`desktop/electron/gateway-companion-tunnel.mjs`、`managed-companion-tunnel.mjs`、`managed-companion-guardian*.mjs`。

### D1. 删除

按下面的顺序一块一块删。每删一块都要：跑测试；打包；装上能登录、能跟 Bot 对话、Bot 能用浏览器。

#### 1. 上游的云服务和上游连接

| 删什么 | 位置 |
|---|---|
| "我的云端（My Cloud）"：把 Bot 搬到云上运行、云端首页、云端套餐和购买、云端同步、团队云、在两个地方之间移动 Bot | `desktop/electron/` 下 `cloud-*`、`home-window*`、`one-home-main*`、`team-move-main*`、`two-places*`、`place-look*`、`chrome-rail*`、`cloud-rail*`；`desktop/server/` 下 `cloud-*`、`hosted*`、`bot-box/`、`fleet-*`、`routes/cloud-*`；`desktop/src/` 里对应的页面、设置项和文案；`connector/` 整个目录 |
| 走上游账号的手机配对和远程连接 | `desktop/electron/companion-account-service.mjs`、`cloud-account.mjs`；`desktop/companion/` 里连 `device.openmausbot.com` 的部分（`OMB_COMPANION_HOSTED_URL`、`hostedCompanionUrl`） |
| 给上游作者发 bug 报告（`@devs`） | `desktop/server/devs-report-send.ts`，以及"Milind 和 Omkar 会收到"之类的文案（所有语言） |
| HighLevel 集成的上游中继 | `desktop/server/highlevel/`，以及界面里的 HighLevel 入口 |
| "新功能"里的上游链接 | `desktop/src/lib/whats-new.ts` |
| Composio 的上游代理 | `gateway/composio-broker/`，以及电脑端连它的 `desktop/electron/managed-composio.mjs`（默认地址是上游作者的 `openmausbot-composio.milindsoni201.workers.dev`）。删掉后，"连接应用"里依赖它的第三方应用不能用；用户自己填 Composio API 密钥的方式保留 |

**保留**：网关自己的手机中继（`companion-relay.mjs`）和电脑端连网关的通道（`gateway-companion-tunnel.mjs`、`managed-companion-*`）。手机配对、远程连接只走这条路。

#### 2. 不用的部署方式和打包

| 删什么 | 位置 |
|---|---|
| 本机服务部署到服务器 | `Dockerfile`、`compose.yaml`、`deploy/`，`docs/deploy-vps.md`、`docs/byo-vps.md`、`docs/self-hosting.md`、`docs/cloud-pro.md`、`docs/team-cloud.md` |
| 本机服务里只给服务器模式用的代码：自定义域名、邮箱验证码登录、内网穿透 | `desktop/server/account-signin.ts`、自定义域名设置、`cloudflared` 相关打包和代码 |
| 开源版打包 | `package.json` 的 `package:mac`、`package:win`、`package:linux`、`package:linux:offline`、`package:linux:dir`；`electron-builder.yml` 的上游 `publish` 和 `appId: com.hezuo.app` |
| 只给开源版用的命令行和 npm 包 | `scripts/build-npm-package.mjs`、`desktop/server/cli.ts`、`fleet-cli.ts` 等 |

**保留**：网关在 193 上的部署方式（`gateway/local/`、`docs/gateway-deployment-193.md`）。

#### 3. 上游的其他东西

| 删什么 | 位置 |
|---|---|
| 企业版 | `enterprise/` 整个目录；`desktop/server/enterprise.ts`、`proxy-paths.ts` 里对它的引用 |
| 上游文档网站 | `apps/` 整个目录 |
| 上游的行为评测 | `evals/` 整个目录 |
| 上游的 CI | `.github/workflows/` 里除 `ci.yml` 以外的全部文件；`ci.yml` 改成只跑电脑端、网关、手机端 |
| 上游社区文件 | `CLA.md`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`HANDOFF.md`、`LICENSING.md`、`.oss-scanner/` |
| 上游的许可证和版权声明 | `LICENSE`、`NOTICE` 的现有内容；`electron-builder.yml` 的 `extraResources` 里 `licenses/OpenMausBot-*`；`third_party/` 下不再使用的代码和许可证 |
| 旧数据迁移 | `desktop/electron/product-profile-migration.mjs`（从 `OpenMausBot Product` 迁移）、`desktop/electron/default-data-root-migration.mjs`、`gateway/local/local-gateway/identity-migration.mjs`，以及其他只为兼容旧版存在的迁移代码。网关的迁移代码删之前，确认 193 上的数据库已经是新格式 |
| 本地参考资料 | `references/`（不在 git 里，直接删目录） |

### D2. 改名

| 旧 | 新 | 范围 |
|---|---|---|
| `OpenMausBot`、`MausBot`、`Open Maus` | `HezuoBot` | 界面文字（所有语言）、文档、注释、包描述 |
| `openmausbot`、`mausbot` | `hezuobot` | 包名、目录名、文件名、域名 |
| `com.openmausbot.companion.*` | `com.hezuobot.companion.*` | Android 包名，连同 `mobile/android/app/src/*/kotlin/com/openmausbot/` 目录 |
| iOS 里带 openmausbot 的 bundle id | `com.hezuobot.*` | `mobile/ios` 的工程配置、`Info.plist` |
| `openmausbot://`、`omb://`、`hezuo://` | `hezuobot://` | 网址协议，只留这一个 |
| `OMB_*` | `HEZUO_*` | 环境变量。电脑端、网关、脚本、测试、文档同时改 |
| `omb-*`、`omb_*` | `hezuo-*`、`hezuo_*` | 文件名、目录名、请求头、日志标签、存储键。例如 `.omb-scratch` 改成 `.hezuo-scratch` |
| `window.ogb`、`ogb` 类型 | `window.hezuo` | `desktop/electron/preload.cjs`、`desktop/src/types/ogb.d.ts`（改名为 `hezuo.d.ts`），以及所有用到它的文件 |
| `milind-soni/OpenMausBot` | 删掉 | 所有链接 |
| `fuhao009/OpenMausBot` | `fuhao009/HezuoBot` | `package.json` 的 `repository`、文档。GitHub 上的仓库先改名，本地远端 `personal` 的地址也要改 |
| 应用标识 `com.hezuo.app`、`com.hezuo.product` | `com.hezuobot.app` | 只留一个 |
| 应用名 `Hezuo`、`Hezuo Product` | `HezuoBot` | 窗口标题、菜单、关于页、dmg 名字 |
| 数据目录、日志目录 | `~/Library/Application Support/HezuoBot`、`~/Library/Logs/HezuoBot` | 不再有 `Hezuo Product` |

**新写这三个文件**：
- `README.md`：HezuoBot 是什么，电脑端、网关、手机端各自怎么开发、打包、部署；
- `LICENSE`：你们自己的许可证；
- `SECURITY.md`：你们自己的安全问题联系方式。

`scripts/product-release.mjs` 的 `AUTHOR_DOMAINS` 是打包时的安全检查：防止安装包指向别人的域名。改成只检查你们的规则，不再写上游域名。

### D3. 打包统一成一个

1. 只保留一条打包命令：`pnpm package`。`electron-builder.yml` 和 `scripts/package-product.mjs` 合成一份配置，不再一个当底稿、一个去覆盖。
2. 应用标识 `com.hezuobot.app`，应用名 `HezuoBot`。
3. 没有自动更新。以后需要再接你们自己的更新地址。
4. 打 193 的包：`pnpm package -- --lan-origin --gateway-ca <网关证书>`，写进 `docs/product-release.md`。
5. debug 包照旧用 `--debug`。日志目录跟着改成 `~/Library/Logs/HezuoBot`。

### D4. 网关和手机端跟着改

1. **网关**：环境变量从 `OMB_LOCAL_*` 改成 `HEZUO_LOCAL_*`。193 上 `hezuo-gateway.service` 的配置要同时改：
   - 部署前停服，完整备份数据和代码；
   - 按 `docs/gateway-deployment-193.md` 的流程部署。
2. **手机端**：包名改了，等于一个新应用。手机上的旧版要卸载重装，重新登录、重新配对。手机端只连网关，不连任何上游地址。

### D5. 分几步做

每一步单独提交、单独验收、能单独回退。不要一次全改。

1. 先把工作区里没提交的改动（debug 日志、面板简化等）提交或合并。
2. 按"D1. 删除"的 1 → 2 → 3 删。
3. 按"D2. 改名"改，顺序是：
   1. 环境变量（电脑端、网关、脚本同时改）；
   2. `window.ogb`；
   3. 手机端包名；
   4. 应用标识、应用名、目录；
   5. 文字和文档。
4. 按"D3. 打包统一成一个"合并打包配置。
5. 部署网关到 193。
6. 手机端重新打包。
7. 全量验收。

### D 的验收

每一项都附命令输出或截图。没做完、没通过的单独列出，不要写成已完成。

#### 1. 旧名字和上游

- [ ] 下面的命令**没有任何输出**：
  ```sh
  grep -rIil -E "openmausbot|mausbot|open maus|milind|omkar|\bOMB_|\bogb\b|omb-|omb_" . \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=release \
    --exclude-dir=dist --exclude-dir=dist-server --exclude-dir=dist-companion --exclude-dir=dist-native
  ```
- [ ] 下面的命令**没有任何输出**，代码里没有任何上游网址：
  ```sh
  grep -rIn -E "https?://[a-z0-9.-]*(openmausbot|mausbot)" . \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=release
  ```
- [ ] 安装包里也搜不到：
  ```sh
  grep -rIil -E "openmausbot|mausbot|milind|omkar" /Applications/HezuoBot.app/Contents/Resources
  ```
- [ ] app 运行时抓包（或者看 debug 包的 `server->external` 和 `main->gateway` 日志），除了你们的网关、模型上游，以及用户自己让 Bot 访问的网站，没有连任何别的地址。

#### 2. 目录

- [ ] 顶层只剩：`desktop/`、`gateway/`、`mobile/`、`packages/`、`scripts/`、`skills/`、`docs/`，以及 `README.md`、`LICENSE`、`SECURITY.md`、`AGENTS.md`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig.tsbuildinfo` 之外的构建配置文件。`third_party/` 只在还有第三方代码时保留。
- [ ] `apps/`、`connector/`、`enterprise/`、`evals/`、`deploy/`、`references/`、`Dockerfile`、`compose.yaml` 都不存在。
- [ ] `.github/workflows/` 只有 `ci.yml`。

#### 3. 电脑端

- [ ] `pnpm package -- --lan-origin --gateway-ca <证书>` 打出 `HezuoBot-<版本>-arm64.dmg`。
- [ ] 安装后，应用名、窗口标题、菜单、关于页都显示 HezuoBot。
- [ ] 数据在 `~/Library/Application Support/HezuoBot`，日志在 `~/Library/Logs/HezuoBot`，没有 `Hezuo Product` 目录。
- [ ] 能登录 193 的账号，余额显示正确。
- [ ] 新建 Bot、跟 Bot 对话、Bot 用浏览器打开网页并读出内容，都正常。
- [ ] 设置里找不到"我的云端"、云端套餐、团队云、自定义域名、发 bug 报告给开发者。
- [ ] 网址协议 `hezuobot://` 能唤起 app；`openmausbot://`、`hezuo://` 不能。
- [ ] 前端类型检查 `npx tsc -b desktop`、本机服务类型检查 `npx tsc -p desktop/tsconfig.server.json`、`pnpm lint`、电脑端全部测试都通过，没有跳过的测试。

#### 4. 网关

- [ ] 网关测试全部通过。
- [ ] 193 上用 `HEZUO_LOCAL_*` 配置启动，`systemctl status hezuo-gateway` 是 active，`/healthz` 返回 `ok:true`。
- [ ] 已有账号能登录，余额、账本跟部署前一致。
- [ ] 管理后台 `/admin` 能打开，能查到账号。

#### 5. 手机端

- [ ] Android、iOS 都能编译，包名是 `com.hezuobot.*`。
- [ ] 手机用同一个账号登录网关后，能连上电脑，看到 Bot 列表，能发消息、收到回复。
- [ ] 手机端运行时只连网关，不连任何上游地址。

### D 的风险

1. **改动量很大**：几千个文件、上万处。必须分步做，每步都能单独回退。
2. **193 网关**：环境变量改了，部署时配置没跟着改，网关就起不来。部署前必须备份。
3. **已装的电脑端和手机端**：应用标识、数据目录、包名都改了，已装的 app 里的登录状态、本地 Bot 和对话都看不到了。不做迁移。内测用户要重新安装、重新登录，事先通知他们。
4. **许可证**：发布出去的代码里，只要还有别人的代码，就要带上它的许可证和版权声明。`LICENSE` 和 `NOTICE` 换成你们自己的之前，先确认代码已经全部重写，或者咨询律师。
5. **跟正在做的开发冲突**：先把没提交的改动合进来，再开始改名。

## 这一批的完成标准

- [ ] A、B、C、D 的验收清单全部勾完，每一项附截图或命令输出。
- [ ] "上一批遗留"表里每一项都有结果：做完的附证据；不做的写明原因。
- [ ] 没做完、没通过的单独列出，不写成已完成。
- [ ] 全部完成后，本文档移到 `docs/archive/`，文件名前加上完成日期，例如 `archive/2026-11-20-batch-1.md`。
