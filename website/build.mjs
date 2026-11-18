// 用法: node build.mjs  → 生成 dist/index.html（样式与脚本内联） 加 --drafts 一并带上设计稿
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(join(root, p), 'utf8')
const site = JSON.parse(read('content/site.json'))
const icons = JSON.parse(read('content/icons.json'))

const sandbox = {}
vm.runInNewContext(read('scripts/bots.js'), sandbox)
const Bots = sandbox.HezuoBots
const botChoices = Bots.kinds
  .map(([kind, label]) => `<button data-kind="${kind}" aria-pressed="false" aria-label="${label}">${Bots.markup({ kind, color: 'cyan' })}</button>`)
  .join('')
const colorChoices = Bots.colors.map((color, i) => `<button class="swatch" data-color="${color}" style="background:${Bots.swatch(color)}" aria-pressed="false" aria-label="颜色 ${i + 1}"></button>`).join('')
const logo = `<img class="mark" src="assets/logo-128.png" alt="">`
const cursor = `<svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.2v15.4l4.3-3.7 2.9 6 2.6-1.3-2.9-5.9h5.6z" stroke-linejoin="round"/></svg>`
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`
const missing = new Set()
const link = (name) => {
  if (site.links[name]) return `href="${site.links[name]}"`
  missing.add(`links.${name}`)
  return 'aria-disabled="true"'
}
const expand = (html) =>
  html
    .replace(/\{\{link:(\w+)\}\}/g, (_, name) => link(name))
    .replace(/\{\{bot:(\w+):(\w+)(?::(\w+))?\}\}/g, (_, kind, color, state) => Bots.markup({ kind, color, state }))
    .replace('{{bot-choices}}', botChoices)
    .replace('{{color-choices}}', colorChoices)
    .replace(/\{\{cursor\}\}/g, cursor)
    .replace(/\{\{icon:(\w+)\}\}/g, (_, name) => icon(name))

const css = ['styles/tokens.css', 'styles/base.css', 'styles/scenes.css', 'styles/motion.css'].map(read).join('\n')

const toggleTheme = `var r=document.documentElement,d=r.dataset.theme?r.dataset.theme=='dark':matchMedia('(prefers-color-scheme:dark)').matches;r.dataset.theme=d?'light':'dark';try{localStorage.theme=r.dataset.theme}catch(e){}`

const header = `<header><div class="wrap"><nav>
  <a class="logo" href="#">${logo}${site.brand}</a>
  <ul>${site.nav.map((n) => `<li><a href="${n.href}">${n.label}</a></li>`).join('')}</ul>
  <div class="tools"><button class="theme" aria-label="切换明暗主题" onclick="${toggleTheme}"></button><a ${link('login')}>${site.navCta.login}</a><a class="btn primary" href="${site.navCta.href}">${site.navCta.download}</a><button class="menu" aria-label="菜单" aria-expanded="false"></button></div>
</nav></div></header>`

const footerLink = ({ label, href }) => {
  if (!href) missing.add(`footer ${label}`)
  return `<li><a ${href ? `href="${href}"` : 'aria-disabled="true"'}>${label}</a></li>`
}
const footer = `<footer><div class="wrap"><ul>${site.footer.links.map(footerLink).join('')}</ul><span>${site.footer.legal}</span></div></footer>`

const sections = site.sections.map((s) => expand(read(`sections/${s}.html`))).join('\n')

const html = `<!doctype html>
<html lang="${site.lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${site.title}</title>
<meta name="description" content="${site.description}">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme:dark)">
<meta property="og:type" content="website">
<meta property="og:title" content="${site.title}">
<meta property="og:description" content="${site.description}">
<meta property="og:image" content="${site.url}${site.url ? '/' : ''}assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="assets/logo-128.png">
<link rel="apple-touch-icon" href="assets/apple-touch-icon.png">
<script>try{var t=localStorage.theme;if(t)document.documentElement.dataset.theme=t}catch(e){}if(!matchMedia('(prefers-reduced-motion:reduce)').matches)document.documentElement.classList.add('motion')</script>
<style>
${css}</style></head>
<body>
${header}
<main>
${sections}
</main>
${footer}
<script>
${[read('scripts/bots.js'), read('scripts/motion.js')].join('\n;')}</script>
</body></html>
`
rmSync(join(root, 'dist'), { recursive: true, force: true })
mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist/index.html'), html)
cpSync(join(root, 'assets'), join(root, 'dist/assets'), { recursive: true })
if (process.argv.includes('--drafts')) {
  cpSync(join(root, 'drafts'), join(root, 'dist'), { recursive: true })
  cpSync(join(root, 'scripts/bots.js'), join(root, 'dist/bots.js'))
}
console.log('built dist/index.html')
if (!site.url) missing.add('url')
if (missing.size) console.log(`content/site.json 里还没填 ${[...missing].join(' / ')}`)
