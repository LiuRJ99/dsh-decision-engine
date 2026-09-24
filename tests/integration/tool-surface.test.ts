/**
 * Phase 3 integration: the public tool surface and the composition root.
 *
 * Exercises the exact path a model call takes — `decision_decide` arguments →
 * preflight → engine → environments → tool dispatcher — through the real
 * `createDecisionEngineComposition`.
 *
 * @module dsh-decision-engine/tests/integration/tool-surface.test
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { createDecisionEngineComposition } from '../../src/index.ts'
import type { Config } from '../../src/index.ts'
import { createMapDispatcher } from '../../src/environments/dispatch.ts'
import { CustomEnvironmentAdapter } from '../../src/environments/custom/adapter.ts'
import { DecisionError } from '../../src/core/errors.ts'
import { executeDecide, executionModeOf, renderDecideOutput } from '../../src/tools/decide-logic.ts'
import { constantProvider, ScriptedProvider } from '../helpers.ts'

/** The documented minimal request from the specification. */
const MINIMAL = {
  objective: '选择下一步',
  state: '任务已经完成下载',
  candidates: [
    { id: 'open', description: '打开文件' },
    { id: 'wait', description: '继续等待' },
  ],
}

function composition(options: { decided?: string; config?: Config; extra?: Parameters<typeof createDecisionEngineComposition>[0]['extraProviders'] } = {}) {
  const decided = options.decided ?? 'open'
  const provider = new ScriptedProvider({
    id: 'stub',
    plan: (request) => ({
      provider: 'stub',
      mode: request.mode ?? 'choice',
      ...(() => {
        const picked = request.candidates.some(candidate => candidate.id === decided) ? decided : request.candidates[0]?.id
        return picked === undefined
          ? {}
          : {
              selected: picked,
              // A real provider always orders the options it was given; the
              // stub does the same so the tool output is representative.
              ranking: [picked, ...request.candidates.map(candidate => candidate.id).filter(id => id !== picked)].map(id => ({ id })),
            }
      })(),
      confidence: 0.84,
      confidenceKind: 'provider_raw',
      latencyMs: 3,
    }),
  })
  const dispatcher = createMapDispatcher({})
  const created = createDecisionEngineComposition({
    config: { defaultProvider: 'stub', providers: { laya: { enabled: false } }, ...options.config },
    dispatcher,
    extraProviders: options.extra ?? [{ provider }],
  })
  return { ...created, provider, dispatcher }
}

describe('decision_decide without an environment', () => {
  it('answers the documented minimal request', async () => {
    const { service } = composition()
    const output = await executeDecide(MINIMAL, { service })
    assert.equal(output.status, 'decided')
    assert.equal(output.provider, 'stub')
    assert.equal(output.selected, 'open')
    assert.equal(output.confidence, 0.84)
    assert.deepEqual(output.candidates, ['open', 'wait'])
    const text = renderDecideOutput(output)
    assert.match(text, /Decision: open/)
    assert.match(text, /Confidence: 0.840/)
  })

  it('routes to the default provider when none is named', async () => {
    const { service, provider } = composition()
    const output = await executeDecide(MINIMAL, { service })
    assert.equal(output.provider, 'stub')
    assert.equal(provider.calls.length, 1)
  })

  it('rejects a request with no state and no environment', async () => {
    const { service } = composition()
    await assert.rejects(executeDecide({ objective: 'x' }, { service }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'invalid_request'
    })
  })

  it('rejects a request with no candidates and no environment', async () => {
    const { service } = composition()
    await assert.rejects(executeDecide({ objective: 'x', state: 's' }, { service }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'no_candidates'
    })
  })

  it('surfaces a low-confidence refusal as a DecisionError, not a decision', async () => {
    const provider = new ScriptedProvider({ id: 'unsure', plan: () => ({ provider: 'unsure', mode: 'choice', selected: 'open', confidence: 0.1, confidenceKind: 'normalized', latencyMs: 1 }) })
    const created = createDecisionEngineComposition({
      config: { defaultProvider: 'unsure', providers: { laya: { enabled: false } }, runtime: { confidenceThreshold: 0.8 } },
      dispatcher: createMapDispatcher({}),
      extraProviders: [{ provider }],
    })
    await assert.rejects(executeDecide(MINIMAL, { service: created.service }), (error: unknown) => {
      return error instanceof DecisionError && error.code === 'low_confidence'
    })
  })

  it('names the registered environments when an unknown one is requested', async () => {
    const { service } = composition()
    await assert.rejects(executeDecide({ environment: 'nope', objective: 'x' }, { service }), (error: unknown) => {
      return error instanceof DecisionError && error.message.includes('nope')
    })
  })
})

