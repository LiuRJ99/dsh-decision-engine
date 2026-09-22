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
'provider_unknown'
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
 | 'internal';
/** Stable, serializable failure value. */
export interface DecisionFailure {
    code: DecisionErrorCode;
    message: string;
    /** Id of the provider or environment the failure concerns, when known. */
    subject?: string | undefined;
    /** Structured detail for tooling (latency, candidate ids, provider note, …). */
    details?: Record<string, unknown> | undefined;
}
/**
 * The one error type crossing the decision layer's boundaries. `code` is
 * always set, `message` is always human-readable, and `toJSON` yields the
 * serializable {@link DecisionFailure}.
 */
export declare class DecisionError extends Error {
    readonly code: DecisionErrorCode;
    readonly subject: string | undefined;
    readonly details: Record<string, unknown> | undefined;
    constructor(code: DecisionErrorCode, message: string, options?: {
        subject?: string | undefined;
        details?: Record<string, unknown> | undefined;
        cause?: unknown;
    });
    /** The serializable form. Never throws. */
    toJSON(): DecisionFailure;
}
/** Narrow any thrown value to a {@link DecisionFailure}. */
export declare function toDecisionFailure(error: unknown, fallback?: DecisionErrorCode): DecisionFailure;
/** Whether `error` is the given decision failure code. */
export declare function isDecisionErrorCode(error: unknown, code: DecisionErrorCode): boolean;
/**
 * The escalation contract: the single shape returned whenever the decision
 * layer refuses to continue and the main agent must take over.
 *
 * `status` is a literal so a consumer can discriminate on it, and `reason` is
 * one of the same codes a thrown {@link DecisionError} would carry.
 */
export interface EscalationResult {
    status: 'needs_escalation';
    reason: DecisionErrorCode;
    /** Environment that was being driven, when one was involved. */
    environment?: string;
    /** Provider that was asked, when one was asked. */
    provider?: string;
    /** The last successful decision, so the main agent does not re-derive it. */
    lastDecision?: {
        selected?: string;
        confidence?: number;
        /** What that confidence was, so a caller does not read a raw number as normalized. */
        confidenceKind?: string;
        step?: number;
    };
    /** What the caller should consider doing instead. */
    guidance: string;
    /** Machine-readable detail (failure details, step counts, …). */
    details?: Record<string, unknown>;
}
/** Build an escalation result from a failure. */
export declare function toEscalation(failure: DecisionFailure, context?: Omit<EscalationResult, 'status' | 'reason' | 'guidance' | 'details'> & {
    details?: Record<string, unknown>;
    guidance?: string;
}): EscalationResult;
//# sourceMappingURL=errors.d.ts.map