/**
 * Games bridge: 把贪吃蛇/俄罗斯方块暴露成 dsh-environment/v1 环境。
 *
 * 形状（这是 dsh-decision-engine 的 HttpEnvironmentAdapter 要求的契约）：
 *
 *   GET  /state   → EnvironmentSnapshot  { protocol, environmentId, episodeId, revision,
 *                                          state, candidates[], done, result? }
 *   POST /action  → { ok, message, observation: EnvironmentSnapshot }
 *
 * 谁持有什么：
 *   - 本进程持有**权威游戏状态**，游戏规则（core/*-core.js）在这里演算；
 *   - 浏览器页只是一个**实时镜像**，通过 GET /render 轮询当前局面来画图。
 *   这样决策循环不会被前端的渲染节奏干扰，前端也不参与决策。
 *
 * 动作表面：
 *   - snake  ：候选 = 合法方向（up/down/left/right，去掉掉头）
 *   - tetris ：候选 = tetrisLegalPlacements() 给出的合法落点 {rot,x}，按事实排序后截断前 N 个
 *
 * 启动：node games/bridge/server.mjs [--port 8787] [--game snake|tetris] [--seed N]
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import {
  createSnakeState, snakeSnapshot, snakeLegalActions, snakeStep,
  snakeLayaState, snakeStrategyAction, snakeStrategyCriteria, SNAKE_STRATEGIES,
  gridFloodFill, gridDistance,
} from '../core/snake-core.js'
import {
  createTetrisState, tetrisSnapshot, tetrisLegalPlacements,
  tetrisApplyPlacement, tetrisLayaState,
  tetrisStrategyPlacement, tetrisStrategyCriteria, TETRIS_STRATEGIES,
} from '../core/tetris-core.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 协议常量，必须与 adapter 的 ENVIRONMENT_PROTOCOL 一致。 */
const PROTOCOL = 'dsh-environment/v1'

// ---------------------------------------------------------------- 参数
const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt
}
const PORT = Number(flag('port', 8787))
const GAME = flag('game', 'snake')
const SEED = Number(flag('seed', 1))
const DIFFICULTY = flag('difficulty', 'normal')

/**
 * 交给决策层的候选**只有策略**（蛇 4 选 1 / 方块 4 选 1），具体怎么走由本地算法算。
 *
 * 这是三组对照（pure / veto / strategy）跑出来的结论：这个 provider 是 System-1 决策模型，
 * 擅长"从有限选项里选一个"，不擅长逐步决策。
 *
 * | 模式 | 蛇 | 俄罗斯方块 |
 * | --- | --- | --- |
 * | 每步都让模型选 | 0 分 / 16 步就死 | 600 分 / 5 行 / 顶死 |
 * | 只让模型选策略 | 12 分 / 166 步 / 15 长 | 55400 分 / 95 行 / 没死 |
 *
 * 所以桥固定用策略粒度：模型负责它擅长的"决策"，本地代码负责"执行"。
 *
 * 注意：**页面的人类按键和本地自动模式仍然走逐步动作**（`dir:*` / `drop:*`），
 * 那两条路是给人看的，不经过决策层。桥两种动作都接受，只是**给决策层的候选只有策略**。
 */
const STRATEGY_STEPS = Number(flag('strategy-steps', 8))

// ---------------------------------------------------------------- 局面
/** 一局游戏：持有权威 state，并负责把状态翻成协议要求的形状。 */
class Episode {
  /** 上一次落子的时间戳，用于算"距上次落子的间隔"。 */
  #lastApplyAt = null

  constructor(game, { seed = 1, difficulty = 'normal' } = {}) {
    this.game = game
    this.environmentId = game
    this.episodeId = `${game}-${Date.now().toString(36)}`
    this.revision = 0
    this.seed = seed
    this.difficulty = difficulty
    this.state = game === 'snake'
      ? createSnakeState({ seed, difficulty })
      : createTetrisState({ seed, difficulty })
    this.history = []
    /** 本局一共执行了多少次动作（页面上显示为"本局决策"）。 */
    this.decisions = 0
    /** 最近一次落子：给页面显示"选中了什么、候选有哪些"。 */
    this.lastMove = null
    /** 距上一次落子的间隔（毫秒）。决策层驱动时它约等于"决策 + 动作的墙钟时间"。 */
    this.lastGapMs = null
    this.#lastApplyAt = null
    /** 最近若干次候选集，用于显示排名（模型选了候选里的第几个）。 */
    this.candidateHistory = []
  }

