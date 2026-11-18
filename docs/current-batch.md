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

### 当前执行范围与阶段证据

- **旧偏好迁移移除范围**：删除旧偏好迁移模块及 ComputerPanel、call-mode、last-bot-section、last-conversation、launch-dialogs、local-voice、place-view、sidebar-preferences、main 的副作用导入。未迁移的旧版 `hezuobot.*` 偏好不再导入为 `hezuo.*`；现行偏好键与已保存值保持不变，不清空 localStorage/sessionStorage，不重置当前用户数据，也不另行删除遗留旧键。随模块移除旧启动弹窗标记转换，不改当前弹窗行为。源码检索未发现仅验证旧迁移的专属断言，保留现行偏好正常行为测试。本次按要求不运行检查、测试、构建或格式化。
- **旧兼容清理验证**：移除 `OGB_PORT` 回退，旧变量改为明确拒绝并提示 `HEZUO_PORT`，相关2文件8项测试通过；旧偏好迁移删除后7文件39项当前偏好测试通过，`pnpm typecheck` 与 `pnpm lint` 均退出码0。索引已刷新（45,514 节点、237,147 关系）。这些桌面修改晚于上述最新包构建，最终包仍须补重建；193网关部署不受影响。
- **最新范围：手机端退役**。用户明确“手机端全部删干净，目前不需要”。删除 Android/iOS 工程、专属构建测试与 CI、文档和运行入口，不再要求手机编译、签名、配对实机验收。此前手机改名和编译结果仅为已退役实现的历史证据，不列为当前交付。桌面与网关通用能力保留，手机专属依赖按闭包删除，未经验证不标完成。GitHub 仍按用户要求不动。
- **手机删除阶段验证（非完成）**：`mobile/` 与 Android 工具产物已不存在；已删除原生专属生成器分支、构建入口、设置/配对推广、手机执行工具、凭据提交桥和 APNs 源码。前端、本机服务、网关、桌面 companion 此前均编译通过；打包/网页资源生成 8 项、本地配对/侧车/源码检查 40 项、CLI/代理/设置 46 项回归通过。此前索引 ready（45,534 节点、237,244 关系）仅对应当时源码，不证明删除闭包完成。
- **包内复查发现遗漏**：手机删除后的 arm64 DMG/ZIP 构建成功，但资源仍包含 `server/desktop/server/routes/team-phone.js`（对应源码仍存在）及 `companion/phone-secret-key.js`（源码已删，构建未清理旧输出）。手机专属接口删除尚未完成，不能将此前编译通过作为完成证据；继续修复并重建复查。
- **尚未覆盖**：193 当前仍是此前部署版，尚未部署本次 APNs 删除；生产账号与真实模型验收不由下述隔离夹具替代。保留已应用数据库迁移历史和旧表，不在线删除数据；不能将源码删除说成线上已删除。百度登录/扫码测试按用户要求取消。
- **残留修复与新包复测**：删除手机专属 `team-phone` 路由及授权白名单，将通用 `sessionMember` 提取至会话成员模块；companion 构建先清空旧输出。8 个回归文件共 179 项通过。重建 arm64 DMG/ZIP 成功，包内两个遗漏文件均不存在，手机专属文件名候选扫描为空。新包隔离账号全流程通过（30 步、28 张截图、0 错误、5 次夹具推理请求），收据为 `/private/var/folders/s0/5h112y2d3495p65t6p7cph400000gn/T/hezuo-product-verify-BLmN1x/evidence/receipt.json`；覆盖账号切换、聊天、工具批准/拒绝、余额不足、无右侧面板和简化新建 Bot。夹具上游不是真实模型，不证明生产模型任务、提示词遵循、浏览器接管或系统钥匙串已验收。构建仍未签名/公证。
- **本轮索引与193只读核对**：代码索引刷新 ready（45,522 节点、237,154 关系，4 处局部解析限制）。193 服务 active/running，工作目录 `/var/lib/hezuo-gateway`，运行用户 `hezuo-gateway`；既有切换备份仍为 root 私有 0700。文档旧数据库路径已不存在，当前数据库候选位于 `state/d1/miniflare-D1DatabaseObject/f609ce580f7cf4852707d4b4b482cbc1312a27e491311d71fa7cfc37a59ba2ad.sqlite`；尚未读取业务数据核验、未执行本轮备份或部署。
- **安全政策范围变更**：用户要求先删除 `SECURITY.md`，后续自行补充；已移除 README 中对应链接，不编造私密联系地址，不再以配置该渠道作为本批完成条件。正式发行的签名、公证及相应证据仍未完成。
- **后续收尾验证**：清理无安全用途的测试旧品牌 host 与消息示例，保留必要法律声明、旧变量及旧令牌拒绝规则；相关 3 个测试文件 149 项通过，原生窗口/companion 浏览器 8 项 Node 回归通过，未当作真实模型或人工浏览器验收。`git diff --check` 通过，索引再次刷新 ready（45,517 节点、237,147 关系，4 处局部解析限制）。
- **193实际配置已核实**：启动程序为 `/opt/hezuo-gateway/runtime/node_modules/node/bin/node /opt/hezuo-gateway/app/gateway/local/local-gateway.mjs start --config /var/lib/hezuo-gateway/gateway.json`；只读确认当前数据库有 8 个余额账号，推理账本 `review=9`、`settled=320`，部署文档已更新路径。尚未执行本轮停服备份、部署与部署后对账，部署任务仍未完成。
- **真实模型验收阻塞**：现有独立原生浏览器验收脚本要求的 `.hezuo-scratch/development-test-credentials.md` 不存在；不读取日常账号、不伪造登录或模型结果。百度登录/扫码继续取消，其他真实模型和浏览器接管人工项维持未验收。
- **剩余旧名审计**：当前源码清单扫描仍命中 22 个文件，上游域名 URL 扫描为空。剩余分类包括 LICENSE 配套 NOTICE/第三方来源及修改声明、旧环境变量与令牌拒绝规则及测试、持久化内置 MCP 名称防冒用保留、已应用数据库迁移历史、用户要求不动的 GitHub/作者仓库元数据、旧 scratch 排除项和本验收文档。此分类不等于原“零匹配”验收通过，不为清零删除法律声明或安全规则；旧名清理任务仍按原清单保持未完成。
- **最新清理授权**：用户授权在不影响电脑端和网关的前提下直接清理无用或不确定内容，无需逐项询问；先核对依赖，保留必要认证、数据保护和法律声明，不以删除有效测试掩盖回归。
- **全量集成检查未通过**：串行类型检查/Vitest/Electron 任务 600 秒超时，未输出阶段退出码。类型检查日志无诊断；Vitest 已记录 6 个测试文件合计 22 项失败（Codex 2、服务入口 9、存储 7、Composio 1、CI 范围 2、浏览器宿主 1），尚未产生最终汇总；Electron 阶段日志不存在，不宣称已执行。本轮继续区分退役功能断言与真实回归后处理。
- **独立类型检查结果**：重新单独执行 `pnpm typecheck`，退出码 0；该结果覆盖前端与本机服务 TypeScript。Electron 改为独立运行，失败测试修复与全量分片检查尚未完成，不能据类型检查通过标记整套通过。
- **独立Electron结果**：`pnpm test:electron` 退出码 1，932 项中 910 通过、16 失败、6 项既有跳过。失败集中于退役 Cloud/更新桥接及主窗口静态接线断言，另含受保护路径大小写测试；正在核对当前实现，不新增跳过项、不删除有效路径保护断言。
- **真实回归修复验证**：`Store.sections` 改为纯读取，保留空分组及已有归属，不再读取即写盘/撤销权限；显式移动/删除与精确授权撤销顺序保留。Store 全部 166 项测试通过。借出授权、组织入口、受保护目录相关 Node 测试 54 项中 52 通过、0 失败、2 项既有跳过；其他失败集仍在处理，不声称整套通过。
- **产品下载及通知偏好修复**：共享安全下载处理按 session 去重，并在产品账户导航前安装；默认 session 使用同一处理，23 项下载/文件保存测试通过。桌面通知偏好删除未定义的退役 `cloudOffered()` 调用及无用返回字段，保留已读状态与页面权限，18 项偏好测试通过。新改动尚未重新打入安装包，既有 DMG 不代表包含这些修复。
- **后续发现待核实**：连接授权校验将库存 `complete:false` 信息丢失，可能误判服务未连接；工具库存分页达到上限仍有 cursor 时可能返回并缓存部分数据。已定位源码，尚未修复或验证，不把它们称为已解决问题。preload 缺 local-origin 参数时存在防御层放行分支，正常产品窗口确实传该参数，未证明生产可利用。
- **统一复测结果**：修复后 `pnpm test:electron` 退出码 0，942 项中 936 通过、0 失败、6 项既有跳过；`pnpm typecheck` 退出码 0。Store、Composio、浏览器宿主、CI 范围及 provider 行为 5 文件共 426 项全部通过。服务入口/Codex 定向复测尚在运行，完整 Vitest 所有分片未执行完成，不能声明全量通过。索引刷新 ready（45,521 节点、237,174 关系，4 处局部解析限制）。
- **服务入口与Codex复测**：清理确定退役的 Cloud/手机测试，迁移旧卡片协议及连接 fixture，保留电脑端业务和权限断言；两个文件共 578 项全部通过（退出码 0）。当前已完成针对最初失败文件的定向修复验证，但新增连接库存完整性修复和全量分片尚待完成。
- **连接库存完整性修复**：授权编辑保留库存完整标记，只有完整库存才判定未连接，本地工具归属及调用时权限 enforcement 不变；工具列表超过分页上限时显式报错且不缓存部分结果。Composio 全部 41 项测试通过。代码索引再次刷新 ready（45,521 节点、237,179 关系）。
- **lint未通过**：`pnpm lint` 退出码 1，日志 `/tmp/hezuo-final-lint.log` 共有 32 条告警，包含未使用导入/参数、不必要展开及验证脚本的 finally 控制流；已按最新清理授权继续最小修复，不加忽略规则，不标集成检查完成。
- **lint清理已落地、待统一结果**：删除未使用绑定和死函数，集合循环使用 `Array.from` 保留快照，网关控制字符拒绝范围保持不变；原生验证脚本 finally 改为记录清理错误及失败退出码，不覆盖原错误或删除活动目录。删除 Linux 打包验证脚本重复参数尾片段，恢复语法。统一 lint/类型/网关/Electron 与受影响服务行为复测已启动，最终结果尚未返回，不预先标通过；索引 ready（45,519 节点、237,164 关系）。
- **lint清理统一验证通过**：`pnpm lint`、`pnpm typecheck`、网关全套测试、Electron 全套测试及 `git diff --check` 均退出码 0；网关 15 文件 323 项通过，Electron 942 项中 936 通过、0 失败、6 项既有跳过。受影响服务/库存/打包脚本复测仍在运行；完整 Vitest 所有分片、新包重建和193部署未完成，不能据此归档。
- **受影响行为复测通过**：服务入口、连接工具库存和产品打包脚本三个测试文件共 372 项全部通过（退出码 0，日志 `/tmp/hezuo-post-lint-behavior.log`）。本轮 lint 清理相关验证闭包完成；全量 Vitest 分片、打包实机和线上部署继续列为未完成。
- **最新包已重建复测**：arm64 DMG/ZIP 包含本轮全部源码修复，构建退出码 0；DMG SHA-256 `677868758c75ba409e221d3dc1a1ae786842868e1108e5cd5aa8b55281537798`。两个已删手机模块不存在，包内文本上游域名 URL 扫描为空。新包隔离账号验收 30 步、28 张截图、0 错误，收据 `/private/var/folders/s0/5h112y2d3495p65t6p7cph400000gn/T/hezuo-product-verify-HCFmAn/evidence/receipt.json`，`passed=true`、`realModelAcceptance=false`；仍未签名/公证，不替代真实模型及浏览器人工验收。
- **193本轮部署完成**：停服完整备份代码、数据和服务配置到 root 私有 0700 目录 `/opt/hezuo-gateway/backups/pre-mobile-retire-20261115-161645/`；迁移文件无差异，仅部署 4 个网关源码并删除旧 `push.ts`，不删表、不覆盖账号数据。停服替换前后全库逻辑摘要一致；重启后逐表对照备份仅 `_cf_METADATA` 变化，所有业务表摘要不变。余额账号 8，账本 review 9 / settled 320。可信 TLS `/healthz` 返回 `ok:true` 与当前服务标识，`/admin` 200，service active。旧手机推送源码线上已不存在；真实用户重新登录未执行，不冒充生产用户端到端验收。
- **兼容审计补充**：磁盘确认服务入口仍回退读取 `OGB_PORT`，以及前端启动导入 `hezuo-preferences-migration.ts` 迁移旧偏好键，不能再以旧名22文件扫描认为无兼容。正在移除端口回退并改明确拒绝旧配置；偏好键涉及已保存设置，尚待依赖闭包处理。完整 Vitest 八分片任务已启动，但运行期间出现后续源码修改，因此其结果需标注快照边界，受改动文件必须补充复测，不能直接称为最终固定版本全量通过。
- **完整Vitest首分片未通过**：`--shard=1/8` 退出码 1，247 文件中 228 通过、11 失败、8 既有跳过；2750 项中 2675 通过、14 失败、61 既有跳过，耗时约491秒。按首失败停止策略，其余7分片未执行。失败包含目录搬迁后的fixture、退役云预期及内部能力门禁静态断言；继续逐项核实修复，不新增跳过，不声称全量通过。旧端口回退移除后的拒绝规则与数据目录2文件8项测试已通过。
- **首分片失败集定向修复**：内部能力门禁/Chief工具/自动化Undo 50项、目录路径/懒加载/companion入口38项、电脑用量9项、团队库/缓存资源归属46项、保留headless模块4项均通过；删除已明确退役的Cloud专属e2e及独立CLI发布入口专属测试，未新增skip。修复Bot设置按需加载、团队库新名称候选和缓存归属校验；备份验证改按当前魔数实际字节长度截取，`pnpm test:packaged-server`退出码0。仍待完整首分片重跑及其余7分片，不称全量通过。后续端口/偏好/懒加载/归属修复晚于最近DMG，最终包尚须再重建。
- **首分片修复后冻结验证**：手机专属CLI配对展示及平台参数已删除，通用浏览器/电脑链接及二维码保留，CLI 30项测试通过。`pnpm typecheck`、`pnpm lint`、`git diff --check`均退出码0；当前代码索引ready（45,515节点、237,152关系）。所有编辑任务交付后重新启动完整八分片顺序验证（日志 `/tmp/hezuo-full-frozen-shard-<n>.log`），首失败停止，最终结果未返回。最终安装包须在此轮验证完成后再重建。
- **冻结轮首分片结果**：`/tmp/hezuo-full-frozen-shard-1.log` 退出码1，247文件中229通过、12失败、6既有跳过；3296项中3208通过、33失败、55既有跳过，约528秒。其余7分片未执行；当前重新核对新失败集及分片分配变化，保留原定向通过证据但不宣称全量通过。例程失败已确认包含搬迁后旧 `server/testing` 子进程路径，不据此删除有效错误收敛行为。
- **第二轮失败集定向进展**：Grok认证HTTP及例程错误收敛2文件5项通过，五个UI文件106项通过，locale/分片完整性/滚动框3文件26项通过；仅删除确认退役的独立CLI手机引导测试及无桌面消费者的原生宿主页源码、产物、测试和生成器，桌面 `app/app-frame-host.ts` 与共享 `app-frame/bridge.ts` 保留。删除11语言中两项无消费者Data文案，保留严格未使用检测；聊天结果测试同步移除旧按钮文案断言，结果卡有效覆盖保留。分片权重仅删不存在文件条目（darwin3、win323、linux19），现存权重不变，不以调整权重移走失败。当前索引ready（45,427节点、236,899关系）；最终类型与结果卡复测尚在运行，完整八分片仍未通过。
- **完整八分片已执行、未通过**：全部8片均退出码1，总计2004文件中1880通过、74失败、50既有跳过；26213测试项中25781通过、141失败、288跳过、3待实现，耗时约4226秒。日志 `/tmp/hezuo-full-audit-shard-1.log` 至 `-8.log`，压缩失败清单 `/tmp/hezuo-full-audit-summary.json`。已按服务端E2E、服务端单元、界面及基础设施分区核对并修复；不得将本记录理解成已全量通过。前一轮结果卡、类型、lint及格式补测已全部退出码0。
- **全量审计后第一批复测**：通用远程会话19项通过；浏览器流授权、消息保护、部署fixture及UI基础8文件209项通过。剩余设置/密钥/单元批次217项通过但两认证suite因fixture ROOT错误未启动；修正后认证及退役前缀3文件10项通过、3项既有todo。Bot测试API改由Node运行器收集，7项通过。所有记录为分批结果，不代表74失败文件已全部修复。
- **明确仍未通过**：真实原生接管独立复测仍不能取得Electron原生窗口焦点；测试进程应用激活/regular策略探测亦无效，页面document.hasFocus不能替代窗口获焦，不盲改生产行为或删除断言。文件体积门禁仍有13项真实增长/未登记大文件，未提额；文档断链及locale陈旧翻译继续按消费者证据修复。17个E2E定向复测尚在运行。
- **分批复测补充**：17个E2E中16文件通过、1失败，129项通过、2失败，仅剩setup连接卡夹具待对齐当前直接连接配置；真实本地浏览器与租约/接管/权限覆盖未删。事件文档/服务文案/日常用语3文件通过，翻译生成校验仍有其他语言在用键的陈旧源hash，继续逐语言准确翻译核对；不得将德语缺键情况推广到所有语言。13项文件体积门禁、真实原生焦点及完整全套最终复跑仍未通过。
- **首次零连接setup真实修复**：保留未连接服务不能预授业务权限的校验，删除测试非法预授权；连接管理已挂载且开关开启时，空grants不再误判关闭，允许真实请求连接卡，off及未挂载分支仍拒绝。setup模式/真实连接卡E2E/connector代理/Composio共4文件86项通过。额外对话权限/Quick ask/直接连接3文件10项通过；账号fixture根目录修正及Promise/葡语路径类型问题修复后，相关测试与`pnpm typecheck`退出码0。当前索引ready（45,443节点、237,010关系）。本轮源码仍未重打最终包，未进行全套最终复跑；文档、跨语言翻译、文件体积和原生焦点等已列阻塞仍未清零。
- **体积门禁等价拆分验证**：不提高原预算，按内聚边界抽取网关provider/AI校验/账本游标、账号纯helper、驱动解析成本、Store解析、浏览器输入及UI展示模块；原文件体积门禁与UI4文件40项通过，网关类型与15文件323项通过，Store166项、账号隔离/IPC17项、驱动374项通过（1既有skip）。提取后网关遗漏的租约常量已修复并全量复测通过；UI浅树遍历已适配且所有原门控断言保留。验收脚本helper提取后隔离流程仍待运行结果，不能将整个拆分任务提前标完成。此批源码尚未重打包/部署193。
- **剩余例程复测**：部门生命周期通过；wait续办仍403 guest，主动例程fixture在hook中调用expect.poll不被当前Vitest支持，继续修正测试前提与有界等待，保留生产guest拒绝和禁止自续订断言。
- **体积拆分闭包完成**：验收脚本提取后实际隔离流程通过30步、0错误，收据 `/private/var/folders/s0/5h112y2d3495p65t6p7cph400000gn/T/hezuo-product-verify-yStP59/evidence/receipt.json`；配合原预算检查及账号/Store/浏览器流/驱动/UI/网关回归，13项体积门禁拆分任务标完成，未提额。当前索引ready（45,471节点、237,174关系）。该次验收使用此前构建包，仅验证提取后的脚本不退化；新的模块拆分、setup修复等源码仍待最终包重建和193后续部署，不声称线上包含这些改动。
- **翻译修复范围**：仅准确修订9语言中25条在用译文并同步对应hash；最后3键经精确及动态消费者核对确认退役后删locale/hash，未补缺失翻译或盲更新其他hash。最终翻译/文档/预算及类型lint门禁复测尚在运行，不能提前标清零。
- **剩余例程最终通过**：team生命周期/waits/proactive三文件13项全部通过，`pnpm typecheck`退出码0；wait通过真实单次配对取得admin/client会话而非桌面头冒充person身份，内部调用仍使用turn capability，禁止自续订403保留；主动例程真实有界HTTP健康检查与read-and-draft拒绝发送/跨应用/非原发件人围栏通过。账号helper69项、浏览器流20项另已通过。当前仅翻译审核及19条精确文档引用闭包尚在处理中，随后仍须全套最终复跑，原生焦点仍未验收。
- **冻结轮门禁通过**：在用翻译逐语言语义审核及实际修订后，翻译/服务文案/日常用语/控制引用4文件33项通过（3既有todo）；19条精确退役文档引用清理后，verification-docs/预算/analytics检测通过，`pnpm typecheck`、`pnpm lint`、`git diff --check`全部退出码0。索引ready（45,471节点、237,174关系）。全部编辑任务结束后重新启动完整八分片（`/tmp/hezuo-final-complete-shard-<n>.log`，不排除已知原生焦点测试）及当前源码arm64验证包构建；两者结果未返回，不声明全量或发行通过。
- **拆分后新包构建成功**：arm64 DMG/ZIP构建退出码0；新包包含Store解析、驱动成本/模型和浏览器输入等新增模块，两个已删手机模块不存在，包内文本旧上游URL扫描为空。DMG为`release/product/HezuoBot-0.1.141-arm64.dmg`，278,090,808字节，SHA-256 `ad54743f84a70909e7121a987a7c7cf8ee913e50f395bdd1671ef29aef8c3438`。该新包隔离账号复测已启动，结果未返回；完整八分片仍在运行，未签名/公证，不作为发行通过。
- **拆分后新包隔离复测通过**：当前包30步、28张截图、0错误，收据 `/private/var/folders/s0/5h112y2d3495p65t6p7cph400000gn/T/hezuo-product-verify-GkDMfM/evidence/receipt.json`，passed=true、realModelAcceptance=false。覆盖账号切换、聊天、工具批准/拒绝、余额不足、无右侧面板及简化新建Bot；不代替真实模型、系统钥匙串或原生窗口焦点验收。完整八分片结果尚未返回，网关后续模块拆分源码尚未部署193。
- **最终八分片全部返回、仍未通过**：8片中1/2/4/5退出码0，3/6/7/8退出码1；总计2000文件中1946通过、4失败、50既有跳过，26214项中25993通过、5失败、213跳过、3todo，耗时约4142秒。失败仅为真实原生焦点1项、已删E2E权重登记2项、locale-tests漏登记1项和companion gzip旧路径1项。精简清单 `/tmp/hezuo-final-complete-summary.json`。清单路径三类正在最小修正，严格断言及真实焦点测试保留；不能称为全量已通过。
- **最终清单闭包修复**：只移除已删除app-events/place-view的6条平台权重，现存权重不变；locale-tests补入两份实际读取翻译的setup-request测试，严格检查2文件183项通过。gzip经调用闭包核实仅companion实现仍活跃，服务端重复源码已删除，因此移除只针对两份副本字节相等的陈旧断言及注释，不恢复假副本、不改实现，保留压缩/隐私响应头/LAN等行为测试。三类合并回归及类型lint尚待结果；真实原生焦点失败保留，不能把定向修复当最终八片全绿。
- **最终闭包复测通过**：权重/CI语言覆盖/gzip真实行为3文件187项全部通过，`pnpm typecheck`、`pnpm lint`及`git diff --check`均退出码0。完整八片曾剩余5失败中的静态清单与退役副本断言已按当前契约修复并定向验证；真实原生窗口焦点仍失败，完整八片未对这些最后测试配置变更重跑，因此不把25993通过数加定向数冒充最终全套统计。
- **本轮冻结快照与焦点环境**：重新启动八分片 `/tmp/hezuo-closed-inventory-shard-<n>.log`，4690源码文件摘要清单 `/tmp/hezuo-closed-inventory-source-snapshot.json`，清单SHA-256 `a46a8a98002fe5178b32641ea16b2b4725b9e5f43cab27d3269c2de417f3daf6`；只读核对运行期间源码无变化。当前GUI会话检查发现锁屏，属于焦点失败的环境线索，不能倒推此前日志均由锁屏造成；不尝试解锁或绕过，原生焦点仍未通过。
- **旧格式兼容仍实际执行**：磁盘核实 package-format 中旧package迁移及两个解析入口、grok-import 中旧导出格式识别/转换、team-backup schema旧备份格式预处理均仍存在且有当前调用者，不归类为法律声明或死代码。此类旧文件导入转换尚未删除，旧名/迁移清理任务继续未完成；当前冻结测试期间不修改，后续需保留当前格式可用及旧格式明确拒绝测试，不删除用户数据或改写已有备份。
- **旧文件身份清理方案已核实、尚未实施**：只修改 shared package-format、grok-import、team-backup 三个解析模块，撤销三种旧文件身份识别和自动转换，现有package/Grok/服务端团队备份测试改为明确拒绝旧身份并验证输入不变；当前hezuo格式生成端不改。保留当前package版本升级、Markdown及无format/bundle独立导入能力，以及团队备份内必要历史字段兼容；不改workspace备份魔数、加密、密码、回滚或数据布局。当前全量冻结快照已再次核对无源码变化，因此等待该轮结果后实施，不把方案当完成。
- **冻结八分片最终仅余原生焦点失败**：`/tmp/hezuo-closed-inventory-shard-1.log`至`-8.log`全部执行完成，7片退出码0，仅第3分片退出码1；2000文件中1949通过、1失败、50既有跳过，26213测试项中25996通过、1失败、213跳过、3todo，约4149秒。唯一失败为真实原生接管窗口焦点，未排除/skip。运行结束时4690源码快照变化数0。这是该固定版本的完整结果，不是全绿；随后开始三种旧文件身份清理，该批新变更须另行定向与入口回归。
- **三种旧文件身份转换已删除、验证中**：shared package-format、grok-import、team-backup 运行代码不再含三种旧身份识别/转换，package专属41项通过；旧身份拒绝及输入/本地数据不变测试已补齐，当前版本、Markdown/bundle及必要历史字段兼容保留。共享解析、桌面导入、团队备份真实往返、加密workspace备份安全六文件及类型lint格式统一验证已启动，结果未返回，尚不将整个旧名/迁移任务标完成。索引已刷新（45,470节点、237,167关系）。
- **三种旧文件身份清理验证通过**：共享package/Grok解析、桌面导入、团队备份往返与加密workspace安全六文件138项通过、1项既有跳过；`pnpm typecheck`、`pnpm lint`、`git diff --check`均退出码0（日志 `/tmp/hezuo-legacy-identities-entry-regression.log` 及同前缀types/lint/diff）。索引ready（45,470节点、237,167关系）。该子阶段已验证，不代表全仓旧名零匹配或当前持久化标识已全部清理；后续解析器修改仍未打入当前安装包，完整八片25996通过/1焦点失败记录对应修改前冻结版本。
- **193后续模块拆分部署完成**：部署前网关类型及全套测试均退出码0，仅替换ai-gateway/ai-wallet/endpoints并增加对应3个helper共6文件，测试夹具未部署、迁移目录无差异。完整代码/数据/service备份位于 `/opt/hezuo-gateway/backups/pre-module-split-20261115-220011/`（root0700）；停服期间所有表摘要一致，重启后逐表仅 `_cf_METADATA` 变化，业务表全部一致。余额账号8、review9/settled320，integrity_check=ok；部署文件哈希一致，service active，可信TLS healthz ok及admin200。不代表真实用户重新登录或模型调用已验收。
- **持久化旧标识审计边界**：多处omb点前缀仍是当前唯一存储主键（欢迎草稿、提示关闭、启动弹窗和会话状态等），不是新键缺失时的备用读取；直接替换会使现存状态不可见。另有草稿thread标识迁移、旧完成状态读取及团队备份历史runOn字段转换，涉及实际现存数据，不能为零匹配盲删。整个旧名/迁移清理任务仍保留未完成，法律声明及安全拒绝规则保留。
- **原生接管当前会话复测通过**：未改焦点断言或生产激活逻辑，独立执行 `embedded-browser-network.electron.test.mjs` 真实运行1项通过、无跳过（`/tmp/hezuo-native-focus-current-session.log`），含窗口与WebContents聚焦、双Bot复用/隔离、关闭交还及页面/session状态断言。此前锁屏线索不倒推全部历史失败原因；此证据不替代真实模型或百度扫码，后者继续取消。
- **旧身份拒绝版新包复测通过**：arm64构建退出码0，DMG278,091,168字节，SHA-256 `215d5080bc93628ffa616b964062ff245e23d31858856d938a32d00daa4a0304`；当前包隔离账号30步0错误，收据 `/private/var/folders/s0/5h112y2d3495p65t6p7cph400000gn/T/hezuo-product-verify-3O1ajF/evidence/receipt.json`，passed=true、realModelAcceptance=false，仍未签名/公证。
- **当前版本完整复跑已启动**：八分片日志 `/tmp/hezuo-current-identity-shard-<n>.log`，4690源码摘要 `/tmp/hezuo-current-identity-source-snapshot.json`，SHA-256 `17157a186a0f8af25ec778de489fd657fad929e32fcf07af1192343ff8bf6d37`。只读通知审计未落盘，源码保持冻结；结果未返回，不将先前全量统计套用到该版本。
- **当前版本完整八分片通过**：八片退出码全部0、overall_exit=0，耗时约4185秒；2000文件中1950通过、50既有跳过，26221测试项中26005通过、213跳过、3todo、0失败。包含真实原生接管焦点测试，未排除已知失败；4690文件源码摘要逐项核对变化数0。日志 `/tmp/hezuo-current-identity-shard-1.log`至`-8.log`。跳过与todo不计通过，不能满足原清单“没有跳过测试”的绝对表述；全量Vitest任务按实际完整执行且无失败标完成，不代表真实模型/签名公证或整批验收完成。
- **退役通知死导出清理通过**：移除仅测试引用的前端历史活动导出及退役展示测试，当前SIMPLE_MODE提示、旧session claim不阻塞提示、历史seen存储兼容均保留；前端通知/欢迎2文件19项通过，桌面偏好18项通过，类型/lint/diff检查退出码0。当前包不包含此后死导出清理，不混同先前包证据。
- **C实机证据继续补齐**：现有账号收据的创建用自定义名字/提示词，不能勾默认创建；控件存在也不等于实际改色或上传成功。正在扩展同一隔离Electron验收流程补默认创建、颜色/形象及真实图片上传操作与API/侧栏/聊天观察，真实模型提示词遵循保持未验收。原生窗口复用/隔离需独立引用真实Electron成功日志，不将账号收据当其证据。
- **用户最新范围决定：颜色不管**：默认草稿预览绿色、创建后保存 cyan 的差异不修复，不再作为其余验收的阻塞；该颜色一致性检查不记为通过。后续继续其余创建与图片上传验收；不执行已取消的百度登录与扫码。
- **排除颜色后的补验结果**：`/tmp/hezuo-avatar-excluded-color.log` 实机验收退出码 1，停在图片上传后的 `draft preview exists` 检查，正在只读区分预览选择器问题与产品问题，未将上传记为通过。证据目录为临时验收根 `hezuo-product-verify-XurNmv/evidence`。文件预算、lint、diff 检查均退出码 0（`/tmp/hezuo-avatar-scope-{budget,lint,diff}.log`）；这些静态检查不替代实机结果。
- **该次部分证据核对**：`XurNmv/evidence/receipt.json` 中默认零修改创建的 `nonColorChecks.passed=true`，截图为 `12c-avatar-default-created.png`；颜色检查明确 `excludedByUser`。上传尚为 `passed=false`：源码确认对话框图片 alt 为 `<名字> avatar preview`，验收脚本原匹配遗漏此精确名称，正仅修复对话框选择器，保留加载与上传字节校验；尚不据此声称上传通过。
- **上传补验最新边界**：修复精确 alt 匹配及上传等待前提前调用草稿强断言后，`/tmp/hezuo-avatar-wait-fixed.log` 仍退出 1：PNG 预览等待超时。`Soq9jQ/evidence/receipt.json` 已保留真实 DOM 与失败截图，预览区域实际是 `svg[aria-label="Cosmo avatar preview"]`、无 `img` 或 SVG `image`，不能仅凭源码推断图片已加载。文件预算、lint、diff 均退出 0。上传仍未通过，继续只读确认回退头像原因，不修改产品、不吞错。
- **授权收尾：上传预览修复**：根因是草稿 `blob:` URL 被持久化头像白名单过滤，非 PNG 解码或 CSP 已确证故障。仅为草稿 AvatarFraming 增加显式临时 blob 预览入口，未改共享附件白名单；非草稿仍拒绝 blob/外部地址。Avatar、编辑预览、资料卡与草稿 4 文件 42 项定向测试通过（`/tmp/hezuo-draft-avatar-fix-tests.log`）。尚需重建验证包后实测上传，不将单测当实机通过。
- **运行标识与现行文档补清理**：组织库类型字面量统一为 `hezuo.org-library`，命令面板内部事件及直接测试监听统一为 `hezuo:open-command-palette`；聊天链接、团队分享、组织设置和线程验证四份文档的深链示例按当前运行实现统一为 `hezuobot://`。尚在执行定向回归，不将编辑落地等同通过。旧存储键、旧会话认证、仓库真实地址及必要许可归属仍单列，未批量删除或伪造迁移完成。
- **上述补清理定向检查通过**：Sidebar simple-layout 20 项、组织库 26 项全部通过，`pnpm typecheck`、`pnpm lint`、`git diff --check` 均退出码 0；日志 `/tmp/hezuo-identity-{sidebar,org,types,lint,diff}.log`。这些结果验证源码回归，不代表重新打包或全量 A/B/C 实机验收已完成。
- **授权收尾：文档/元数据/许可核查完成**：现行深链示例与 Cua 操作路径已统一；13 份文档 22 行证据引用依据 git 恢复原始路径并标明 `historical original path`，不伪造改名后的历史证据。`package.json` 省略仍指旧品牌真实仓库的可选 repository 字段，不改远端、不编造地址，JSON 解析有效。精确保留范围：NOTICE 原始归属；third_party/browser 来源及补丁修改声明；Cua 通知/许可/SBOM 原始来源；Playwright/provider-icons 来源声明；历史原始证据路径/截图；旧环境变量的明确拒绝诊断及对应负向测试；安全保留名与声明完整性测试。它们不是运行兼容或上游服务连接，不要求为零命中删除。文档测试旧名分类核查待办已完成，但运行清理和 ABC 实机尚未全部完成。
- **授权收尾：原生窗口独立复测通过**：`pnpm exec electron desktop/electron/fixtures/embedded-browser-network-smoke.mjs /tmp/hezuo-final-native-browser-receipt.json` 退出 0，收据 `complete=true`。实际断言包括 Alpha/Beta 窗口各自标题及 session 隔离、重复打开复用 surface 且窗口总数仍为 2、关闭后原 webContents/session/输入内容/cookie 保留，以及两个 Bot cookie 不串。日志 `/tmp/hezuo-final-native-browser.log`；这是原生 Electron fixture 证据，不冒称真实模型登录任务已执行。
- **授权收尾：旧运行兼容清理已落地**：本地欢迎/引导/通知/session/云意图键、命令事件、sandbox `/run/hezuo`、usage trace `timedBy="hezuo"` 已统一，不读旧键、不加迁移；旧 session 前缀认证明确拒绝，新前缀正常。egress 拒绝原因改为 `hezuo`，三个 ownPort 安全拦截分支保留。受管隧道只识别 `hezuo-c-*`，72 项网关测试通过，旧前缀不扫描不回收；未操作远端存量，旧资源将不由新扫描器管理。
- **授权收尾门禁与打包**：运行身份主回归 145 项、内部路径/trace/活动/恶意页回归 68 项、欢迎键 4 项通过；最终类型/lint/diff 均退出 0。arm64 未签名验证目录包重建退出 0（`/tmp/hezuo-final-authorized-package.log`），正在新包执行默认创建及真实 PNG 上传；不将打包成功当实机通过。最后两份直接消费测试预期同步后另行复验。
- **真实模型验收前置仍缺失**：专用凭据文件存在性检查为否；已向用户索取授权文件路径，表单允许测试额度但路径留空，未提供账号，故未读取日常凭据或执行真实模型任务。提示词真实回复、自然语言百度标题及取消后 Bot 实际回复尚不能宣称通过；百度登录扫码按用户取消不执行。
- **新包默认创建及真实上传验收通过**：`/tmp/hezuo-final-avatar-product.log` 退出 0，证据根 `hezuo-product-verify-QxMs7W/evidence`；默认创建非颜色检查通过，PNG 上传后侧栏/聊天加载、持久 URL 和精确文件字节均通过。颜色明确 `excludedByUser`。最后 recorder 与 sandbox egress 直接消费回归 2 文件 15 项通过（`/tmp/hezuo-final-identity-synced-tests.log`）。运行清理与文档许可待办均已完成；真实模型凭据缺失导致 ABC 整体验收待办仍保留，不归档。
- **再次授权后的完整凭据核查**：`docs/bot-model-browser-acceptance.md` 明确记录专用账号 `beta-a@hezuo.test`，但指定凭据文件、验收中继脚本及 `HEZUO_ACCEPTANCE_PASSWORD` 环境均不存在。已查忽略目录的候选文件名，未找到另一份专用凭据；旧 relay 描述仅存在且权限 0600，不输出其秘密，文档已记录旧中继连接拒绝，不能据文件存在冒称可登录。未导出认证数据库字段、借用日常 session 或绕过账号网关。继续完整测试及非模型 UI 补验；关键创建/接管组件 19 个字面量文案键中英均非空、无 TODO/FIXME/placeholder，7 个关键定向测试文件无 skip/todo 标记。
- **最后 ABC 补证继续**：新增 App 面板挂载源码回归；App/SignInRequestCard/browser-takeover/SimpleNewBotDialog 4 文件 40 项通过，新增测试无用转义 lint 已修复后重跑通过。新包 UI 补验 `/tmp/hezuo-final-abc-ui-observation.log` 退出 0，`hezuo-product-verify-BzwR34/evidence/receipt.json` 在账号恢复、真实 MCP 写入待批准/完成/拒绝 4 节点均无面板、无瞬态插入、聊天可见。明确为 partial-ui-observation-only，未覆盖登录请求、浏览器/电脑工具、新手引导四场景及取消卡闭环，不据此勾整项。文件预算/lint/diff 最终均退出 0；完整 Vitest 仍在执行。
- **持续授权后的门禁状态**：全量 `pnpm exec vitest run` 在 600 秒截止时超时，日志 `/tmp/hezuo-final-abc-full-vitest.log` 仅有 RUN，无通过/失败汇总，因此不声称全量通过。已改用仓库现有分片机制有界定位；新增真实登录卡取消 fixture 正按生产工具协议补齐，不直接改 React 状态、不绕过能力授权、不将合成模型回复当真实模型。原 ABC 四种触发与模型回复缺口仍保留，未因用户授权虚勾。
- **真实产品登录卡取消 UI 补验通过**：新包隔离验收 `/tmp/hezuo-final-signin-cancel-ui.log` 退出 0，证据 `hezuo-product-verify-RZZ5rb/evidence/receipt.json`。合成上游调用产品实际提供的 request_sign_in 工具，正常生成 browser 登录卡；真实点击 Cancel 后同卡 `cancelled=true,resumed=true`，新 page target 数为 0，pending/cancelled 两个节点均无面板。文件预算/lint/diff 均退出 0。此证据证明真实工具路由与取消 UI，不证明真实模型取消续答，不执行百度登录扫码；原复合验收项仍不整体勾选。
- **补充回归与全量发现边界**：保留电脑能力的 ComputerPanel 10 文件 95 项通过（`/tmp/hezuo-final-retained-panel-tests.log`）。全库与 1/8 分片均在有界时限内未给出汇总，单文件分片正常；只读诊断确认分片在文件发现后执行，尚不能确证根因，不把 release 缺排除猜测当结论。未为绕过超时删除测试或放宽门禁，未声称全量通过。
- **浏览器触发补验未通过**：`/tmp/hezuo-final-browser-ui-trigger.log` 退出 1，证据 `hezuo-product-verify-0GIx4u/evidence/receipt.json`。浏览器子项 `blocked-or-unverified`、无实际工具结果，不能勾浏览器触发；电脑未执行（未证明显示环境隔离，避免截取或操作日常桌面）；managed 产品新手引导由 ProductSetupGate 返回 null，单列不适用，不伪造触发。后续切换账号脚本找不到 Email me a sign-in code，整轮失败；lint/diff 退出 0 不替代失败。此前 RZZ5rb 取消 UI 成功证据独立保留，真实模型及原复合验收仍未完成。
- **浏览器补验时序与审批定位**：修正“请求尚未开始就采样”的等待后，`/tmp/hezuo-final-browser-start-wait.log` 在正常工具审批处超时退出 1，证据 `2N3Edh/evidence/receipt.json` 显示实际提供 `browser_agent_browser_open` / `get_title`。正在补正常 UI 的 Allow once，仅允许本地 example.test 临时端口 open/title；不批准其他操作、不绕过门禁。未把 timeout 或工具 offer 当浏览成功；lint/diff 为 0。
- **浏览器补验最终阻塞**：现有审批 API 无法将审批 `requestId` 与实际工具调用 ID/参数可信关联；审批 ID 独立生成，含 `itemId/input` 的工具消息在批准后才发布。故未以摘要或生产端自报参数自动批准，不扩张生产协议、不绕过权限。该场景仍未完成；取消 UI 的既有成功证据有效。后续须补安全可关联的审批验证路径或由明确监督的本地 UI 审批，不能凭授权或工具 offer 宣称完成。当前剩余还包括真实模型专用凭据缺失、隔离电脑显示未建立及全量测试超时，最后 Todo 保留未完成。
- **授权后修复审批证据关联**：新增可选真实 `toolCallId`，内置 browser open 仅披露 HTTP(S) 安全 origin（保留端口，拒绝 userinfo，去除 path/query/hash），经审批事件到持久卡透传；审批 requestId、授权策略、grant 与安全底线不变。3 文件 124 项定向测试、typecheck/lint/diff 均退出 0（`/tmp/hezuo-approval-evidence-{tests,types,lint}.log`）。新包构建及 fixture 消费端正在执行，尚不代表浏览验收通过。
- **全量显式清单验证**：按配置源码根生成 2003 测试文件清单，67 批、无重复遗漏，不改 include、不新增排除。前三批通过；第四批在 180 秒截止但仍有慢端到端进展，已保留日志并以 900 秒批次时限续跑，尚未完整覆盖，不据 runner 退出码 0 宣称全量通过。清单及逐批结果 `/tmp/hezuo-vitest-im68og67/`。
- **显式测试批次当前进度**：首轮续跑达到 3600 秒作业上限，核对 results.json：已完成第 1–35 批，退出码均为 0、无 timeout；第 36–67 批未据此算通过。已从未完成批次恢复执行（`/tmp/hezuo-explicit-vitest-remaining.log`），保留前 35 批成功结果，不重复或减少选中测试。仍须核对最终 JSON 文件覆盖与新增测试，不能将 runner 状态或部分通过写成全绿。
- **显式测试最终结果已核验**：67/67 批完成，全部批次退出码 0、无 timeout；逐批 JSON 报告覆盖选中 2003 文件，missing=0。断言统计 26024 passed、0 failed、213 skipped、3 todo；跳过及 todo 不算通过，不宣称零跳过。报告与逐批日志 `/tmp/hezuo-vitest-im68og67/`，续跑日志 `/tmp/hezuo-explicit-vitest-remaining.log`。原清单之后新增的审批目标测试另行定向通过；最终类型/lint/diff 通过见后续记录。测试不再阻塞，真实模型凭据及隔离电脑显示仍未满足，最后 ABC 整体验收 Todo 不虚勾。
- **新包审批链实际验证与 socket 故障**：带安全关联的新 arm64 包构建退出 0。`/tmp/hezuo-safe-approved-browser-ui.log` 退出 1，`4kzbT9/evidence/receipt.json` 记录两个审批卡精确匹配真实 toolCallId，open 目标 origin 与本地站点一致并正常 UI Allow once；实际工具返回 `ok:false`，因隔离临时 HOME 导致 socket 路径 150 字节超过 103 上限，未读到标题。正仅为本 fixture 指定短隔离 socket 目录，并将 `ok:false` 纳入严格失败判断；不放宽权限、不将审批成功当浏览成功。lint/diff 为 0，最后 Todo 仍未完成。
- **短 socket 修复后真实导航仍失败**：fixture 改用受现有白名单支持的独占 `XDG_RUNTIME_DIR=/tmp/hb-*`（无效 socket override 已移除），清理仅自身目录；严格 `ok:false` 检查阻止失败后继续批准 title。`/tmp/hezuo-xdg-browser-ui.log` 退出 1，证据 `IHbjpV/evidence/receipt.json` 已无 socket 超长错误，实际 open 返回 `ERR_SOCKS_CONNECTION_FAILED`，并记录 Google 请求被 reserved 地址规则拦截，正在只读核对目标与代理路径。未关闭安全拦截、未将本地页面导航算通过；lint/diff 为 0。
- **本地网页补验平台限制已查明**：example.test 映射仅进入 Electron，独立浏览器 SOCKS 以 Node DNS 解析，不能使用该映射；拒绝提示中的 Google 是 session 累积记录，不能认定实际 open 目标被替换。改成 loopback 也非合法捷径：本地端口资格依赖 ListenerOwnership.botOwned，当前仅 Linux /proc 可证，macOS 返回 false，无现成公开 fixture 登记入口。未篡改 egress 或自造授权；本轮本地浏览子场景仍失败，停止重复同方案。真实模型专用凭据和隔离电脑环境缺口不变。
- **公开网页浏览工具及无面板实机通过**：改用正常公开 `https://example.com/`，不放宽 egress、不做登录扫码。`/tmp/hezuo-public-browser-ui.log` 退出 0，证据 `hezuo-product-verify-B6dAc1/evidence/receipt.json` 的 browser.status=`public-example-title-read-no-panel`、controlSucceeded=true；open/title 实际返回均 ok=true，标题 Example Domain，2 次审批以真实 toolCallId 与安全 origin 精确关联。临时 XDG socket 目录已清理。lint/diff 退出 0。整轮同时覆盖既有取消卡、默认创建及 PNG 上传；模型驱动仍 synthetic，不能替代自然语言百度任务/真实提示词遵循。电脑隔离显示与真实模型凭据仍缺，完整显式测试批次尚在执行。
- **最终当前门禁再核对**：清单生成后新增的 browser-approval-target 测试另补执行；与 App 面板挂载回归、文件预算共 3 文件 12 项通过。当前 `pnpm typecheck`、`pnpm lint`、`git diff --check` 均退出 0（`/tmp/hezuo-final-{added-tests,current-types,current-lint}.log`）。复核原 ABC 复合项，取消 UI/公开浏览工具只算相应子证据，不整体勾真实模型回复；最后 Todo 仍未完成。
- **当前包旧名残留复核**：资源文本扫描仅命中 `licenses/HezuoBot-NOTICE.txt` 与 `browser-engine/licenses/README.md` 两处许可/来源说明，未以删归属声明满足零匹配。当前原仓库旧名表达式仍命中22文件、旧上游域名URL为空；法律、安全拒绝与当前持久化键边界继续单列。专用真实模型验收凭据文件仍不存在，不取用日常账号、不用合成上游证明百度任务或提示词遵循。
- **最新纠正**：D1/D2 未完成，此前“全部完成”声明撤回。编译通过不等于改名完成或整批验收完成。以原清单逐项核验，不再以临时兼容解释为完成；下述先前阶段范围和测试输出仅为历史证据。手机端暂缓、远端改名、安全联系、部署与实机验证均为未完成项，不能据此归档。
- **本轮真实进度补充**：用户已解除手机端暂缓。Android `:app:compileDebugKotlin` 通过；iOS 模拟器 HezuoBot.app 构建通过，Swift 核心 537 项测试通过。配对采用统一新协议，手机凭据采用 v2 并通过 CryptoKit 互操作测试；仍未完成手机实机配对及商店签名。
- **193 已授权切换**：完整代码/数据/服务配置备份位于服务器私有目录 `/opt/hezuo-gateway/backups/pre-canonical-20261115/`。停服复制后完整 SQL 摘要一致，账号 8 个、余额汇总、9 条 review 与 320 条 settled 记录不变。已处理 SQLite 主文件及 WAL/SHM 属主问题；HTTPS 证书校验 `/healthz` 返回 200 与新服务标识，`/admin` 200，服务 active/running。用户登录与手机端到端尚待验收，不声称这些已通过。
- **实际打包与运行**：已生成 arm64/x64 DMG 和 ZIP（未公证验证包）。桌面身份请求头改名不一致已修复，跨端门禁 8 项及会话 4 项测试通过；重打 arm64 包后可登录进入工作区，但首句聊天仍在推理前被内部 MCP 拒绝，未通过聊天验收。另已修复 server 构建不清旧输出导致删除模块残留的问题，清理回归与实际干净构建通过；最终安装包仍须重建并重新扫描。A/B/C 实机清单不勾选。
- **后续真实安装包复测**：已修复通用会话认证提前拒绝合法内部回合令牌的问题；内部路由采用独立终止分发，不伪造所有者身份。服务编译通过，认证/集成 74 项、内部 MCP 路由 64 项通过，安全复核未发现可达权限回退。重打包后已实际发出 1 次网关推理请求，不再卡 MCP；但回复未完成并进入用量复核，聊天验收仍失败。当前证据在隔离目录 `hezuo-product-verify-KrUXql/evidence/receipt.json`，继续排查响应协议，不能标记通过。
- **响应故障定位与实测**：隔离夹具原样转发 Worker 请求头导致 Node `UND_ERR_INVALID_ARG`，不是生产计费或 SSE 完成帧问题。夹具改用生产 `directEgress` 后，真实安装包收到 Hello 回复，5 次推理返回 200，批准工具实际写文件、拒绝工具未写文件，账号切换与余额不足检查均走到完成。完整脚本随后因旧右面板断言失败；已替换成当前无面板及响应式导航断言，正在重跑，尚不声明整套通过。
- 最新干净 arm64 包扫描仅匹配必要 NOTICE 和浏览器来源说明；原上游网址验收命令无输出。全仓旧名字命令仍非零，不能混同两项扫描。
- **扫描与历史资料**：原扫描剩余 22 个文件，包含必要声明、安全拒绝规则、迁移历史、当前验收文档和待改远端元数据，未宣称原命令零输出。40 项非活动历史资料已完整迁至 `/Users/a1234/Desktop/HezuoBot-history-20261115/`，有清单；旧 scratch 仅保留被系统通知进程引用的验证浏览器资源。用户允许保留必要法律声明，不删除安全规则来伪造清零。
- **此前阶段执行口径（历史）**：曾限定代码修改与编译，不运行打包、安装、部署和实机验收，手机端及上一批遗留暂缓。这个阶段范围不代表原整批验收完成；当前按最新纠正逐项收尾，未执行项目保留未完成状态。
- **改名待完成**：旧配对协议、持久化标识、旧目录保护和远端名称不再作为 D2 完成的豁免。先处理依赖和有备份的持久化迁移，禁止直接改存储标识造成空库；手机端暂缓造成的跨端改名缺口仍记为未完成。
- **安全与许可约束**：保留依法必须提供的 LICENSE/NOTICE 与第三方声明，逐项核实与零匹配标准的冲突；不以删名义削弱通用认证、凭据保护及执行隔离。许可问题未解决时明确列为阻塞。
- **发布范围最新确认**：用户明确 GitHub 这块不用动，不改仓库名、远端地址及对应仓库元数据，不再把 GitHub 改名列为完成阻塞；扫描中的现有项目仓库地址单列说明，不声称已改名。安全政策已按最新要求删除，后续由用户补充；Windows 受审查浏览器资源仍未落实，不得编造。
- **测试范围变化**：退役 16 个仅依赖已禁用 Cloud Team 模式的集成套件，不声称旧私聊/角色云行为通过；保留并迁移本地配对、线程权限、通知、问题卡与工作区图片测试，使用真实隔离服务及假引擎，不使用跳过标记冒充覆盖。
- **此前编译证据，非完成声明**：前端、本机服务、网关 control-plane、桌面 companion 曾编译通过，代码索引曾刷新；当前残留说明 D1/D2 仍未完成，整批尚未验收，不归档。
- **收尾回归证据**：认证/会话/真实本地配对 111 项通过；服务器配置 210 项通过；网关配置与身份 6 项通过；控件/浏览器定向 135 项通过、1 项平台跳过；控制 CLI/秘密目录 34 项通过；验证命令 UI 97 项通过；暂存写入和秘密文件排除 19 项通过；执行隔离定向合计 29 项通过；本地通用行为 7 项在修复后分组通过。发布策略/浏览器资源/桌面链接 53 项通过。不是全仓测试通过声明。
- 自动化 UI journey 代码已从旧云部署夹具迁移为本地夹具，默认运行因未启用 `HEZUO_UI_E2E=1` 跳过 2 项，未声称实际浏览器验收。无实际打包、安装、部署或手机改动。193 仅只读核对服务 active、数据库 18 项迁移，不更改账号、余额、配置或持久化标识。
- 按上述新口径复核：`pnpm exec tsc -b desktop`、`pnpm exec tsc -p desktop/tsconfig.server.json` 均退出码 0；正在运行的打包任务已取消。
- A、B、C 按最新“代码修改 + 编译无错误”口径完成；原实机清单不作为本轮门槛，也不伪造实测通过。接下来推进非手机端 D1/D2/D3。
- D1 第一组删除进行中：移除上游 `@devs` 报告、HighLevel 原生集成、托管 Composio 代理及云购买促销入口；保留用户 Composio API Key、项目账号网关与本地诊断。依赖闭包清理完成后统一编译，本组尚未标成完成。旧凭据的日志脱敏及备份排除规则保留，避免删除功能后意外泄露历史密钥。
- D1 第一组前端编译已通过：`pnpm exec tsc -b desktop` 退出码 0。删除云购买目录时发现共享 `CloudTile` 被工作区设置复用，已提取为独立组件并修复引用；本机服务仍在修复旧代理参数的编译引用，尚不标 D1 完成。
- D1 第一组集成编译完成：前端 `tsc -b desktop` 与本机服务 `tsc -p desktop/tsconfig.server.json` 均退出码 0；修改过的 Electron 主入口及连接转移模块 `node --check` 通过。本轮按要求未运行测试、打包、部署或实机验收。
- D1 尚余 Electron 云账号/窗口切换/迁移同步子系统、本机服务云功能，以及 `apps/`、`connector/`、`enterprise/`、`evals/`、`deploy/` 等后续删除组；不能将当前第一组删除当作 D1 全部完成。
- D1 后续组代码清理：`apps/`、`connector/`、`enterprise/`、`evals/`、`deploy/`、根 Dockerfile/compose.yaml 已移除，对应工作区/CI 引用同步清理。Electron 已解除云账号/窗口/迁移/同步和上游 companion account 接入，项目网关账号、本地启动与网关手机中继保留；前端依赖闭包及本机服务编译仍待本组统一检查。
- 企业层许可证禁止将受限实现去许可检查后复用，因此未保留该实现；旧 hosted 管理环境配置明确拒绝启动，项目原有本地/网关权限校验保留，不提供绕过授权的兼容模式。
- 企业层/旧目录删除后的本机服务 `tsc -p desktop/tsconfig.server.json` 已通过；Electron 云/上游账号接入删除后的主入口和 preload 语法检查通过。前端正在清理已删除桥接 API 的测试与配对页面引用，尚未完成本组整体编译。
- 独立 npm/CLI 分发入口与旧打包工作流已删除，`.github/workflows/` 仅保留 `ci.yml`；验证工具实际依赖的服务控制函数保留为 `server-control.ts`，fleet 仍有运行时依赖，暂存真实操作于 `fleet-operations.ts` 待后续删除。该组本机服务编译退出码 0。
- 云账号/购买/同步/rail/home 及上游 companion account 的前端引用闭包已清理，项目网关账号与本地 QR/Tailscale 配对保留；前端 `tsc -b desktop` 重新通过。仅为代码编译验收，支持模块中仍被本机服务 hosted/tunnel/fleet 引用的旧云代码尚待后续删除。
- 独立服务器邮箱登录/自定义域名界面和 fleet 管理界面已移除，保留访问名单/角色与本地配对、项目账号登录；前端编译通过。对应本机服务邮箱/域名路由与独立 tunnel listener 删除在收尾，fleet 运行模块已删除，网关 companion 所需 cloudflared 仍保留。
- 独立服务器部署 transport 删除组编译完成：前端与本机服务 TypeScript 均退出码 0。纯访问名单逻辑迁到 `session-membership.ts`；已删除 `account-signin.ts`、`tunnel.ts`、自定义域名模块与 fleet 运行模块。HTTP 普通响应及 companion 压缩保留，独立 socket 专属压缩钩子随其功能删除。
- 已删除孤立上游账号运行模块 `companion-account-service.mjs`、`cloud-account.mjs` 及 cloud rail/buy/plan 运行入口；前端、本机服务编译均退出码 0，main/preload 语法通过。少量 cloud 声明仍被 consent/其他旧云模块引用，后续需连同残余云服务闭包清理；不将这些类型残留视作 D1 完成。
- 网关控制平面 HighLevel OAuth relay 与上游默认账号域名配置已删除，历史迁移编号不变；通用 Wrangler 配置要求运营方显式提供 HTTPS 账号 origin，未配置时 fail closed。网关 `tsc --noEmit -p tsconfig.json` 通过；未部署、未修改生产数据。
- 后续闭包清理进行中：移除无生产调用的 Electron Home/Own Home/Two Places/Chrome Rail 等模块与对应测试；自动更新按 D3 要求退出产品，保留版本/About/诊断。仍在拆分服务器 move/sync 与社区上游目录调用，完成后统一编译，不提前将 D1/D3 标为完成。
- 自动更新运行时/IPC/界面及服务器 release-check 已删除，保留版本/About/诊断；服务器 move-freeze、cloud-move 兼容响应及 cloud-sync 路由已移除，保留本地工作/备份维护和实际服务启动。上游默认社区团队目录已删除，用户显式 GitHub URL/本地文件导入保留。本组前端、本机服务编译通过，网关编译通过；D3 打包配置正在统一，未运行打包。
- D3 配置代码完成：唯一 `pnpm package` 入口；`electron-builder.yml` 为唯一产品身份配置，HezuoBot / com.hezuobot.app / hezuobot 协议，发布禁用，签名默认保留。保留 `--lan-origin --gateway-ca` 与 `--debug`；删除 updater 构建/补丁/feed 脚本。配置 YAML/JSON 解析、7 个相关 JS 语法检查及前端/本机服务编译通过。未运行打包或 dry-run；运行时数据目录等 D2 统一尚未完成。
- Cloud-send / Team move-in 与上游签名控制 transport 运行入口及独占模块已删除，邻近本地工具/通知/会话/团队权限与网关中继保留；本机服务编译退出码 0。Cloud-home 初始化/归属结算、own-home/连接交接依赖仍需下一组闭包清理，D1 未全部完成。
- Cloud-home 初始化、归属结算及独立启动模块已删除；本轮前端与本机服务编译退出码 0。旧测试夹具所需签名算术移入测试目录，不恢复生产签名接口；遗留签名团队集成测试未运行，不声称通过。代码图索引已刷新至 2026-11-15T02:31:23Z（58,371 节点、310,771 关系），全局 AGENTS.md 已记录每任务完成刷新规则。权限边界复核尚在收尾，D1 全量残留检查与 D2 尚未完成。
- 权限复核未发现保留部署模式中可达的新增授权回退；本次同时退役旧 Personal Cloud Home 与旧 Cloud Team 模式，旧云环境配置明确拒绝启动。不能描述为保留旧 Cloud Team 私聊/个人 MCP 行为；若未来重启团队云模式，需重新接入 audience/roster/个人连接权限。项目本地及网关认证保留。
- 按用户最新要求，手机端改名、编译、配对验收和 Swift/Kotlin LSP 暂缓；保留未完成状态，不能据此归档整批。
- D2 桌面身份子项：Electron 名称、托盘及启动提示统一 HezuoBot，主机标识与 desktopName 统一 com.hezuobot.app 系列；默认用户/会话目录统一 appData/HezuoBot，macOS 日志统一 Library/Logs/HezuoBot。删除 Product 旧资料选择与迁移模块，不移动旧资料，保留显式测试及数据目录覆盖。前端编译和 main 语法检查通过；105 项 Vitest 与 18 项 Node 测试通过（首次混用运行器导致 3 文件失败，改用 Vitest 后通过）。索引已刷新，58,353 节点、310,671 关系。环境变量、桥接及全仓命名仍待继续，不标记 D2 完成。
- D1 夹具闭包：移除 cloud-send-fixture 未被消费者使用的云移动 API 及 installOneHome 接线，删除 one-home-main.mjs/.d.mts；保留真实本地配对及权限夹具，最终服务端编译通过。旧签名团队运行验收仍不声称通过。
- D2 桥接子项：window.ogb 改为 window.hezuo，同步 preload 暴露键、前端/脚本调用和测试 mock，类型文件改为 hezuo.d.ts，不提供旧别名。前端/服务端编译、preload 语法检查及 91 项组件测试通过。索引已刷新至 58,287 节点、310,312 关系；D1/D2 总项仍未完成。
- A/C 定向组件与逻辑测试：10 个文件、270 项通过；创建与数据事件状态测试：2 个文件、238 项通过。数据事件不再自动打开电脑面板，创建动作先打开待确认弹窗，取消不创建 Bot。
- 前端 `pnpm exec tsc -b desktop` 已通过一轮集成检查；后续浏览器接管改动合入后仍需再检查。
- 当前仅为自动化阶段证据，尚未完成打包 app 的 A/B/C 实机验收，不勾选下方功能验收项。
- macOS 签名、公证继续等待 Developer ID 证书；后台对账与账号清理留到统一测试；管理后台改版留到下一批；Bot 全对话操控不在本批实现。
- 中文 `product.balance` 已统一为“积分”；`rg -l '点数余额' desktop/src --glob '!*.test.*'` 无输出。12 个本轮界面逻辑文件定向 `oxlint --deny-warnings`：0 warnings、0 errors。
- 发现 Vitest 原先只收集 `desktop/src/**/*.test.ts`，所以前述 270 项不包含新建弹窗的 `.test.tsx`。已补充 TSX 收集规则，单独运行 `SimpleNewBotDialog.test.tsx`：9 项通过，未将漏跑当作通过。
- 隔离新建窗口实测：自定义名字“验收机器人”、蓝色头像、中文提示词创建后，选中该 Bot 且 activeView=chat，保存内容与输入一致；名字清空时创建按钮禁用，取消后 Bot 数量仍为 3。头像组件多余的模型提供商/API Key/生成配置已在创建窗口隐藏，设置页保留。截图：`/var/folders/s0/5h112y2d3495p65t6p7cph400000gn/T/omp-sshots-15cdf815f52a1928.webp`；隔离服务日志：`server-1794669858109-62828.log`。尚未证明模型遵守提示词、上传图片的真实界面效果或打包 app 行为。
- 接管与登录卡片相关 3 个文件 36 项通过，原生 surface 的 6 项 node 测试通过；头像组件、新建窗口和 CDP 相关 3 个文件 25 项通过。设置弹窗及聊天标题栏更新后的 150 项通过。以上不替代真实登录 Cookie 与窗口焦点验收。
- `node scripts/verify-embedded-browser.mjs`：真实隔离 Electron 11 个步骤全部通过，证据 `.omb-scratch/embedded-browser-evidence/result.json`。覆盖原生接管焦点、复用窗口、同一 webContents/页面、关闭保留测试 Cookie、Bot 恢复、双 Bot 独立窗口与 Cookie、撤销权限只隐藏对应页面。此为源码隔离夹具，不是安装包或真实百度账号扫码验收。
- 日志脱敏：修复 `companionToken`、`fishKey`、`openrouterKey` 及大小写折叠后的 HTTP Headers 泄漏；20 项 node 测试全部通过，定向 lint 通过。保留 token 用量/ID 等诊断字段。第 8 类子进程网络覆盖仍待验证，不把整项遗留记为完成。
- 193 连通性：清除代理变量，使用 `.omb-scratch/remote-gateway-193/gateway-cert.pem` 校验访问 `/healthz` 返回 `ok:true`；本次未验证账号登录、积分和模型行为，也未部署或修改生产数据。
- 侧栏隔离拖拽夹具 `scripts/verify-sidebar-drag.ts --shots .omb-scratch/sidebar-drag-evidence` 通过：对话移入/移出文件夹、文件拖给 Bot、Bot 拖入聊天合组及右键菜单。此夹具使用 Chrome DragEvent，不是打包 app 的物理拖拽，后者仍待验收。
- 空分组删除入口经核实已存在：Simple/Product 的部门菜单 → 删除 → 保留成员的确认流程。新增取消不请求、确认仅删除目标 section 的回归；`Sidebar.departments.test.ts` 51 项通过，未为已有功能添加重复入口。
- 接管审查发现并修复：打开中取消失效、异步激活期间权限撤销丢失、原生窗口租约未续期、故障关闭误报完成。新增运行时/客户端回归，相关 30 项通过，前端类型与定向 lint 通过；真实 Electron 夹具重跑成功。安装包必须重建后再验收，旧产物不包含这些修复。
- 最新合并回归：A/B/C 相关 22 个测试文件、774 项全部通过（`/tmp/hezuo-abc-combined-tests.log`）；前端 `tsc -b desktop` 和本机服务 `tsc -p desktop/tsconfig.server.json` 通过。仍不代表全仓测试或真实模型任务验收。
- 复审后的控制续期改用内部 `renewControl`：服务端只刷新当前仍有权限的控制者，不获取或转移控制。续期、接管客户端与原生运行时 4 个测试文件共 31 项通过（`/tmp/hezuo-renew.log`）。
- 打包阻塞：面向 193 的 mac arm64 未签名目录包构建中，`electron-builder` 请求等待 600000 ms 后超时，退出码 1（`/tmp/hezuo-abc-package.log`）；失败请求的目标尚未确认。不能用现有 `release/` 产物作为最新代码的验收依据。


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
- [x] Bot 对话里看不到右侧面板，也找不到打开它的入口。真实 arm64 安装包在 1440×900、1000×800 实测 panel=false、entries=0，点击聊天头像后仍无面板；证据 `hezuo-product-verify-ZLQckU/evidence/receipt.json` 的 noRightPanel 及对应截图。
- [ ] 之前会自动打开面板的情况（Bot 登录、打开浏览器、控制电脑、新手引导）都不再打开面板，也不报错。
- [ ] 让 Bot "打开百度，读一下首页标题"，Bot 照样能完成并回复。