describe('decision_decide with a custom environment', () => {
  function withSnake(decided: string) {
    const executed: string[] = []
    let score = 0
    const snake = new CustomEnvironmentAdapter<{ score: number; alive: boolean; availableActions: string[] }>({
      id: 'snake',
      observe: () => ({ score, alive: true, availableActions: ['up', 'down', 'left', 'right'] }),
      candidates: state => state.availableActions.map(action => ({ id: action, description: `Move ${action}` })),
      execute: (candidate) => {
        executed.push(candidate.id)
        score += 1
        return { ok: true, message: `moved ${candidate.id}`, state: { score } }
      },
      isDone: state => state.score >= 3,
    })
    const provider = new ScriptedProvider({
      id: 'stub',
      plan: (request) => {
        const pick = request.candidates.find(candidate => candidate.id === decided) ?? request.candidates[0]
        return { provider: 'stub', mode: 'choice', ...pick === undefined ? {} : { selected: pick.id }, confidence: 0.9, confidenceKind: 'provider_raw', latencyMs: 1 }
      },
    })
    const created = createDecisionEngineComposition({
      config: { defaultProvider: 'stub', providers: { laya: { enabled: false } }, browser: { enabled: false }, computer: { enabled: false } },
      dispatcher: createMapDispatcher({}),
      extraProviders: [{ provider }],
    })
    created.environments.register(snake)
    return { ...created, executed }
  }

  it('previews an action without executing it', async () => {
    const { service, executed } = withSnake('up')
    const output = await executeDecide({ environment: 'snake', objective: 'Play well.', execute: false }, { service })
    assert.equal(output.status, 'decided')
    assert.equal(output.action?.kind, 'custom')
    assert.equal(output.action?.candidateId, 'up')
    assert.deepEqual(executed, [])
  })

  it('executes one action in single-step mode', async () => {
    const { service, executed } = withSnake('left')
    const output = await executeDecide({ environment: 'snake', objective: 'Play well.', execute: true }, { service })
    assert.equal(output.status, 'executed')
    assert.equal(output.executed, true)
    assert.deepEqual(executed, ['left'])
  })

  it('runs a bounded loop until the environment reports done', async () => {
    const { service, executed } = withSnake('up')
    const output = await executeDecide({ environment: 'snake', objective: 'Play well.', execute: 'loop', maxSteps: 6 }, { service })
    assert.equal(output.status, 'done')
    assert.deepEqual(executed, ['up', 'up', 'up'])
  })

  it('maps the execute argument to a promotion level', () => {
    assert.equal(executionModeOf(undefined), 'decision-only')
    assert.equal(executionModeOf(false), 'decision-only')
    assert.equal(executionModeOf(true), 'single-step')
    assert.equal(executionModeOf('loop'), 'bounded-loop')
  })
})

