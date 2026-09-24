/**
 * Laya provider configuration.
 *
 * Every field here is Laya-private, and every one of them lives under
 * `providers.laya` in the plugin config — never as a top-level
 * `decisionEngine.layaModelPath`. That is what keeps a second model family
 * from having to fight the first one's schema.
 *
 * @module dsh-decision-engine/providers/laya/config
 */

import z from '@deepseek-ai/schemastery'

/** How a `classification` request is asked when the candidate set is binary. */
export type LayaBinaryMode = 'choice' | 'noul'

/** How `score`/`ranking` requests are asked. */
export type LayaScoringMode = 'per-candidate' | 'single-question'

/** Resolution for the ONNX execution provider. */
export type LayaExecutionProvider = 'cpu' | 'coreml' | 'cuda' | 'dml' | 'wasm'

/** Laya provider config, as read from `providers.laya`. */
export interface LayaConfig {
  /** Whether this provider is registered enabled. Defaults to true. */
  enabled?: boolean
  /**
   * Load the model when the plugin starts, instead of on the first decision.
   *
   * Defaults to **false**. One ONNX session pins the bundle's weights for as
   * long as it is open (≈1.6 GB for the Laya bundle), so a deployment that never
   * asks for a decision pays nothing. With `false` the first decision costs the
   * load (~5 s warm cache) and later ones ~100 ms; with `true` the cost moves to
   * startup.
   */
  autoLoad?: boolean
  /**
   * Release the model after this many milliseconds without a decision.
   * Defaults to 10 minutes; `0` keeps it resident for the process lifetime.
   *
   * This is the memory/ latency dial: a resident session answers in ~100 ms but
   * holds its weights; an idle-released one hands the memory back and pays the
   * load again on the next decision.
   */
  idleTtlMs?: number
  /**
   * Directory holding `laya.onnx`, `laya.onnx.data`, `laya_config.json`, and
   * `tokenizer/`. When unset, the SDK's own cache/download resolution runs.
   * Environment fallbacks are honored: `LAYA_MODEL_DIR`, then
   * `LAYA_CACHE`/`XDG_CACHE_HOME` with `LAYA_REVISION`/`LAYA_SUBFOLDER`.
   */
  modelDir?: string
  /** ONNX Runtime execution provider, or a comma-separated list. Defaults to `cpu`. */
  device?: string
  /** `intraOpNumThreads` override. `0` leaves the runtime default. */
  threads?: number
  /**
   * Whether an unavailable model is a hard failure. When false (default) the
   * provider reports `degraded`/`unavailable` from `healthCheck()` and fails
   * per call, so the rest of the decision layer keeps working.
   */
  required?: boolean
  /** Warn and normalize when the model answers something outside the candidate set. Defaults to true. */
  strictCandidates?: boolean
  /** How binary `classification` requests are asked. Defaults to `choice`. */
  classificationBinaryMode?: LayaBinaryMode
  /** How scoring requests are asked. Defaults to `per-candidate`. */
  scoringMode?: LayaScoringMode
  /** Levels used by the score question, lowest first. */
  scoreLevels?: string[]
  /** Instructions template for the score question. `{{count}}` is replaced with the candidate count. */
  scoreInstructions?: string
  /** Instructions template for the choice question. */
  choiceInstructions?: string
  /** Instructions template for the `noul` question used in binary classification. */
  noulInstructions?: string
  /** Per-call budget in milliseconds, forwarded to the engine's own timeout as a hint. */
  timeoutMs?: number
  /** Maximum characters of serialized state sent to the model. */
  maxStateChars?: number
  /** Extra cap on serialized candidate metadata, in characters. */
  maxCandidateMetadataChars?: number
}

/** Fully resolved Laya provider config. */
export interface ResolvedLayaConfig {
  autoLoad: boolean
  idleTtlMs: number
  modelDir: string | undefined
  executionProviders: string[]
  threads: number
  required: boolean
  strictCandidates: boolean
  classificationBinaryMode: LayaBinaryMode
  scoringMode: LayaScoringMode
  scoreLevels: string[]
  scoreInstructions: string
  choiceInstructions: string
  noulInstructions: string
  timeoutMs: number
  maxStateChars: number
  maxCandidateMetadataChars: number
}

/** Default score levels: an ordered 5-point scale, lowest first. */
export const DEFAULT_SCORE_LEVELS = [
  'a very poor choice',
  'a poor choice',
  'an acceptable choice',
  'a good choice',
  'a very good choice',
] as const

/** Keep a loaded Laya session warm for ten idle minutes by default. */
export const DEFAULT_LAYA_IDLE_TTL_MS = 10 * 60_000

