/**
 * 静态服务器：只做一件事 —— 把 games/ 下的页面和 core/ 下的游戏规则发出去。
 *
 * **这里没有游戏逻辑。** 游戏跑在页面里（浏览器里），决策层通过浏览器插件接管页面
 * （读页面上的文字状态、点页面上的真按钮）。之前那个"桥持状态 + HTTP 协议"的版本
 * 已经删掉了：那条路要另开一套 `/state` `/action` 协议、一套节拍和一套记账，
 * 而它带来的唯一好处是"批测更快"—— 但代价是页面变成显示器，接管对象从页面变成了端口。
 *
 * 两个游戏刻意跑在**同一个 origin**（同一个端口）：localStorage 按 origin 隔离，
 * 之前 :8787 / :8788 各存各的记录，一个页面看不到另一个游戏的成绩。
 *
 * 用法：node games/serve.mjs [--port 8787]
 * 然后浏览器打开 http://127.0.0.1:8787/snake.html （或 /tetris.html、/）
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, normalize } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const PORT = Number(args[args.indexOf('--port') + 1]) || 8787

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  let rel = url.pathname === '/' ? '/index.html' : url.pathname

  // `/js/*` 映射到 core/：页面 import 的是游戏规则，不是别的
  const file = rel.startsWith('/js/')
    ? join(HERE, 'core', normalize(rel.slice('/js/'.length)))
    : join(HERE, normalize(rel.slice(1)))

  // 不许跑出 games/ 之外
  if (!file.startsWith(HERE)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('403')
  }

  try {
    const buf = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      // 禁缓存：页面还在开发中，不带这个头浏览器会一直用缓存副本，
      // 于是"源码改了、页面没变"，排查半天才发现看的是旧页面（实测踩到过）。
      'cache-control': 'no-store, must-revalidate',
    })
    return res.end(buf)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end(`404 ${rel}`)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve] 大厅     http://127.0.0.1:${PORT}/`)
  console.log(`[serve] 贪吃蛇   http://127.0.0.1:${PORT}/snake.html`)
  console.log(`[serve] 俄罗斯方块 http://127.0.0.1:${PORT}/tetris.html`)
  console.log('[serve] 接管模式：在上面地址后面加 ?takeover=1 —— 页面会收起人类控件，'
    + '只留下决策层可读的局面文字和四个策略按钮')
  console.log('[serve] 两个游戏同一个 origin，所以记录（localStorage）是同一份')
})
