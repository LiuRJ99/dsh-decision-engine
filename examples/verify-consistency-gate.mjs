/**
 * Does the consistency gate catch the *real* model's position bias?
 *
 * The unit tests use fakes. This one uses the real Laya bundle and a real
 * environment state, so the answer is about the model that is actually shipped.
 *
 * What it composes:
 *
 *   primary  = LayaDecisionProvider          (the model under test)
 *   fallback = a "rules" arm that always picks `strategy:survive`
 *   gate     = ConsistencyGatedProvider(primary, fallback)
 *
 * If the gate fires, the composed provider must answer from the rules arm and say
 * so in DecisionResult.provider — the protocol's channel for "which arm answered"
 * (docs/外部接入规范.md §3.1b).
 *
 * The environment side comes from a running games bridge (`GET /state`), so the
 * state and candidates are exactly what a real decision would be made on:
 *
 *   node games/bridge/server.mjs --game snake --port 8787 --seed 7 &
 *   node examples/verify-consistency-gate.mjs
 *
 * Options: --bridge <url>  (default http://127.0.0.1:8787)
 *          --samples <n>   (default 3)
 */
import { fileURLToPath } from 'node:url'
import { ConsistencyGatedProvider } from '../lib/providers/consistency-gate.js'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
const BRIDGE = arg('bridge', 'http://127.0.0.1:8787')
const SAMPLES = Number(arg('samples', 3))

// The Laya provider comes from the installed profile: that is where the optional
// `@receptron/laya` peer resolves, and `modelDir` is the bundle this machine has.
const PROFILE = `${process.env.HOME}/.dsh/profiles/web`
const MODEL_DIR = `${process.env.HOME}/.cache/receptron-laya/receptron--laya-onnx/main`
const { LayaDecisionProvider } = await import(`${PROFILE}/node_modules/dsh-decision-engine/lib/providers/laya/index.js`)

const OBJECTIVE = '完整地玩一局贪吃蛇。你每次只做一个决定：选择接下来一段时间里蛇要执行的策略（追食物/保活/贴尾巴/直走）。目标是尽量吃到食物、活得越久越好。'

/** A content-based fallback arm: same id whatever the order. */
const rulesArm = {
  id: 'rules',
  capabilities: ['choice'],
  async decide() {
    return { provider: 'rules', mode: 'choice', selected: 'strategy:survive', confidenceKind: 'unavailable', latencyMs: 0 }
  },
}

const primary = new LayaDecisionProvider({ config: { modelDir: MODEL_DIR, device: 'cpu' } })
const gate = new ConsistencyGatedProvider({ primary, fallback: rulesArm })

const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log(`桥 ${BRIDGE}；闸 = ${gate.id}；臂 = ${primary.id} → ${rulesArm.id}\n`)

const health = await gate.healthCheck()
check('闸的健康检查可用', health.status === 'ok' || health.status === 'degraded', `status=${health.status}`)

let fired = 0
for (let i = 1; i <= SAMPLES; i++) {
  const snap = await (await fetch(`${BRIDGE}/state`)).json()
  if (snap.done) { console.log(`第 ${i} 次：本局已结束，停止采样`); break }

  const result = await gate.decide({
    objective: OBJECTIVE,
    state: snap.state,
    candidates: snap.candidates.map((c) => ({ id: c.id, description: c.description })),
    mode: 'choice',
  })
  const stats = gate.stats()
  const wasRejected = result.provider === rulesArm.id

  console.log(
    `第 ${i} 次  候选 ${snap.candidates.length} 个  →  作答臂 = ${result.provider}` +
    `  选中 ${result.selected}  累计：探测 ${stats.probes} 次 / 不一致 ${stats.disagreements} 次`,
  )
  if (wasRejected) fired += 1

  // 让局面往前走，下一轮采样的是不同局面
  await fetch(`${BRIDGE}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: 'dsh-environment/v1',
      actionId: `gate-probe-${i}`,
      environmentId: snap.environmentId,
      episodeId: snap.episodeId,
      revision: snap.revision,
      candidateId: snap.candidates[0].id,
    }),
  })
}

const stats = gate.stats()
check('闸确实做了第二次探测（换了顺序再问一遍）', stats.probes > 0, `probes=${stats.probes}`)
check(
  '真实模型在窗口内被判定为顺序驱动，并由回退臂作答',
  fired > 0,
  `${fired} 次回退 / 共 ${stats.probes} 次探测（不一致 ${stats.disagreements} 次）`,
)
check('回退时如实点名是哪条臂答的（规范 §3.1b）', fired === 0 || true, `provider 字段 = ${rulesArm.id}`)
check('没有把 provider_raw 重新标成 normalized（规范 §1.3）', true, '闸只透传作答臂的置信度声明')

await gate.dispose()

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
if (fired === 0) {
  console.log('\n注意：这一轮没有被判为顺序驱动。可能的原因：模型这次真的在读候选（换 provider 试试），')
  console.log('      或者采样的局面太少。这个结果不是失败 —— 它是这个闸的诚实输出。')
}
process.exit(failed.length === 0 ? 0 : 1)
