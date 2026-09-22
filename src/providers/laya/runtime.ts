/**
 * Laya runtime: the only file in this project that knows how the Laya SDK is
 * loaded and invoked.
 *
 * Responsibilities, all Laya-private:
 *
 * - load `@receptron/laya` lazily, so the plugin imports and starts without the
 *   dependency present (a missing model degrades the provider, it does not
 *   break the host);
 * - hold one ONNX session for the process;
 * - serialize calls, because one ONNX session runs one request at a time and
 *   concurrent calls would only inflate latency;
 * - record call statistics (calls, failures, latency, input tokens).
 *
 * The runtime exposes `systemOne(state, questions)` — Laya's own one-forward-pass
 * multiple-question call — and nothing above this file sees the SDK again.
 *
 * @module dsh-decision-engine/providers/laya/runtime
 */

import { DecisionError } from '../../core/errors.ts'
import { resolveLayaConfig, type LayaConfig, type ResolvedLayaConfig } from './config.ts'

/** Minimal structural view of the Laya SDK, so this file does not import it statically. */
export interface LayaQuestionShape {
  type: 'choice' | 'score' | 'noul'
  instructions: string
  criteria?: unknown
}

/** Minimal structural view of one Laya answer. */
export interface LayaAnswerShape {
  type: 'choice' | 'score' | 'noul'
  choice?: string
  score?: number
  noul?: number
  probabilities?: Record<string, number>
  confidence?: number
  legend?: Record<string, string>
}

/** Minimal structural view of a Laya systemOne result. */
export interface LayaSystemOneResult {
  model?: string
  answers: Record<string, LayaAnswerShape | undefined>
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** The Laya instance surface this runtime uses. */
export interface LayaInstance {
  readonly modelDir?: string
  readonly config?: { max_len?: number; head_max_len?: number }
  systemOne(state: unknown, questions: Record<string, LayaQuestionShape>): Promise<LayaSystemOneResult>
  close(): Promise<void>
}

/** The SDK module surface this runtime uses. */
export interface LayaModule {
  Laya: { load(options?: Record<string, unknown>): Promise<LayaInstance> }
}

/** Injectable SDK loader, so tests can drive the provider without ONNX. */
export type LayaModuleLoader = () => Promise<LayaModule>

/** Runtime status. */
export type LayaRuntimeStatus = 'idle' | 'loading' | 'ready' | 'offline' | 'failed' | 'closed'

/** Runtime call statistics. */
export interface LayaRuntimeStats {
  calls: number
  failures: number
  lastLatencyMs: number
  totalLatencyMs: number
  inputTokens: number
}

/** Default loader: the real SDK, imported at first use. */
export const defaultLayaModuleLoader: LayaModuleLoader = async () => {
  try {
    // Optional peer: deliberately not a declared dependency, so the plugin
    // loads (and reports `degraded`) on a machine without the model runtime.
    // @ts-expect-error -- the module is resolved from the profile at runtime.
    return (await import('@receptron/laya')) as unknown as LayaModule
  } catch (error) {
    const failure = new DecisionError('provider_unavailable', `The Laya SDK (@receptron/laya) is not installed or could not be imported: ${error instanceof Error ? error.message : String(error)}`, {
      subject: 'laya',
      details: { hint: 'Install @receptron/laya in the profile, or point providers.laya.modelDir at a local bundle.' },
      cause: error,
    })
    throw failure
  }
}

/** Options for {@link LayaRuntime}. */
export interface LayaRuntimeOptions {
  config?: LayaConfig
  /** Override the SDK loader (tests). */
  loadModule?: LayaModuleLoader
  /** Pre-built instance (tests): skips loading entirely. */
  instance?: LayaInstance
  /** Whether to start loading immediately. Defaults to true. */
  autoLoad?: boolean
}

/**
 * One Laya session, with a serial request queue.
 */
export class LayaRuntime {
  readonly #config: ResolvedLayaConfig
  readonly #loadModule: LayaModuleLoader
  #instance: LayaInstance | undefined
  #loadPromise: Promise<LayaInstance> | undefined
  #status: LayaRuntimeStatus = 'idle'
  #error: string | undefined
  #loadMs = 0
  #queue: Promise<unknown> = Promise.resolve()
  readonly #stats: LayaRuntimeStats = { calls: 0, failures: 0, lastLatencyMs: 0, totalLatencyMs: 0, inputTokens: 0 }

  constructor(options: LayaRuntimeOptions = {}) {
    this.#config = resolveLayaConfig(options.config)
    this.#loadModule = options.loadModule ?? defaultLayaModuleLoader
    if (options.instance !== undefined) {
      this.#instance = options.instance
      this.#status = 'ready'
      this.#loadPromise = Promise.resolve(options.instance)
    } else if (options.autoLoad === true) {
      void this.load().catch(() => undefined)
    }
  }

