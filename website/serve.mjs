// 用法: node serve.mjs → http://127.0.0.1:4173 预览 dist/
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), 'dist')
const port = Number(process.env.PORT) || 4173
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' }

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname))
  const file = join(dist, path.endsWith('/') ? join(path, 'index.html') : path)
  if (!file.startsWith(dist)) return res.writeHead(403).end()
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`))