describe('tool definition', () => {
  it('exposes exactly one decision tool, and the schema is a closed object', async () => {
    // The tool definition itself needs the host (`defineTool`), so this asserts
    // the pure surface it is built from: one name, one closed output shape, and
    // a preflight that refuses malformed calls before any policy runs.
    const { service } = composition()
    const { PARAMETERS } = await import('../../src/tools/decide-logic.ts')
    assert.deepEqual(Object.keys(PARAMETERS).sort(), [
      'allowRisky', 'browser', 'candidates', 'constraints', 'debug', 'environment', 'execute', 'maxSteps', 'mode', 'objective', 'provider', 'state',
    ])
    const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../../src/tools/decision-decide.ts', import.meta.url), 'utf8'))
    assert.match(source, /name: 'decision_decide'/)
    assert.ok(!/name: 'decision_(?!decide)/.test(source), 'no second decision tool may be defined')
    assert.deepEqual(
      [...source.matchAll(/'(decided|executed|done|needs_escalation)'/g)].map(match => match[1]),
      ['decided', 'executed', 'done', 'needs_escalation'],
    )
    const { preflightDecideInput } = await import('../../src/tools/decide-logic.ts')
    assert.match(preflightDecideInput({ objective: 'x' }, service) ?? '', /pass state, or pass environment/)
  })

  it('accepts state as a string or an object, matching the documented example', async () => {
    // The README's minimal example passes state as a string, so the schema must
    // accept both forms — a mismatch here only shows up when the tool is really
    // dispatched, which is how it was found.
    const { PARAMETERS } = await import('../../src/tools/decide-logic.ts')
    const state = PARAMETERS.state as unknown as { oneOf?: { type: string }[] }
    assert.deepEqual(state.oneOf?.map(branch => branch.type), ['object', 'string'])
  })

  it('renders an escalation with guidance and no fabricated decision', () => {
    const text = renderDecideOutput({
      status: 'needs_escalation',
      provider: 'stub',
      guidance: 'Use the main agent with a richer observation source; do not guess.',
      steps: 2,
    })
    assert.match(text, /Escalation/)
    assert.match(text, /do not guess/)
    assert.ok(!text.includes('Decision:'))
  })
})

describe('composition lifecycle', () => {
  it('registers and disposes providers and environments', async () => {
    const created = composition()
    assert.deepEqual(created.providers.ids(), ['stub'])
    assert.ok(created.environments.ids().includes('browser'))
    await created.dispose()
    assert.deepEqual(created.providers.ids(), [])
    assert.deepEqual(created.environments.ids(), [])
  })

  it('reports aggregate health', async () => {
    const { service } = composition()
    const health = await service.health()
    assert.equal(health.defaultProvider, 'stub')
    assert.equal(health.status, 'ok')
    assert.deepEqual(health.environments.sort(), ['browser', 'computer'])
  })

  it('refuses a defaultProvider that is not registered', () => {
    assert.throws(() => createDecisionEngineComposition({
      config: { defaultProvider: 'ghost', providers: { laya: { enabled: false } } },
      dispatcher: createMapDispatcher({}),
    }), (error: unknown) => error instanceof DecisionError && error.code === 'provider_unknown')
  })

  it('routes through the active provider when the requested default is disabled', async () => {
    const created = createDecisionEngineComposition({
      config: { defaultProvider: 'off', providers: { laya: { enabled: false } } },
      dispatcher: createMapDispatcher({}),
      extraProviders: [
        { provider: constantProvider('open', { id: 'off' }), enabled: false },
        { provider: constantProvider('open', { id: 'active' }) },
      ],
    })
    const health = await created.service.health()
    assert.equal(health.defaultProvider, 'active')
    assert.equal(health.requestedDefaultProvider, 'off')
    assert.equal((await created.service.decide(MINIMAL)).provider, 'active')
    created.setDefaultProvider('active')
    assert.equal((await created.service.health()).requestedDefaultProvider, undefined)
  })

  it('registers the Laya provider by default and can disable it', () => {
    const withLaya = createDecisionEngineComposition({ dispatcher: createMapDispatcher({}) })
    assert.deepEqual(withLaya.providers.ids(), ['laya'])
    const withoutLaya = createDecisionEngineComposition({ config: { providers: { laya: { enabled: false } } }, dispatcher: createMapDispatcher({}) })
    assert.deepEqual(withoutLaya.providers.ids(), [])
  })

  it('starts without a provider when Laya is disabled but remains the configured default', async () => {
    const created = createDecisionEngineComposition({
      config: { defaultProvider: 'laya', providers: { laya: { enabled: false } } },
      dispatcher: createMapDispatcher({}),
    })
    const health = await created.service.health()
    assert.equal(health.status, 'unavailable')
    assert.equal(health.defaultProvider, undefined)
    assert.equal(health.requestedDefaultProvider, 'laya')
    await assert.rejects(created.service.decide(MINIMAL), (error: unknown) =>
      error instanceof DecisionError && error.code === 'provider_unavailable')
  })

  it('keeps telemetry records on the composition for diagnostics', async () => {
    const { service, telemetryRecords } = composition()
    await executeDecide(MINIMAL, { service })
    assert.equal(telemetryRecords.length, 1)
    assert.equal(telemetryRecords[0]?.selected, 'open')
  })
})