  get done() {
    return this.game === 'snake' ? this.state.alive === false : this.state.alive === false
  }

  /** 终局结果：这是 isDone 之外的权威成绩。 */
  result() {
    if (this.game === 'snake') {
      return { game: 'snake', score: this.state.score, steps: this.state.steps, length: this.state.snake.length, cause: this.state.cause ?? null }
    }
    return { game: 'tetris', score: this.state.score, lines: this.state.lines, pieces: this.state.pieces, cause: this.state.cause ?? null }
  }

  /**
   * 交给决策层的状态。
   *
   * **刻意用 core 自带的 `*-layaState()`，不自己发明格式。**
   * 这些函数是游戏侧专为这个模型准备的表示法：蛇给的是 7×7 局部视野 + 相对食物偏移，
   * 方块给的是裁剪过的堆叠行 + 每列高度。旧的 laya-router 就是喂这个格式的
   * （它的页面上写着"模型只认英文"）；我第一版自己写了一套中文散文 + 绝对坐标，
   * 属于凭空换输入分布，实测成绩明显变差。
   *
   * 这里返回**对象**：provider 的 `serializeState()` 会 JSON.stringify 它，
   * 得到的就是旧系统那个结构。
   */
  stateForModel() {
    if (this.game === 'snake') return snakeLayaState(this.state)
    return tetrisLayaState(this.state)
  }

  /** 给页面用的一行中文摘要（模型看不到这个）。 */
  stateText() {
    if (this.game === 'snake') return snakeStateText(this.state)
    return tetrisStateText(this.state)
  }

  /**
   * 给决策层的候选：**只有策略**。
   * 描述用 core 的 `*StrategyCriteria()` —— 与旧 laya-router 给模型的是同一份措辞。
   */
  candidates() {
    if (this.done) return []
    if (this.game === 'snake') {
      const criteria = snakeStrategyCriteria(this.state)
      return SNAKE_STRATEGIES.map((s) => ({ id: `strategy:${s}`, description: criteria[s] ?? s }))
    }
    const criteria = tetrisStrategyCriteria(this.state)
    return TETRIS_STRATEGIES.map((s) => ({ id: `strategy:${s}`, description: criteria[s] ?? s }))
  }

  /**
   * 执行一个候选 id。
   *
   * `strategy:*` 是决策层的动作；`dir:*` / `drop:*` 是页面（人类按键、本地自动）的动作。
   * 两条路都走这里，所以"谁执行的"在页面上看得很清楚。
   */
  apply(candidateId) {
    // 记录"选了什么、当时有哪些候选" —— 页面靠这个显示决策详情，
    // 也是"模型选了候选集里第几个"这种排名的唯一来源。
    const offered = this.done ? [] : this.candidates().map((c) => ({ id: c.id, description: c.description }))
    const rankIndex = offered.findIndex((c) => c.id === candidateId)
    const now = Date.now()
    this.lastGapMs = this.#lastApplyAt === null ? null : now - this.#lastApplyAt
    this.#lastApplyAt = now
    this.lastMove = { candidateId, offered, rankIndex, at: this.revision }
    this.decisions += 1

    const id = String(candidateId)
    if (id.startsWith('strategy:')) return this.#applyStrategy(id)
    if (id.startsWith('dir:')) return this.#applySnakeMove(id)
    if (id.startsWith('drop:')) return this.#applyTetrisMove(id)
    return { ok: false, message: `无法识别的动作 id "${id}"（应为 strategy:* / dir:* / drop:*）` }
  }

  // ---------------------------------------------------------------- 决策层的动作：策略
  #applyStrategy(candidateId) {
    const m = /^strategy:([a-z]+)$/.exec(String(candidateId))
    if (m === null) return { ok: false, message: `无法解析策略 id "${candidateId}"（形如 strategy:chase）` }
    const strategy = m[1]

    if (this.game === 'snake') {
      if (!SNAKE_STRATEGIES.includes(strategy)) {
        return { ok: false, message: `未知策略 "${strategy}"（可用：${SNAKE_STRATEGIES.join('/')}）` }
      }
      // 一个动作 = 按这个策略连走若干步（对应旧系统的"策略沿用"）
      const played = []
      for (let i = 0; i < STRATEGY_STEPS; i++) {
        if (!this.state.alive) break
        const action = snakeStrategyAction(this.state, strategy)
        if (!action) break
        const ev = snakeStep(this.state, action)
        played.push(action)
        if (ev.died) break
      }
      this.history.push(...played)
      this.revision += 1
      const tail = this.state.alive ? '' : `，已死亡（${this.state.cause}）`
      return { ok: true, message: `策略 ${strategy}：连走 ${played.length} 步 [${played.join(' ')}]${tail}` }
    }