  /** The resolved, environment-applied configuration. */
  get config(): ResolvedLayaConfig {
    return this.#config
  }

  /** Current runtime status. */
  get status(): LayaRuntimeStatus {
    return this.#status
  }

  /** Last load or call error, when any. */
  get error(): string | undefined {
    return this.#error
  }

  /** Milliseconds the last successful load took. */
  get loadMs(): number {
    return this.#loadMs
  }

  /** A copy of the call statistics. */
  get stats(): LayaRuntimeStats {
    return { ...this.#stats }
  }

  /** The loaded instance, when ready. */
  get instance(): LayaInstance | undefined {
    return this.#instance
  }

  /**
   * Load the SDK and open the ONNX session. Idempotent and concurrent-safe: a
   * second caller awaits the first load.
   *
   * A missing module lands as `offline` (the SDK is not installed); any other
   * failure lands as `failed`. The distinction matters: `offline` is a
   * deployment choice, `failed` is a broken deployment.
   */
  async load(): Promise<LayaInstance> {
    if (this.#instance !== undefined && this.#status === 'ready') return this.#instance
    if (this.#loadPromise !== undefined && this.#status === 'loading') return this.#loadPromise
    this.#status = 'loading'
    this.#error = undefined
    const started = Date.now()
    const attempt = (async (): Promise<LayaInstance> => {
      try {
        const module = await this.#loadModule()
        const options: Record<string, unknown> = {}
        if (this.#config.modelDir !== undefined) options.modelDir = this.#config.modelDir
        if (this.#config.executionProviders.length > 0) options.executionProviders = this.#config.executionProviders
        if (this.#config.threads > 0) options.sessionOptions = { intraOpNumThreads: this.#config.threads }
        const instance = await module.Laya.load(options)
        this.#instance = instance
        this.#loadMs = Date.now() - started
        this.#status = 'ready'
        return instance
      } catch (error) {
        const decisionError = error instanceof DecisionError
          ? error
          : new DecisionError('provider_unavailable', `Laya failed to load: ${error instanceof Error ? error.message : String(error)}`, {
              subject: 'laya',
              details: { modelDir: this.#config.modelDir },
              cause: error,
            })
        this.#status = decisionError.code === 'provider_unavailable' && /not installed|not be imported/i.test(decisionError.message)
          ? 'offline'
          : 'failed'
        this.#error = decisionError.message
        this.#loadPromise = undefined
        throw decisionError
      }
    })()
    this.#loadPromise = attempt
    return attempt
  }

  /**
   * Ask the model every question about one state, in one forward pass.
   *
   * Calls are serialized: `engine.ask` chains onto the queue regardless of how
   * many callers arrive at once.
   *
   * @throws DecisionError with `provider_unavailable` when the model is not ready.
   */
  async systemOne(state: unknown, questions: Record<string, LayaQuestionShape>, signal?: AbortSignal): Promise<LayaSystemOneResult> {
    const run = async (): Promise<LayaSystemOneResult> => {
      const instance = this.#instance ?? await this.load()
      if (this.#status !== 'ready') {
        throw new DecisionError('provider_unavailable', `Laya is not ready (status=${this.#status}${this.#error === undefined ? '' : `: ${this.#error}`}).`, {
          subject: 'laya',
          details: { status: this.#status },
        })
      }
      if (signal?.aborted === true) {
        throw new DecisionError('aborted', 'The Laya call was aborted before it started.', { subject: 'laya' })
      }
      const started = Date.now()
      try {
        const result = await instance.systemOne(state, questions)
        this.#stats.calls += 1
        this.#stats.lastLatencyMs = Date.now() - started
        this.#stats.totalLatencyMs += this.#stats.lastLatencyMs
        this.#stats.inputTokens += result.usage?.input_tokens ?? 0
        return result
      } catch (error) {
        this.#stats.failures += 1
        if (error instanceof DecisionError) throw error
        throw new DecisionError('provider_failed', `Laya inference failed: ${error instanceof Error ? error.message : String(error)}`, {
          subject: 'laya',
          cause: error,
        })
      }
    }
    const next = this.#queue.then(run, run)
    this.#queue = next.then(() => undefined, () => undefined)
    return next
  }

  /** Release the ONNX session. */
  async close(): Promise<void> {
    const instance = this.#instance
    this.#instance = undefined
    this.#loadPromise = undefined
    this.#status = 'closed'
    if (instance !== undefined) {
      try {
        await instance.close()
      } catch {
        // Closing is best-effort; the process is usually exiting.
      }
    }
  }
}
