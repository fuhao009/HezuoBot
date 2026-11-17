# HezuoBot 官网框架

构建 `node build.mjs` 生成 `dist/index.html` 无依赖 加 `--drafts` 一并带上设计稿
预览 `node serve.mjs` 打开 http://127.0.0.1:4173

| 想改什么 | 改哪里 |
|---|---|
| 配色 圆角 页面宽度 明暗主题 | `styles/tokens.css` |
| 版式 导航 页脚 价格 下载 | `styles/base.css` |
| 各个渲染场景的样子 | `styles/scenes.css` |
| 场景动效 | `styles/motion.css` `scripts/motion.js` 设计见 `MOTION.md` |
| 导航 页脚 栏目顺序 | `content/site.json` |
| 下载 登录 升级 联系 页脚的链接 站点网址 分享简介 | `content/site.json` 的 `links` `footer.links` `url` `description` |
| Bot 形象的形状 配色 状态动作 | `scripts/bots.js` 构建时和页面上共用 |
| 图标 | `content/icons.json` |
| 某个栏目的内容 | `sections/<name>.html` |

栏目里可用的占位符 构建时展开

- `{{bot:drop:cyan:working}}` Bot 形象 依次是形状 颜色 状态 状态可省略
  形状 circle pill egg triangle square pentagon hexagon star4 star5 clover flower cloud drop bean dome splat pebble
  颜色 cyan blue green orange purple pink
  状态 idle working thinking asking done error
- `{{bot-choices}}` `{{color-choices}}` 头像选择器里的形状按钮和颜色按钮
- `{{icon:globe}}` 线条图标 名称见 `icons.json`
- `{{cursor}}` 浏览器场景里的指针
- `{{link:mac}}` 写在 `<a>` 标签里 取 `site.json` 的 `links.mac` 没填时按钮变灰不可点 构建时会列出还没填的项

## 设计约定

- 每个栏目一句标题加一个渲染场景 不写说明段落
- 页面文案不用逗号句号等标点
- 图标和头像只用图案 不放文字
- 头像是一套通用形象 由客户自己挑形状和颜色 不给某个 Bot 专属形象
- Bot 的状态用动作表达 等待静止 工作弹动 思考呼吸 等确认弹跳 完成笑眼 报错变红泄气
- 一次只改一层

## 素材来源

页面上的图形全部是本目录里的原创图形 Bot 形象由 `scripts/bots.js` 里的函数生成 品牌标志是 `assets/logo.png` 分享卡片是 `assets/og.png` 不含上游项目的名称 标志和吉祥物
上游的名称与吉祥物是其权利人的商标 见仓库根目录 `LICENSING.md` 不要把它们放进官网
不使用第三方产品的标志和名称 字体只用系统字体

## 草稿

`drafts/` 里是设计过程稿 只有 `node build.mjs --drafts` 才会复制到 `dist/`

- `bots.html` Bot 形象动态稿 可切换状态 质感 颜色 换一批形状
- `avatars.html` 早先的四套静态方案
- `icons.html` 应用图标底板方案
- `desktop.html` 电脑端新布局稿 只有对话 提示词 头像选择 可切换两种方案