/** Host settings schema for Laya's own configuration. */
export const LayaConfigSchema = z.object({
  enabled: z.boolean().default(true).description('Whether the Laya provider is registered. Turn off to run the layer without a model.'),
  modelDir: z.string().description(
    'Directory holding laya.onnx, laya.onnx.data, laya_config.json and tokenizer/. '
    + 'Setting it skips the SDK freshness check and its download entirely, which is required on a machine whose cache is not writable.',
  ),
  device: z.string().default('cpu').description('ONNX execution provider: cpu, coreml, cuda, dml or wasm — or a comma-separated list.'),
  threads: z.number().description('intraOpNumThreads override. 0 leaves the runtime default.'),
  autoLoad: z.boolean().default(false).description(
    'Load the model at startup instead of on the first decision. Off by default: a session pins the weights (about 1.6 GB) for as long as it is open.',
  ),
  idleTtlMs: z.number().default(DEFAULT_LAYA_IDLE_TTL_MS).description(
    'Release the model after this many milliseconds without a decision; defaults to ten minutes. 0 keeps it resident for the process lifetime.',
  ),
  required: z.boolean().default(false).description('Treat an unavailable model as a hard failure instead of reporting the provider as degraded.'),
  strictCandidates: z.boolean().default(true).description('Refuse a model answer that names an option which was not on the ballot.'),
  classificationBinaryMode: z.string().default('choice').description(
    'How a two-option classification is asked when the provider supports a binary head; '
    + 'see the provider documentation for the accepted values.',
  ),
  scoreLevels: z.array(z.string()).description('Rating scale for ranking and score modes, lowest first.'),
  scoringMode: z.string().default('per-candidate').description('Ratings strategy: "per-candidate" rates every option.'),
  timeoutMs: z.number().default(30_000).description('Per-call budget hint in milliseconds.'),
  maxStateChars: z.number().default(20_000).description('Maximum characters of serialized state sent to the model.'),
}).description('Laya: the first Decision Provider. Everything here is Laya-private.')

const DEFAULT_CHOICE_INSTRUCTIONS = [
  'You are choosing the single best next action for an agent.',
  'Objective: {{objective}}',
  'There are exactly {{count}} options, listed in criteria.',
  'Choose the one option that best advances the objective given the state.',
].join('\n')

const DEFAULT_SCORE_INSTRUCTIONS = [
  'Rate how good each option is as the next action for an agent.',
  'Objective: {{objective}}',
  'Score the option named in the question using the criteria scale.',
  'Higher is better.',
].join('\n')

const DEFAULT_NOUL_INSTRUCTIONS = [
  'Answer whether the first option should be chosen over the second.',
  'Objective: {{objective}}',
  'Question: is "{{first}}" the better next action than "{{second}}"?',
].join('\n')

/**
 * Resolve raw config (with optional environment fallbacks) into a fully
 * specified {@link ResolvedLayaConfig}.
 *
 * Environment variables are read here and nowhere else, so the provider's
 * behavior is reproducible from the resolved value alone.
 */
export function resolveLayaConfig(config: LayaConfig = {}, env: NodeJS.ProcessEnv = process.env): ResolvedLayaConfig {
  const modelDir = config.modelDir ?? env.LAYA_MODEL_DIR
  const device = config.device ?? env.LAYA_EP
  const threads = config.threads ?? numberFromEnv(env.LAYA_THREADS)
  const executionProviders = device === undefined || device.trim() === ''
    ? ['cpu']
    : device.split(',').map(part => part.trim()).filter(part => part !== '')
  return {
    autoLoad: config.autoLoad ?? false,
    idleTtlMs: Math.max(0, config.idleTtlMs ?? DEFAULT_LAYA_IDLE_TTL_MS),
    modelDir: modelDir === undefined || modelDir.trim() === '' ? undefined : modelDir,
    executionProviders,
    threads: threads ?? 0,
    required: config.required ?? false,
    strictCandidates: config.strictCandidates ?? true,
    classificationBinaryMode: config.classificationBinaryMode ?? 'choice',
    scoringMode: config.scoringMode ?? 'per-candidate',
    scoreLevels: config.scoreLevels !== undefined && config.scoreLevels.length >= 2 ? [...config.scoreLevels] : [...DEFAULT_SCORE_LEVELS],
    scoreInstructions: config.scoreInstructions ?? DEFAULT_SCORE_INSTRUCTIONS,
    choiceInstructions: config.choiceInstructions ?? DEFAULT_CHOICE_INSTRUCTIONS,
    noulInstructions: config.noulInstructions ?? DEFAULT_NOUL_INSTRUCTIONS,
    timeoutMs: config.timeoutMs ?? 30_000,
    maxStateChars: config.maxStateChars ?? 20_000,
    maxCandidateMetadataChars: config.maxCandidateMetadataChars ?? 500,
  }
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Fill `{{name}}` placeholders in an instruction template. */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = values[key]
    return value === undefined ? '' : String(value)
  })
}
