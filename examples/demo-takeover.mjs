/**
 * An HTML game exposing dsh-environment/v1, controlled by one task call.
 *   node examples/demo-takeover.mjs          # local rule provider, no downloads
 *   node examples/demo-takeover.mjs --serve  # print endpoint for DSH decision_run
 *   LAYA_MODEL_DIR=/bundle node examples/demo-takeover.mjs --laya
 */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createDecisionLayer, HttpEnvironmentAdapter, ENVIRONMENT_PROTOCOL } from '../lib/embed.js'

const episodeId = randomUUID()
let position = 0
let revision = 0
const applied = new Map()
const snapshot = () => ({
  protocol: ENVIRONMENT_PROTOCOL, environmentId: 'coin-corridor', episodeId, revision: String(revision),
  state: { position, destination: 20, score: position * 10, instruction: 'Move right to collect all 20 coins.' },
  candidates: position >= 20 ? [] : [
    { id: 'right', description: 'Move one cell right and collect the next coin.' },
    { id: 'wait', description: 'Remain in the current cell.' },
  ],
  done: position >= 20,
  ...position < 20 ? {} : { result: { score: position * 10, outcome: 'won', coins: position } },
})

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
}
const server = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(new URL('./takeover-game.html', import.meta.url)))
      return
    }
    if (req.method === 'GET' && req.url === '/environment/state') return json(res, 200, snapshot())
    if (req.method !== 'POST' || req.url !== '/environment/action') return json(res, 404, { error: 'not found' })
    let body = ''
    for await (const chunk of req) {
      body += String(chunk)
      if (body.length > 16_384) return json(res, 413, { error: 'action too large' })
    }
    let action
    try { action = JSON.parse(body) } catch { return json(res, 400, { error: 'invalid JSON' }) }
    if (action?.protocol !== ENVIRONMENT_PROTOCOL || typeof action.actionId !== 'string' || action.actionId === '') return json(res, 400, { error: 'invalid action' })
    // An identical actionId never performs the same move twice.
    if (applied.has(action.actionId)) {
      const previous = applied.get(action.actionId)
      if (previous.request !== JSON.stringify(action)) return json(res, 409, { ok: false, message: 'actionId reused with another command' })
      return json(res, 200, previous.response)
    }
    if (action.environmentId !== 'coin-corridor' || action.episodeId !== episodeId || action.revision !== String(revision)) return json(res, 409, { ok: false, message: 'stale episode or revision' })
    if (position >= 20 || !snapshot().candidates.some(candidate => candidate.id === action.candidateId)) return json(res, 409, { ok: false, message: 'action not available' })
    if (action.candidateId === 'right') position++
    revision++
    const response = { ok: true, observation: snapshot() }
    applied.set(action.actionId, { request: JSON.stringify(action), response })
    return json(res, 200, response)
  })().catch(error => json(res, 500, { error: error.message }))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
const origin = `http://127.0.0.1:${address.port}`
console.log(`Game: ${origin}/`)
console.log(`DSH: decision_run ${JSON.stringify({ endpoint: `${origin}/environment`, objective: 'Collect every coin, finish the game, and report the final score.' })}`)

if (!process.argv.includes('--serve')) {
  const useModel = process.argv.includes('--laya')
  const decisions = createDecisionLayer(useModel ? {
    laya: { ...process.env.LAYA_MODEL_DIR === undefined ? {} : { modelDir: process.env.LAYA_MODEL_DIR } },
  } : {
    laya: false,
    providers: [{
      id: 'demo-rules', capabilities: ['choice'],
      async decide(request) { return { provider: 'demo-rules', mode: 'choice', selected: request.candidates.find(candidate => candidate.id === 'right')?.id, latencyMs: 0 } },
    }],
  })
  try {
    const result = await decisions.runTask({
      environment: new HttpEnvironmentAdapter({ endpoint: `${origin}/environment` }),
      objective: 'Collect every coin and finish the game.',
    })
    console.log(JSON.stringify({ status: result.status, steps: result.steps, result: result.result, reason: result.escalation?.reason }, null, 2))
    if (result.status !== 'done') process.exitCode = 1
  } finally {
    await decisions.dispose()
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections() })
  }
} else {
  process.once('SIGINT', () => { server.close(); server.closeAllConnections() })
  process.once('SIGTERM', () => { server.close(); server.closeAllConnections() })
}
