/**
 * Browser Environment Adapter.
 *
 * Responsibilities, in order: observe the page through the browser tool set,
 * build a finite decision request from that structured state, map the chosen
 * candidate id to a concrete browser action, and execute it.
 *
 * Two boundaries this adapter keeps:
 *
 * - It is text-only. It reads the bridge's structured snapshot; it never asks
 *   for a screenshot and never interprets pixels.
 * - It never maps a decision to a raw tool call itself. That is: the provider
 *   returns `submit`, and *this* adapter decides that `submit` means
 *   `browser_click(index=17)`. The provider has no idea a tool named
 *   `browser_click` exists.
 *
 * Authorization is deliberately absent from this file. Observation and
 * execution both go through {@link ToolDispatcher}, which dispatches the
 * host's registered tools, so the session's capability gate decides whether
 * the browser capability is reachable — and a refusal comes back as an
 * observation status or an escalation, never as a workaround.
 *
 * @module dsh-decision-engine/environments/browser/adapter
 */
import type { DecisionRankEntry, DecisionRequest, DecisionResult } from '../../core/types.ts';
import type { EnvironmentAction, EnvironmentAdapter, ExecuteInput, Objective, ObserveInput, Observation } from '../types.ts';
import { type ToolDispatcher } from '../dispatch.ts';
/** Tool names this adapter dispatches. They are the bridge's public tool surface. */
export declare const BROWSER_TOOLS: {
    readonly snapshot: "browser_snapshot";
    readonly getText: "browser_get_text";
    readonly click: "browser_click";
    readonly type: "browser_type";
    readonly press: "browser_press";
    readonly scroll: "browser_scroll";
    readonly navigate: "browser_navigate";
    readonly wait: "browser_wait";
};
/**
 * How the adapter turns a page into candidates.
 *
 * `form` — the page's own buttons, links, and fields answer the objective.
 * `patch` — the caller supplies the candidate set (a workflow's own steps).
 */
export type BrowserCandidateStrategy = 'form' | 'patch';
/** Adapter configuration. */
export interface BrowserAdapterConfig {
    /** Candidate derivation strategy. Defaults to `form`. */
    strategy?: BrowserCandidateStrategy;
    /**
     * Candidates supplied by the caller when `strategy` is `patch`. Each entry
     * carries a `target` describing the browser action it performs.
     */
    candidates?: BrowserActionCandidate[];
    /** Hard cap on derived candidates. Defaults to 12. */
    maxCandidates?: number;
    /** Opt in to the bridge's inferred `clickable` inventory. Defaults to false. */
    includeNonSemantic?: boolean;
    /** Filter controls by CSS selector in the extension, before inventory caps. */
    candidateSelector?: string;
    /** Hard cap on characters of page text placed into the decision state. Defaults to 6000. */
    maxStateChars?: number;
    /** Hard cap on characters of the objective. Defaults to 2000. */
    maxObjectiveChars?: number;
    /** Per-call budgets forwarded to the tool dispatch. */
    observeTimeoutMs?: number;
    executeTimeoutMs?: number;
}
/**
 * A candidate plus the browser action it performs.
 *
 * This is the adapter's own vocabulary: a candidate id is what the decision
 * provider sees; `action` is what the adapter does with it. Keeping the two in
 * one record is what makes the mapping total — every offered candidate is
 * executable, so a provider can never choose something unmappable.
 */
export interface BrowserActionCandidate {
    id: string;
    description: string;
    action: {
        kind: 'click' | 'type' | 'press' | 'scroll' | 'navigate' | 'wait';
        /** Snapshot index for click/type, or the key for press, or the direction for scroll, or the url for navigate. */
        target?: number | string;
        /** Text for `type`, milliseconds for `wait`. */
        text?: string;
        /** Whether `type` replaces rather than appends. */
        replace?: boolean;
        /** Whether the action is externally visible or hard to undo. */
        risky?: boolean;
    };
    metadata?: Record<string, unknown>;
}
/**
 * The browser adapter. One instance drives one controlled tab.
 */
export declare class BrowserEnvironmentAdapter implements EnvironmentAdapter {
    #private;
    readonly id: string;
    readonly source: "browser";
    readonly capabilities: readonly ["observe", "buildDecisionRequest", "mapDecision", "execute"];
    constructor(options: {
        id?: string;
        dispatcher: ToolDispatcher;
        config?: BrowserAdapterConfig;
    });
    /** Task-local configuration; never mutates the registered adapter. */
    withConfig(config: Pick<BrowserAdapterConfig, 'includeNonSemantic' | 'candidateSelector' | 'maxCandidates'>): BrowserEnvironmentAdapter;
    /**
     * Read the page as structured text.
     *
     * A refused or failed snapshot becomes `unsupported`/`error`, never a guess:
     * the caller escalates instead of the adapter inventing state.
     */
    observe(input?: ObserveInput): Promise<Observation>;
    /**
     * Build the decision request from a browser snapshot.
     *
     * The state handed to the provider is a *structured digest* — url, title, the
     * interactive inventory, the form inventory, and a bounded slice of page
     * text — so a provider reads structure rather than re-parsing prose. Page
     * text is treated as untrusted data and is explicitly labelled as such.
     */
    buildDecisionRequest(observation: Observation, objective: Objective): DecisionRequest;
    /**
     * Map a chosen candidate id to a browser action.
     *
     * @throws DecisionError with `unknown_candidate` when the id is not one this
     *   adapter offered for the observation the request was built from.
     */
    mapDecision(result: DecisionResult, observation: Observation): EnvironmentAction;
    /** Execute a mapped action through the browser tool set. */
    execute(action: EnvironmentAction, input?: ExecuteInput): Promise<{
        ok: boolean;
        message: string;
    }>;
    /** The tool names this adapter needs visible in the session. */
    requiredTools(): string[];
    /** Assert the dispatcher is present, with a typed error. */
    assertWired(): void;
}
/** Rank entries helper used by adapters that need to keep the provider's order. */
export declare function selectionOrder(ranking: DecisionRankEntry[] | undefined, selected: string): string[];
//# sourceMappingURL=adapter.d.ts.map