    if (!TETRIS_STRATEGIES.includes(strategy)) {
      return { ok: false, message: `未知策略 "${strategy}"（可用：${TETRIS_STRATEGIES.join('/')}）` }
    }
    const placement = tetrisStrategyPlacement(this.state, strategy)
    if (!placement) return { ok: false, message: `策略 ${strategy} 在当前盘面上找不到合法落点` }
    const ev = tetrisApplyPlacement(this.state, placement)
    this.history.push(`strategy:${strategy}`)
    this.revision += 1
    return {
      ok: true,
      message: `策略 ${strategy}：旋转 ${placement.rot} 放到第 ${placement.x} 列，消 ${ev?.cleared ?? 0} 行${this.state.alive ? '' : '，顶到天花板，游戏结束'}`,
    }
  }

  // ---------------------------------------------------------------- 页面用的逐步动作
  #applySnakeMove(candidateId) {
    const action = decodeSnakeAction(candidateId)
    if (action === null) return { ok: false, message: `无法解析方向 "${candidateId}"` }
    if (!snakeLegalActions(this.state).includes(action)) {
      return { ok: false, message: `"${action}" 不是当前合法动作（合法：${snakeLegalActions(this.state).join('/')}）` }
    }
    const ev = snakeStep(this.state, action)
    this.history.push(action)
    this.revision += 1
    const tail = ev.died
      ? `撞${ev.cause === 'wall' ? '墙' : ev.cause === 'self' ? '到自己' : '障碍物'}，游戏结束`
      : ev.ate ? `吃到食物，得分 ${this.state.score}` : '安全前进'
    return { ok: true, message: `走 ${action}：${tail}` }
  }

  #applyTetrisMove(candidateId) {
    const placement = parseTetrisId(candidateId)
    if (placement === null) return { ok: false, message: `无法解析落点 "${candidateId}"` }
    if (!tetrisLegalPlacements(this.state).some((p) => p.rot === placement.rot && p.x === placement.x)) {
      return { ok: false, message: `落点 ${candidateId} 不合法` }
    }
    const ev = tetrisApplyPlacement(this.state, placement)
    this.history.push(`drop:${placement.rot},${placement.x}`)
    this.revision += 1
    return {
      ok: true,
      message: `放置 drop:${placement.rot},${placement.x}：消 ${ev?.cleared ?? 0} 行${this.state.alive ? '' : '，顶到天花板，游戏结束'}`,
    }
  }

  /** 协议快照。`state` 是对象，由 provider 自己序列化（见 stateForModel 的说明）。 */
  snapshot() {
    const snap = {
      protocol: PROTOCOL,
      environmentId: this.environmentId,
      episodeId: this.episodeId,
      revision: String(this.revision),
      // 终局时把结果一并交代清楚，这样决策层（和读它的人）不会去猜为什么停了
      state: this.done
        ? { ...this.stateForModel(), episode_over: true, final_result: this.result() }
        : this.stateForModel(),
      candidates: this.candidates(),
      done: this.done,
    }
    if (this.done) snap.result = this.result()
    return snap
  }

  /** 给浏览器镜像用的原始局面 + 决策计数 + 最近一次落子。 */
  renderState() {
    const raw = this.game === 'snake' ? snakeSnapshot(this.state) : tetrisSnapshot(this.state)
    return {
      game: this.game,
      revision: this.revision,
      done: this.done,
      raw,
      result: this.done ? this.result() : null,
      decisions: this.decisions,
      lastMove: this.lastMove,
      lastGapMs: this.lastGapMs,
      /** 决策粒度：模型一次选一个策略，本地按策略连走/落子。 */
      granularity: this.game === 'snake' ? `策略（每动作连走 ${STRATEGY_STEPS} 步）` : '策略（每方块一次）',
      // 当前可选动作（页面上展示给人和模型看的同一份候选）
      candidates: this.done ? [] : this.candidates().map((c) => ({ id: c.id, description: c.description })),
      reward: this.game === 'snake' ? snakeRewardOf(this.state) : tetrisRewardOf(this.state),
      /** 桥自己写的一行中文局面摘要（模型看不到；页面/调试用）。 */
      stateText: this.stateText(),
      /** 方块页画落点预览要用：当前方块的全部合法落点。 */
      placements: this.game === 'tetris' && !this.done
        ? tetrisLegalPlacements(this.state).map((p) => ({ rot: p.rot, x: p.x, y: p.y }))
        : null,
      seed: this.seed,
      difficulty: this.difficulty,
    }
  }
}

