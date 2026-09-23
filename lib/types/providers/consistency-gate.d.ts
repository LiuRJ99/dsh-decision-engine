/**
 * A composite provider whose fallback is gated on **order invariance**.
 *
 * ## The problem it solves
 *
 * A small decision model can answer by *position* instead of by *content*: ask it
 * the same question twice with the candidates listed in a different order and it
 * picks whatever sits in the same slot both times. Every downstream reading of
 * such an answer is wrong — including "which candidate won", and including any
 * confidence gate built on the model's own score, because that score is itself
 * ordered by position.
 *
 * This was measured, not assumed. Same game state, same four candidates, only the
 * order reversed: the winner flipped from `chase` to `straight`, every score stayed
 * sorted by slot, and the top-1 number moved from 0.551 to 0.295 — across a 0.3
 * floor, i.e. an absolute-threshold gate would have changed its verdict purely
 * because the list was reordered.
 *
 * ## The gate
 *
 * Ask the primary arm twice, the second time with the candidate list **rotated**.
 * Rotation moves *every* element, so any position-determined policy (first slot,
 * last slot, middle, …) necessarily answers differently the second time, while a
 * provider that reads the candidates answers the same id both times.
 *
 * - arms agree on the id → the answer is order-invariant → return it, naming the primary;
 * - arms disagree → the primary is not reading the candidates → answer from the fallback,
 *   naming the fallback.
 *
 * The gate needs no domain knowledge: it looks only at candidate ids, never at what
 * they mean, which is why it is a provider-layer concern and not an environment hack.
 *
 * ## Spec conformance
 *
 * - `capabilities` is the **intersection** of both arms: a request outside it could be
 *   refused by one of the arms mid-flight, so claiming more would be a lie.
 * - `confidence` / `confidenceKind` are passed through verbatim from whichever arm
 *   answered. The gate never synthesizes a number, and never relabels a raw scale as
 *   `normalized` — see `docs/外部接入规范.md` §1.3.
 * - The answering arm is named in `DecisionResult.provider` (§3.1b), which is the
 *   protocol's channel for exactly this: a caller can see whether the model answered
 *   or the fallback did.
 * - The extra probe is the only cost: two primary calls per decision instead of one.
 *
 * @module dsh-decision-engine/providers/consistency-gate
 */
import type { DecisionCapability, DecisionProvider, DecisionRequest, DecisionResult, ProviderHealth } from '../core/types.ts';
/** Gate bookkeeping, for tests and telemetry. */
export interface ConsistencyGateStats {
    /** Decisions where a second probe was actually run. */
    probes: number;
    /** Second probe returned the same candidate id (order-invariant). */
    agreements: number;
    /** Second probe returned a different candidate id (position-determined). */
    disagreements: number;
    /** Times the fallback arm supplied the answer. */
    fallbacks: number;
    /** Times the primary arm threw and the fallback was used to recover. */
    primaryFailures: number;
    /** Times the primary threw and the fallback threw too. */
    bothFailed: number;
}
/** Options for {@link ConsistencyGatedProvider}. */
export interface ConsistencyGateOptions {
    /** Registered id. Defaults to `<primary>-consistency-gated`; must be lowercase-kebab. */
    id?: string;
    /** The arm asked first. */
    primary: DecisionProvider;
    /** The arm asked when the gate rejects the primary's answer, or the primary throws. */
    fallback: DecisionProvider;
    /**
     * How far the second probe rotates the candidate list. Defaults to 1.
     *
     * The effective rotation is always non-zero modulo the candidate count, so a
     * rotation that would accidentally reproduce the original order is bumped to 1 —
     * otherwise the gate would compare an order against itself and always "agree".
     */
    rotation?: number;
}
/**
 * Composite provider: the primary arm answers unless its answer changes when the
 * candidates are reordered, in which case the fallback arm answers instead.
 */
export declare class ConsistencyGatedProvider implements DecisionProvider {
    #private;
    readonly id: string;
    readonly capabilities: readonly DecisionCapability[];
    constructor(options: ConsistencyGateOptions);
    decide(request: DecisionRequest, context?: Parameters<DecisionProvider['decide']>[1]): Promise<DecisionResult>;
    /** Snapshot of the gate's bookkeeping. */
    stats(): Readonly<ConsistencyGateStats>;
    /**
     * `unavailable` when an arm cannot serve at all, `degraded` when only the fallback
     * is usable — in that case every decision is answered by a non-primary arm, which
     * callers should see rather than discover.
     */
    healthCheck(): Promise<ProviderHealth>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=consistency-gate.d.ts.map