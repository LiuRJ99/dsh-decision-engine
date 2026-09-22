/**
 * LayaDecisionProvider — the first Decision Provider.
 *
 * It is a translation layer and nothing more: it takes the model-agnostic
 * {@link DecisionRequest}, asks Laya, and returns the model-agnostic
 * {@link DecisionResult}. Everything Laya-specific lives behind this file and
 * its siblings in `providers/laya/`: the SDK, the ONNX session, the
 * `choice`/`score`/`noul` question types, `criteria`, `instructions`,
 * `probabilities`, and `rl_agent`.
 *
 * Nothing in `core/`, `runtime/`, `environments/`, or `tools/` imports this
 * module. Deleting the whole `providers/laya/` directory leaves the rest of
 * the project compiling and working — the acceptance test for the boundary.
 *
 * @module dsh-decision-engine/providers/laya/provider
 */

import { DecisionError } from '../../core/errors.ts'
import { validateRequest } from '../../core/validate.ts'
import type { DecisionCapability, DecisionContext, DecisionProvider, DecisionRequest, DecisionResult, ProviderHealth } from '../../core/types.ts'
import type { LayaConfig } from './config.ts'
import { planQuestions, toResult, translateAnswers } from './modes.ts'
import { LayaRuntime, type LayaRuntimeOptions } from './runtime.ts'
import { resolveLayaConfig } from './config.ts'

/**
 * The provider.
 *
 * Capabilities are declared, not discovered: a request in a mode this provider
 * does not implement is refused by the engine before any inference runs.
 */
export class LayaDecisionProvider implements DecisionProvider {
  readonly id: string
  readonly capabilities: readonly DecisionCapability[] = ['choice', 'ranking', 'score', 'classification']

  readonly #runtime: LayaRuntime

  constructor(options: { id?: string; config?: LayaConfig; runtime?: LayaRuntime } & Omit<LayaRuntimeOptions, 'config'> = {}) {
    this.id = options.id ?? 'laya'
    this.#runtime = options.runtime ?? new LayaRuntime({
      ...options.config === undefined ? {} : { config: options.config },
      ...options.loadModule === undefined ? {} : { loadModule: options.loadModule },
      ...options.instance === undefined ? {} : { instance: options.instance },
      // Both defaults come from the resolved config, so `providers.laya.autoLoad`
      // and `providers.laya.idleTtlMs` work without a code change.
      autoLoad: options.autoLoad ?? resolveLayaConfig(options.config).autoLoad,
      ...options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs },
    })
  }

  /** The underlying runtime, for diagnostics. */
  get runtime(): LayaRuntime {
    return this.#runtime
  }

  /**
   * Answer one decision request.
   *
   * @throws DecisionError with `provider_unavailable`, `provider_timeout`,
   *   `aborted`, `invalid_decision`, or `provider_failed`.
   */
  async decide(request: DecisionRequest, context?: DecisionContext): Promise<DecisionResult> {
    const validated = validateRequest(request)
    const config = this.#runtime.config
    const started = Date.now()

    const plan = planQuestions(validated.mode, validated, config)
    if (plan.questions.length === 0) {
      throw new DecisionError('invalid_decision', `No question could be planned for mode "${validated.mode}".`, { subject: this.id })
    }

    const questions: Record<string, { type: 'choice' | 'score' | 'noul'; instructions: string; criteria?: unknown }> = {}
    for (const planned of plan.questions) {
      questions[planned.key] = {
        type: planned.question.type,
        instructions: planned.question.instructions,
        ...planned.question.criteria === undefined ? {} : { criteria: planned.question.criteria },
      }
    }

    const result = await this.#runtime.systemOne(plan.state, questions, context?.signal)
    const latencyMs = Date.now() - started
    const translated = translateAnswers(validated.mode, plan, result, config, validated.request.candidates.map(candidate => candidate.id))

    if (config.strictCandidates && translated.selected !== undefined && !validated.byId.has(translated.selected)) {
      throw new DecisionError('unknown_candidate', `Laya selected "${translated.selected}", which is not in the candidate set.`, {
        subject: this.id,
        details: { selected: translated.selected, candidates: [...validated.byId.keys()] },
      })
    }

    return toResult(translated, {
      providerId: this.id,
      mode: validated.mode,
      latencyMs,
      includeDebug: context?.debug === true,
      ...result.usage?.input_tokens === undefined ? {} : { inputTokens: result.usage.input_tokens },
    })
  }

  /**
   * Report runtime health.
   *
   * `offline` (the SDK is not installed) is `degraded`, not `unavailable`: the
   * provider is not usable for decisions but the deployment is intentional.
   * The distinction lets a caller choose a fallback provider without treating
   * the whole layer as broken.
   */
  async healthCheck(): Promise<ProviderHealth> {
    const status = this.#runtime.status
    const details = {
      runtimeStatus: status,
      modelDir: this.#runtime.config.modelDir ?? null,
      loadMs: this.#runtime.loadMs,
      idleTtlMs: this.#runtime.idleTtlMs,
      unloads: this.#runtime.unloads,
      required: this.#runtime.config.required,
      stats: this.#runtime.stats,
    }
    if (status === 'ready') {
      return {
        status: 'ok',
        details: { ...details, maxLen: this.#runtime.instance?.config?.max_len ?? null },
      }
    }
    if (status === 'offline' || status === 'idle') {
      return {
        status: 'degraded',
        reason: this.#runtime.error ?? 'The Laya model has not been loaded yet.',
        details,
      }
    }
    if (status === 'loading') {
      return { status: 'degraded', reason: 'The Laya model is still loading.', details }
    }
    return { status: 'unavailable', reason: this.#runtime.error ?? `Laya runtime is ${status}.`, details }
  }

  /** Release the ONNX session. */
  async dispose(): Promise<void> {
    await this.#runtime.close()
  }
}