#### B. 浏览器接管
- **用户最新取消**：不再执行百度登录、二维码扫码及登录后刷新保持状态的测试；不会请求用户扫码。这些项目从本轮验收范围移除，非测试通过。通用窗口复用、隔离与状态保持仅采用独立原生窗口测试证据，不冒充百度真实登录。
- [ ] 让 Bot "打开百度"：只回复内容，不出现任何接管提示。
- 不执行（用户取消）：百度登录卡片与百度二维码页面人工验收。
- [x] 窗口已开时再点一次：不开第二个窗口，只把现有窗口拉到前面。独立原生 Electron fixture 复测通过：相同 surface、窗口总数不增加；证据 `/tmp/hezuo-final-native-browser-receipt.json` 与日志，不代表百度登录已执行。
- 不执行（用户取消）：百度扫码成功后交还及刷新保持登录状态验收。
- [ ] 点"取消"：不弹窗口，Bot 回复用户取消了登录。
- [x] 两个 Bot 各自要求登录：各自弹出自己的窗口，标题能区分，互不影响。通用窗口层由独立原生 Electron fixture 验证 Alpha/Beta 标题、session/cookie 隔离；证据 `/tmp/hezuo-final-native-browser-receipt.json`。真实百度登录已取消。

#### C. 新建 Bot
- [x] 点"新建机器人"弹出窗口，只有头像、名字、提示词三项和创建、取消两个按钮。真实 arm64 包截图及 `hezuo-product-verify-urNTTL/evidence/receipt.json` 的 simpleNewBot.controls 验证。
- [x] 不改任何东西直接创建：Bot 用默认头像和预填的名字。新 arm64 验证包收据 `hezuo-product-verify-QxMs7W/evidence/receipt.json` 的 `avatarCreation.untouchedDefaults.nonColorChecks.passed=true`；颜色一致性按用户要求排除，未记为通过。
- [x] 上传图片：侧栏头像和对话里的头像都是新选的。新包真实 file input 上传 PNG，`avatarCreation.uploadedPng.passed=true`、`resourceBytesVerified=true`，两处加载与持久 URL 一致；截图 `12c-avatar-upload-created.png`。颜色/改色检查按用户要求排除，不算通过；本项仅勾本轮保留的上传范围。
- [ ] 提示词填"你只用中文回答，每次回答不超过三句话"，创建后发"介绍一下你自己"：回复是中文、不超过三句。
- [x] 提示词超过 24,000 字节：创建按钮不可点，并提示超长。真实输入 24,003 UTF-8 字节，按钮禁用且显示上限警告，证据同上 overflow。
- [x] 点取消：不创建任何 Bot。真实编辑后取消，API 列表及持久化档案无变化，证据同上 cancelUnchanged。
- [x] 名字为空：创建按钮不可点。真实清空名称后验证禁用，证据同上。

