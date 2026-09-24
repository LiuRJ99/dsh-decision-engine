/**
 * Laya provider barrel. Everything in this directory is Laya-private; nothing
 * outside it imports the SDK, the ONNX runtime, or the `choice`/`score`/`noul`
 * question vocabulary.
 *
 * @module dsh-decision-engine/providers/laya
 */
import type { ProviderSpec } from '../../assembly.ts'
import type { LayaConfig } from './config.ts'
import { LayaDecisionProvider } from './provider.ts'

/** Convenience adapter for the generic provider assembly contract. */
export function createLayaProviderSpec(config: LayaConfig = {}): ProviderSpec {
  return { provider: new LayaDecisionProvider({ config }), config: { ...config } }
}

export { LayaDecisionProvider } from './provider.ts'
export { LayaRuntime, defaultLayaModuleLoader } from './runtime.ts'
export type { LayaInstance, LayaModule, LayaModuleLoader, LayaRuntimeOptions, LayaRuntimeStats, LayaRuntimeStatus, LayaAnswerShape, LayaQuestionShape, LayaSystemOneResult } from './runtime.ts'
export { resolveLayaConfig, fillTemplate, DEFAULT_SCORE_LEVELS, LayaConfigSchema } from './config.ts'
export type { LayaConfig, ResolvedLayaConfig, LayaBinaryMode, LayaScoringMode, LayaExecutionProvider } from './config.ts'
export { planQuestions, translateAnswers, toResult, QUESTION_KEYS } from './modes.ts'
export type { QuestionPlan, PlannedQuestion, TranslatedAnswer } from './modes.ts'
