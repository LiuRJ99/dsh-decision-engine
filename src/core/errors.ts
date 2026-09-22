/**
 * The single error and escalation vocabulary of the decision layer.
 *
 * Every failure travels as a {@link DecisionError} carrying a stable
 * {@link DecisionErrorCode}. Ad-hoc `new Error('failed')` values are not part
 * of the contract: the runtime needs a machine-readable reason to decide
 * whether to retry, to escalate, or to stop, and the model-facing tool needs
 * the same reason to explain itself.
 *
 * @module dsh-decision-engine/core/errors
 */

/**
 * Every way the decision layer can refuse, fail, or hand control back.
 *
 * The escalation codes mirror the escalation contract: they are the reasons a
 * caller must leave the fast path and return to the main agent.
 */
export type DecisionErrorCode =
  /** The provider id is not registered. */
  | 'provider_unknown'
  /** The provider is registered but not usable right now. */
  | 'provider_unavailable'
  /** The provider does not implement the requested mode. */
  | 'provider_unsupported_capability'
  /** The provider returned a shape the protocol cannot accept. */
  | 'invalid_decision'
  /** The provider selected an id that was not in the candidate set. */
  | 'unknown_candidate'
  /** The provider's confidence is below the configured floor. */
  | 'low_confidence'
  /** The provider exceeded its budget. */
  | 'provider_timeout'
  /** The provider threw something that was not a DecisionError. */
  | 'provider_failed'
  /** The environment could not produce usable structured state. */
  | 'insufficient_observation'
  /** The environment cannot express this task at all (canvas-only, empty DOM, …). */
  | 'environment_unsupported'
  /** The environment id is not registered. */
  | 'environment_unknown'
  /** The environment's capability gate (browser/computer authorization) is closed. */
  | 'environment_unavailable'
  /** The request carried no candidates. */
  | 'no_candidates'
  /** The request itself is malformed (no state, duplicate ids, …). */
  | 'invalid_request'
  /** Turning the decision into a concrete environment action failed. */
  | 'action_mapping_failed'
  /** Executing the mapped action failed. */
  | 'action_execution_failed'
  /** The environment state did not change across steps. */
  | 'no_progress'
  /** The provider keeps returning the same decision. */
  | 'repeated_decision'
  /** The step or duration budget ran out. */
  | 'budget_exhausted'
  /** The caller aborted. */
  | 'aborted'
  /** The task needs vision, OCR, or screenshot understanding, which this layer does not do. */
  | 'needs_vision'
  /** The task needs planning beyond a finite candidate set. */
  | 'needs_planning'
  /** The action is high-risk and must be confirmed by the main agent. */
  | 'high_risk_action'
  /** Anything the layer could not classify; always carries a message. */
  | 'internal'

/** Stable, serializable failure value. */
export interface DecisionFailure {
  code: DecisionErrorCode
  message: string
  /** Id of the provider or environment the failure concerns, when known. */
  subject?: string | undefined
  /** Structured detail for tooling (latency, candidate ids, provider note, …). */
  details?: Record<string, unknown> | undefined
}

/**
 * The one error type crossing the decision layer's boundaries. `code` is
 * always set, `message` is always human-readable, and `toJSON` yields the
 * serializable {@link DecisionFailure}.
 */
export class DecisionError extends Error {
  readonly code: DecisionErrorCode
  readonly subject: string | undefined
  readonly details: Record<string, unknown> | undefined