/** 复刻页面上原来的奖励口径：吃到食物 +10，死亡 −100，其余按步数计。 */
function snakeRewardOf(s) {
  const food = s.score * 10
  const death = s.alive ? 0 : -100
  const steps = -s.steps * 0.1
  return { total: food + death + steps, food, steps: steps, death }
}

/** 方块页的奖励口径：消一行 +100，顶到天花板 −1000。 */
function tetrisRewardOf(s) {
  const lines = (s.lines ?? 0) * 100
  const topout = s.alive ? 0 : -1000
  const rate = s.pieces > 0 ? (s.lines ?? 0) / s.pieces : 0
  return { total: lines + topout, lines, pieces: s.pieces ?? 0, rate, topout }
}

// ---------------------------------------------------------------- snake 的候选与状态文本
function snakeStateText(s) {
  const head = s.snake[0]
  const free = (() => {
    try { return gridFloodFill(s, head) } catch { return '?' }
  })()
  const toFood = s.food ? gridDistance(s, head, s.food) : null
  return [
    `游戏：贪吃蛇（网格 ${s.size}×${s.size}，难度 ${s.difficulty}）`,
    `蛇头：(${head.x},${head.y})　当前朝向：${s.dir}　长度：${s.snake.length}`,
    `食物：${s.food ? `(${s.food.x},${s.food.y})，从蛇头按最短路 ${toFood ?? '不可达'} 步` : '无'}`,
    `障碍物：${(s.obstacles ?? []).length} 个`,
    `蛇头可达的空格数：${free}（越大越安全；太小可能把自己困死）`,
    `得分：${s.score}　已走步数：${s.steps}`,
    `目标：尽量吃到食物并活得更久，绝对不要撞墙或咬到自己。`,
  ].join('\n')
}

/**
 * 候选 id 的命名空间。
 *
 * 接入规范 1.1 要求「同一个工作流里重复决策时，同一个 id 必须指同一件事」。
 * 裸名字（up/down/left/right）会跟别的 id 空间撞车，所以统一带前缀：
 *   snake    ：`dir:<方向>`       —— 页面的人类按键 / 本地自动
 *   tetris   ：`drop:<rot>,<x>`   —— 同上
 *   decision ：`strategy:<名>`    —— **决策层唯一会看到的候选**
 */
const CANDIDATE_PREFIX = { snake: 'dir:', tetris: 'drop:', strategy: 'strategy:' }

const decodeSnakeAction = (id) => String(id).startsWith(CANDIDATE_PREFIX.snake) ? String(id).slice(CANDIDATE_PREFIX.snake.length) : null

/**
 * 落点 id 编解码。
 *
 * 刻意不用 `rot1-x-1` 这种写法：列号可以是负数（方块能贴到棋盘左侧外沿），
 * 于是 `x-1` 既可能是"列 1"也可能是"列 -1"，解析必然出歧义。
 * 用 `drop:1,-1`（旋转次数,列）就只有一个分隔符，负数也能安全解析 ——
 * 这个坑是实测踩出来的：运行时报 `无法解析落点 "rot1-x-1"`。
 */
function parseTetrisId(id) {
  const s = String(id)
  if (!s.startsWith(CANDIDATE_PREFIX.tetris)) return null
  const m = /^(\d+),(-?\d+)$/.exec(s.slice(CANDIDATE_PREFIX.tetris.length))
  if (m === null) return null
  return { rot: Number(m[1]), x: Number(m[2]) }
}

// ---------------------------------------------------------------- tetris 的候选与状态文本
function tetrisStateText(s) {
  const board = renderBoard(s.board)
  const p = s.piece
  const legalCount = tetrisLegalPlacements(s).length
  return [
    `游戏：俄罗斯方块（棋盘 ${s.w}×${s.h}，难度 ${s.difficulty}）`,
    `当前方块：${p ? p.type : '无'}　下一个：${pieceName(s.next)}`,
    `已消行：${s.lines}　得分：${s.score}　已放方块：${s.pieces}`,
    `本回合合法落点共 ${legalCount} 个（下面只列出其中一部分候选）。`,
    `棋盘（顶行在上，. 为空，字母为已固定的方块；G 是难度带来的垃圾行）：`,
    board,
    `目标：把方块放好，尽量多消行、少留空洞，不要让堆叠顶到天花板。`,
  ].join('\n')
}

