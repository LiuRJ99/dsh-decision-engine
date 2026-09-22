/**
 * Request validation and result normalization — the guard rails that keep an
 * untrusted or buggy provider from leaking into the environment layer.
 *
 * Two rules justify this module's existence:
 *
 * 1. A decision may only ever name an id the caller supplied. A provider that
 *    invents an action fails the call rather than reaching an action mapper.
 * 2. A result the protocol cannot express is a failure, not something to
 *    repair silently.
 *
 * @module dsh-decision-engine/core/validate
 */
import { type DecisionCandidate, type DecisionMode, type DecisionRankEntry, type DecisionRequest, type DecisionResult } from './types.ts';
/** A request that passed validation, with the mode and candidate index resolved. */
export interface ValidatedRequest {
    request: DecisionRequest;
    /** Mode to run: the request's, or `choice` when omitted. */
    mode: DecisionMode;
    /** Candidate id → candidate, for O(1) membership checks. */
    byId: Map<string, DecisionCandidate>;
}
/** Longest candidate list accepted in one request. Keeps the finite-candidate promise real. */
export declare const MAX_CANDIDATES = 64;
/** Longest state payload accepted, in characters, so one call cannot flood a model context. */
export declare const MAX_STATE_CHARS = 200000;
/** Longest objective accepted, in characters. */
export declare const MAX_OBJECTIVE_CHARS = 8000;
/**
 * Validate a caller-supplied request.
 *
 * @param request - the raw request.
 * @returns the validated request plus resolved mode and candidate index.
 * @throws DecisionError with `invalid_request` or `no_candidates`.
 */
export declare function validateRequest(request: DecisionRequest): ValidatedRequest;
/**
 * Normalize a provider's raw answer into a protocol {@link DecisionResult}.
 *
 * The provider may return a partial result — typically only `selected` or only
 * `ranking`. This function:
 * - rejects a `selected` id outside the candidate set (`unknown_candidate`),
 * - drops ranking entries outside it rather than failing the whole call,
 * - derives `selected` from the ranking when the provider omitted it,
 * - derives `ranking` from `selected` when the ranking is empty,
 * - keeps `confidence` only when it is a finite 0..1 number.
 *
 * @param raw - the provider's answer, before protocol enforcement.
 * @param options - validated request facts the provider answered.
 * @returns the normalized result.
 * @throws DecisionError with `invalid_decision` or `unknown_candidate`.
 */
export declare function normalizeDecisionResult(raw: unknown, options: {
    providerId: string;
    mode: DecisionMode;
    validated: ValidatedRequest;
    latencyMs: number;
    /** Whether the caller asked for provider-private debug detail. */
    includeDebug?: boolean;
}): DecisionResult;
/**
 * Sort candidate ids by descending score. Used by providers that score every
 * candidate and by the `score`/`ranking` modes.
 *
 * @param entries - id/score pairs, scores optional.
 * @returns a new array, best first, ties in the input's order.
 */
export declare function rankByScore(entries: readonly {
    id: string;
    score?: number;
}[]): DecisionRankEntry[];
//# sourceMappingURL=validate.d.ts.map