  constructor(code: DecisionErrorCode, message: string, options?: { subject?: string | undefined; details?: Record<string, unknown> | undefined; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DecisionError'
    this.code = code
    this.subject = options?.subject
    this.details = options?.details
  }

  /** The serializable form. Never throws. */
  toJSON(): DecisionFailure {
    return {
      code: this.code,
      message: this.message,
      ...this.subject === undefined ? {} : { subject: this.subject },
      ...this.details === undefined ? {} : { details: this.details },
    }
  }
}

/** Narrow any thrown value to a {@link DecisionFailure}. */
export function toDecisionFailure(error: unknown, fallback: DecisionErrorCode = 'internal'): DecisionFailure {
  if (error instanceof DecisionError) return error.toJSON()
  if (error instanceof Error) {
    return {
      code: fallback,
      message: error.message,
      details: { name: error.name },
    }
  }
  return { code: fallback, message: String(error) }
}

/** Whether `error` is the given decision failure code. */
export function isDecisionErrorCode(error: unknown, code: DecisionErrorCode): boolean {
  return error instanceof DecisionError && error.code === code
}

/**
 * The escalation contract: the single shape returned whenever the decision
 * layer refuses to continue and the main agent must take over.
 *
 * `status` is a literal so a consumer can discriminate on it, and `reason` is
 * one of the same codes a thrown {@link DecisionError} would carry.
 */
export interface EscalationResult {
  status: 'needs_escalation'
  reason: DecisionErrorCode
  /** Environment that was being driven, when one was involved. */
  environment?: string
  /** Provider that was asked, when one was asked. */
  provider?: string
  /** The last successful decision, so the main agent does not re-derive it. */
  lastDecision?: {
    selected?: string
    confidence?: number
    step?: number
  }
  /** What the caller should consider doing instead. */
  guidance: string
  /** Machine-readable detail (failure details, step counts, …). */
  details?: Record<string, unknown>
}

/**
 * Default main-agent guidance per escalation code. Keeps the escalation
 * contract uniform without forcing every call site to write prose.
 */
const GUIDANCE: Record<DecisionErrorCode, string> = {
  provider_unknown: 'Register the provider or route to a provider that is enabled.',
  provider_unavailable: 'Fall back to another provider or handle the step with the main agent.',
  provider_unsupported_capability: 'Re-issue the request in a supported mode or route it to a capable provider.',
  invalid_decision: 'Treat the provider output as unusable and decide this step with the main agent.',
  unknown_candidate: 'Re-issue the decision with a candidate set that contains the returned id.',
  low_confidence: 'Ask the user or the main agent to decide this step; the model is not confident enough.',
  provider_timeout: 'Retry once with a larger budget, then hand the step to the main agent.',
  provider_failed: 'Inspect the provider error and fall back to the main agent for this step.',
  insufficient_observation: 'Use the main agent with a richer observation source; do not guess.',
  environment_unsupported: 'This environment cannot express structured state; use the main agent.',
  environment_unknown: 'Register the environment adapter before driving it.',
  environment_unavailable: 'Ask the user to authorize the capability (for example /browser) before proceeding.',
  no_candidates: 'Supply a finite candidate set before asking for a decision.',
  invalid_request: 'Fix the request and retry.',
  action_mapping_failed: 'Map the decision yourself and execute it with the main agent.',
  action_execution_failed: 'Inspect the environment error and retry or recover with the main agent.',
  no_progress: 'Stop looping: the environment is not changing. Re-plan with the main agent.',
  repeated_decision: 'Stop looping: the same action keeps being chosen. Re-plan with the main agent.',
  budget_exhausted: 'Stop looping and re-plan with the main agent; the step budget is spent.',
  aborted: 'The caller aborted; no further action was taken.',
  needs_vision: 'This layer is text-only; use the main agent with vision for this step.',
  needs_planning: 'The task needs planning beyond a finite candidate set; use the main agent.',
  high_risk_action: 'Confirm the action with the user before executing it.',
  internal: 'Inspect the failure detail and recover with the main agent.',
}

/** Build an escalation result from a failure. */
export function toEscalation(
  failure: DecisionFailure,
  context?: Omit<EscalationResult, 'status' | 'reason' | 'guidance' | 'details'> & {
    details?: Record<string, unknown>
    guidance?: string
  },
): EscalationResult {
  return {
    status: 'needs_escalation',
    reason: failure.code,
    guidance: context?.guidance ?? GUIDANCE[failure.code],
    ...context?.environment === undefined ? {} : { environment: context.environment },
    ...context?.provider === undefined ? {} : { provider: context.provider },
    ...context?.lastDecision === undefined ? {} : { lastDecision: context.lastDecision },
    details: { message: failure.message, ...failure.details, ...context?.details },
  }
}