/** `next` 在不同版本里可能是字符串、也可能是 {type}，两种都要能读。 */
function pieceName(next) {
  if (next == null) return '?'
  if (typeof next === 'string') return next
  if (typeof next === 'object' && typeof next.type === 'string') return next.type
  return '?'
}

function renderBoard(board) {
  const cells = board.map((row) => row.map((c) => (c === null || c === undefined || c === 0 ? '.' : String(c)[0])).join(''))
  return cells.join('\n')
}

// ---------------------------------------------------------------- 服务
let episode = new Episode(GAME, { seed: SEED, difficulty: DIFFICULTY })
const sseClients = new Set()

function broadcast() {
  const payload = `data: ${JSON.stringify(episode.renderState())}\n\n`
  for (const res of sseClients) {
    try { res.write(payload) } catch { sseClients.delete(res) }
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' }

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  // ---- 协议端点 ----
  if (url.pathname === '/state' && req.method === 'GET') {
    return json(200, episode.snapshot())
  }
  if (url.pathname === '/action' && req.method === 'POST') {
    let body
    try { body = JSON.parse(await readBody(req)) } catch { return json(400, { ok: false, message: '请求体不是合法 JSON' }) }
    if (body.protocol !== PROTOCOL) return json(400, { ok: false, message: `protocol 必须是 ${PROTOCOL}` })
    if (body.environmentId !== episode.environmentId || body.episodeId !== episode.episodeId) {
      return json(409, { ok: false, message: 'environmentId/episodeId 与本局不一致' })
    }
    // 乐观并发控制：动作必须基于它观察到的那个局面版本。
    // 不校验的话，两个驱动方（决策层 + 人在页面上的按键）会互相插队，
    // 而且过期动作会静默落到已经变了的盘面上 —— 这是实测踩出来的：
    // 一次按键被投递两次时，两次落子都被执行了。
    if (String(body.revision) !== String(episode.revision)) {
      return json(409, {
        ok: false,
        message: `revision 过期：动作基于 ${String(body.revision)}，当前是 ${episode.revision}`,
        observation: episode.snapshot(),
      })
    }
    const outcome = episode.apply(body.candidateId)
    if (!outcome.ok) return json(200, { ok: false, message: outcome.message, observation: episode.snapshot() })
    broadcast()
    return json(200, { ok: true, message: outcome.message, observation: episode.snapshot() })
  }

  // ---- 浏览器镜像用 ----
  if (url.pathname === '/render' && req.method === 'GET') {
    return json(200, episode.renderState())
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(`data: ${JSON.stringify(episode.renderState())}\n\n`)
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }
  if (url.pathname === '/reset' && req.method === 'POST') {
    let opts = {}
    try { opts = JSON.parse(await readBody(req)) } catch { /* 默认参数 */ }
    episode = new Episode(GAME, {
      seed: opts.seed ?? SEED,
      difficulty: opts.difficulty ?? DIFFICULTY,
    })
    broadcast()
    return json(200, { ok: true, episodeId: episode.episodeId })
  }
  if (url.pathname === '/health') {
    return json(200, {
      ok: true, game: GAME, episodeId: episode.episodeId,
      revision: episode.revision, done: episode.done,
    })
  }

  // ---- 静态文件：真实页面 + 本地游戏核心 ----
  // 页面用 `/js/xxx.js` 导入，这里把它们映射到 `games/core/`，
  // 页面文件本身保持原样（除了数据层改成从桥同步）。
  let rel = url.pathname
  if (rel === '/') rel = '/index.html'
  const file = rel.startsWith('/js/')
    ? join(HERE, '..', 'core', rel.slice('/js/'.length))
    : join(HERE, '..', rel.slice(1))
  try {
    const buf = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    return res.end(buf)
  } catch { /* 落到 404 */ }
  return json(404, { ok: false, message: `没有这个路径：${rel}` })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] http://127.0.0.1:${PORT}`)
  console.log(`[bridge] 游戏=${GAME} 难度=${DIFFICULTY} 种子=${SEED}`)
  console.log(`[bridge] 决策粒度=策略${GAME === 'snake' ? `（模型一次选一个策略，本地按策略连走 ${STRATEGY_STEPS} 步）` : '（模型一次选一个策略，本地按策略算落点）'}`)
  console.log(`[bridge] 决策端点（给 decision_run 的 endpoint）：http://127.0.0.1:${PORT}/`)
  console.log(`[bridge] 观战页面：http://127.0.0.1:${PORT}/  （浏览器打开即可实时看）`)
})
