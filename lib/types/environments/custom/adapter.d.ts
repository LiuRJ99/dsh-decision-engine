/**
 * Custom Environment Adapter.
 *
 * The third environment class: games, internal business systems, device
 * control, simulators — anything that already exposes a structured state
 * interface. It is not a wrapper around a specific game. A game (or simulator,
 * or API) supplies four small callbacks and this adapter turns them into the
 * same protocol the browser and computer adapters speak.
 *
 * That is what makes the boundary real: a Snake adapter and a Tetris adapter
 * are *this* class with different callbacks, and neither of them knows which
 * decision model is answering.
 *
 * ```ts
 * const snake = new CustomEnvironmentAdapter({
 *   id: 'snake',
 *   observe: () => game.snapshot(),              // { score, health, availableActions, … }
 *   candidates: (state) => state.availableActions.map(action => ({ … })),
 *   execute: (action) => game.apply(action.candidateId),
 *   isDone: (state) => state.score > 0 && state.over,
 * })
 * ```
 *
 * @module dsh-decision-engine/environments/custom/adapter
 */
import type { DecisionRequest, DecisionResult } from '../../core/types.ts';
import type { EnvironmentAction, EnvironmentAdapter, ExecuteInput, Objective, ObserveInput, Observation } from '../types.ts';
/** One candidate a custom environment offers, plus the action it performs. */
export interface CustomCandidate<State = unknown> {
    id: string;
    description: string;
    metadata?: Record<string, unknown>;
    /** Environment-owned action payload. Passed back to `execute` verbatim. */
    action?: Record<string, unknown>;
    /** Whether executing this candidate is externally visible or hard to undo. */
    risky?: boolean;
    /** Whether the candidate should be offered for this state. Defaults to always. */
    available?(state: State): boolean;
}
/** Result of executing one custom action. */
export interface CustomExecutionResult {
    ok: boolean;
    message?: string;
    /** Environment state after the action, when the environment reports it cheaply. */
    state?: unknown;
    /** Whether the environment now considers the objective met. */
    done?: boolean;
}
/** The callbacks a custom environment supplies. */
export interface CustomEnvironmentSpec<State = unknown> {
    /** Stable environment id (`snake`, `tetris`, `line-controller`, …). */
    id: string;
    /**
     * Read the environment's current structured state. Returning `undefined`
     * means "no usable structured state right now", which becomes an
     * `insufficient` observation — the environment must not guess.
     */
    observe(input?: ObserveInput): Promise<State | undefined> | State | undefined;
    /**
     * The finite candidate set for a state. Either a static array or a function
     * of the state. Candidates whose `available(state)` is false are dropped.
     */
    candidates: CustomCandidate<State>[] | ((state: State) => CustomCandidate<State>[]);
    /** Execute the chosen candidate. */
    execute(candidate: CustomCandidate<State>, input?: ExecuteInput): Promise<CustomExecutionResult> | CustomExecutionResult;
    /** Whether the objective is already met. Optional. */
    isDone?(state: State, objective: Objective): Promise<boolean> | boolean;
    /** Objective text for the provider when the caller did not supply a specific one. */
    defaultObjective?: string;
    /** Optional human-readable one-line summary of a state. */
    summarize?(state: State): string;
    /** Optional state shaping before it reaches a provider. Defaults to the state itself. */
    projectState?(state: State): unknown;
    /** Release held resources. */
    dispose?(): Promise<void> | void;
}
/**
 * The custom adapter. Generic over the environment's own state type so the
 * callbacks stay typed on the environment side.
 */
export declare class CustomEnvironmentAdapter<State = unknown> implements EnvironmentAdapter {
    #private;
    readonly id: string;
    readonly source: "custom";
    readonly capabilities: readonly ["observe", "buildDecisionRequest", "mapDecision", "execute"];
    constructor(spec: CustomEnvironmentSpec<State>);
    /** Observe the environment. */
    observe(input?: ObserveInput): Promise<Observation>;
    /** Build the decision request from a custom state. */
    buildDecisionRequest(observation: Observation, objective: Objective): DecisionRequest;
    /** Map a chosen candidate id to a custom action. */
    mapDecision(result: DecisionResult, observation: Observation): EnvironmentAction;
    /** Execute a mapped custom action. */
    execute(action: EnvironmentAction, input?: ExecuteInput): Promise<CustomExecutionResult>;
    /** Whether the objective is met, when the environment can tell. */
    isDone(observation: Observation, objective: Objective): Promise<boolean> | boolean;
    /** The environment state seen by the last successful observation. */
    get lastState(): State | undefined;
    /**
     * Run one whole decision against this environment, serialized.
     *
     * `buildDecisionRequest` records the offered candidates on the instance and
     * `mapDecision`/`execute` read them back, so two overlapping calls on ONE
     * adapter leave the earlier request unmappable — a valid decision then fails
     * with `unknown_candidate`, which reads like a bug rather than a concurrency
     * artifact. This method holds the four protocol steps together **and runs them
     * one at a time per instance**, so a caller that shares an adapter (a server
     * handling concurrent requests, say) cannot interleave them.
     *
     * The queue is per adapter instance, so two adapters still run in parallel.
     * A caller that wants concurrency should construct one adapter per concurrent
     * environment; this makes the shared case correct rather than merely
     * documented.
     *
     * @param decide - the decision function called with the built request.
     * @param objective - the caller's goal.
     * @param input - optional cancellation and per-call budget.
     * @returns the observation, the request, the result, and the mapped action.
     * @throws DecisionError when the environment cannot express the task, or when
     *   the decision cannot be mapped — the same errors the individual steps throw.
     */
    decision(decide: (request: DecisionRequest) => Promise<DecisionResult>, objective: Objective, input?: ObserveInput): Promise<{
        observation: Observation;
        request: DecisionRequest;
        result: DecisionResult;
        action: EnvironmentAction;
    }>;
    dispose(): Promise<void>;
}
/**
 * Coerce an arbitrary structured state into something the decision protocol
 * accepts. Scalars and arrays are wrapped so a request always carries an
 * object or a string, never `undefined`.
 */
export declare function toDecisionState(value: unknown): string | Record<string, unknown>;
//# sourceMappingURL=adapter.d.ts.map