#### A、B、C 通用
- [x] 前端类型检查 `npx tsc -b desktop` 通过；改到的文件 `npx oxlint --deny-warnings` 无新警告。当前 `pnpm typecheck`（含前端及服务）与全量 `pnpm lint` 均退出码0，日志 `/tmp/hezuo-final-closures-types.log`、`/tmp/hezuo-final-closures-lint.log`；此项不代表全部测试或实机通过。
- [x] 改到的组件和状态都有单元测试；限定 ABC 目标无生产组件删除，A 是移除挂载/入口；ComputerPanel 仍由 ComputerTab embedded 使用，测试应保留。App/ChatView/Sidebar、登录卡/接管、简化创建/头像/草稿及审批安全均有对应测试，精确目标无 skip/todo/only。测试代码覆盖与已记录定向通过不等于全库所有测试通过；全量批次另列。
- [x] 中文、英文文案都补全，新文案不出现英文占位。创建/接管关键字面量及动态键双语存在、非空；插值变量属于正常模板。静态键核查及定向组件回归通过，不声称已逐屏切换语言实机验收。
- [x] 每项验收附现有截图或日志，未通过与缺失前置单独列出，不写成已通过。最新成功证据 B6dAc1、原生窗口收据及定向门禁见本批进度；真实模型凭据、隔离电脑显示、未完整覆盖场景与全量测试状态明确保留。此勾仅表示证据记录和状态披露完成，不表示全部功能通过。

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
- 安全政策：按用户最新要求删除 `SECURITY.md`，由用户后续补充，本批不要求提供联系方式。

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

- [x] 网关测试全部通过。`pnpm --filter @hezuo/control-plane test` 退出码 0，15 个文件 323 项全部通过；日志 `/tmp/hezuo-gateway-full-regression.log`。不代表本轮193部署完成。
- [ ] 193 上用 `HEZUO_LOCAL_*` 配置启动，`systemctl status hezuo-gateway` 是 active，`/healthz` 返回 `ok:true`。
- [ ] 已有账号能登录，余额、账本跟部署前一致。
- [ ] 管理后台 `/admin` 能打开，能查到账号。

#### 5. 手机端

- 用户已取消手机端交付，Android/iOS 编译、手机配对和手机运行抓包不再作为当前验收项，非测试通过。
- 本地原生工程、专属接口及 APNs 已删除，新包残留扫描和隔离账号验证见阶段证据；193 线上退役变更仍需部署后核验，不以本地删除替代。

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
