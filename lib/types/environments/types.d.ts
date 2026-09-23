/**
 * The Environment Protocol: how anything that can be observed and acted upon
 * is reached without the decision layer knowing what it is.
 *
 * An adapter has four jobs and they are the four methods below — observe,
 * build a decision request from the observation, map a decision back to a
 * concrete action, execute it. The decision engine only ever sees a
 * {@link DecisionRequest}; the environment only ever sees an
 * {@link EnvironmentAction}.
 *
 * @module dsh-decision-engine/environments/types
 */
import type { DecisionRequest, DecisionResult } from '../core/types.ts';
/**
 * Which environment an observation came from. Open-ended on purpose: a custom
 * environment registers its own id, and the id is what routing and telemetry
 * carry.
 */
export type EnvironmentSource = 'browser' | 'computer' | 'custom' | (string & {});
/**
 * Observation status.
 *
 * `insufficient` is a first-class outcome, not an error path: an environment
 * that cannot produce usable structured state must say so, and the runtime
 * escalates. Guessing is never an option — that is the whole point of the
 * status.
 */
export type ObservationStatus = 
/** Usable structured state. */
'ok'
/** Structured state exists but cannot express the current task. */
 | 'insufficient'
/** The environment cannot express this kind of state at all (canvas-only page, empty DOM, …). */
 | 'unsupported'
/** The observation attempt itself failed. */
 | 'error';
/**
 * One observation of an environment.
 *
 * `state` is environment-owned structure; the browser adapter puts a
 * {@link BrowserState} there, the computer adapter a {@link ComputerState}, a
 * custom adapter whatever it likes. The engine treats it as opaque.
 */
export interface Observation {
    status: ObservationStatus;
    source: EnvironmentSource;
    /** Environment-owned structured state. Absent only when status is not `ok`. */
    state?: unknown;
    /** Environment-owned terminal marker, checked before asking a model. */
    done?: boolean;
    /** Final score/outcome, supplied by the environment rather than invented by a model. */
    result?: Record<string, unknown>;
    /** Machine-readable hint for why the observation is not `ok`. */
    reason?: string;
    /** Human/model-readable explanation of the state, when it helps. */
    summary?: string;
    /** Small diagnostic payload (counts, url, app, truncation flags). Never raw page/AX dumps. */
    metadata?: Record<string, unknown>;
}
/** The goal an environment is being driven toward. Owned by the caller (main agent), not by the engine. */
export interface Objective {
    /** What "done" means, in natural language. */
    description: string;
    /** Optional named success criteria the caller will verify against. */
    successCriteria?: string[];
    /** Hard constraints the environment must respect. */
    constraints?: string[];
    /** Optional machine-checkable completion rule over observation.state. */
    completion?: CompletionRule;
}
export interface CompletionRule {
    /** Dot-separated own-property path, for example "main" or "progress.finished". */
    path: string;
    /** Exactly one of equals/includes must be supplied. */
    equals?: string | number | boolean;
    includes?: string;
}
/** Build an `ok` observation. */
export declare function okObservation(source: EnvironmentSource, state: unknown, extra?: Omit<Observation, 'status' | 'source' | 'state'>): Observation;
/** Build a non-`ok` observation with a mandatory reason. */
export declare function failedObservation(source: EnvironmentSource, status: Exclude<ObservationStatus, 'ok'>, reason: string, extra?: Omit<Observation, 'status' | 'source' | 'reason'>): Observation;
/**
 * A concrete action an adapter knows how to execute.
 *
 * `kind` is environment-owned vocabulary (`click`, `key`, `type`, `scroll`, …)
 * and `target` is whatever addresses it in that environment (a snapshot index,
 * an AX element index, a game action name). The engine never inspects either:
 * decisions are candidate ids, and only the adapter that produced the request
 * knows what candidate ids mean in its environment.
 */
export interface EnvironmentAction {
    /** Environment-owned action kind. */
    kind: string;
    /** Environment-owned target, if the kind needs one. */
    target?: unknown;
    /** Environment-owned payload (text to type, direction to scroll, …). */
    payload?: Record<string, unknown>;
    /** The candidate id this action implements. */
    candidateId: string;
    /** What the action will do, for previews and logs. */
    description: string;
    /**
     * Whether executing this action is externally visible or hard to undo. The
     * runtime refuses to execute a risky action in an unpromoted execution mode;
     * the caller must confirm.
     */
    risky?: boolean;
}
/** Result of executing one action. */
export interface ActionResult {
    /** Whether the environment reports the action as applied. */
    ok: boolean;
    /** Environment message (error text, confirmation). */
    message?: string;
    /** Post-action environment state, when executors report it cheaply. */
    state?: unknown;
    /** Whether the environment now believes the objective is met, when it can tell. */
    done?: boolean;
    /** A complete post-action observation; avoids a redundant round trip. */
    observation?: Observation;
    result?: Record<string, unknown>;
}
/** What a decision produced, plus the action it maps to. */
export interface DecisionEnvelope {
    request: DecisionRequest;
    result: DecisionResult;
    /** The mapped action. Absent only when the caller asked for decision-only output. */
    action?: EnvironmentAction;
}
/**
 * Everything the decision layer needs from an environment.
 *
 * Implementations are responsible for their own capability gate: if the
 * underlying tool family is not authorized in this session, `observe()`
 * reports `unsupported`/`error` with the gate's own message rather than trying
 * to work around it. The decision layer neither owns nor duplicates that gate.
 */
export interface EnvironmentAdapter {
    /** Stable environment id, unique per registry (`browser`, `computer`, `snake`, …). */
    readonly id: string;
    /** Which source its observations are tagged with. */
    readonly source: EnvironmentSource;
    /** What the adapter can do at all, for diagnostics (`observe`, `execute`, …). */
    readonly capabilities?: readonly string[];
    /** Observe the environment. Never throws for a merely unusable environment — return a status. */
    observe(input?: ObserveInput): Promise<Observation>;
    /**
     * Turn an observation into a decision request: choose the objective text,
     * derive the finite candidate set, and shape the state the provider will see.
     */
    buildDecisionRequest(observation: Observation, objective: Objective): Promise<DecisionRequest> | DecisionRequest;
    /**
     * Turn a decision back into a concrete action for this environment.
     *
     * @throws DecisionError with `unknown_candidate` or `action_mapping_failed`.
     */
    mapDecision(result: DecisionResult, observation: Observation): Promise<EnvironmentAction> | EnvironmentAction;
    /** Execute a mapped action. */
    execute(action: EnvironmentAction, input?: ExecuteInput): Promise<ActionResult>;
    /** Whether the objective is already met. Environments that cannot tell omit this. */
    isDone?(observation: Observation, objective: Objective): Promise<boolean> | boolean;
    /**
     * A narrower view of this adapter with extra scope applied.
     *
     * The runtime calls it when a plan stage declares its own scope, so a stage
     * can restrict what the driver may do while it is active — only the answer
     * options while answering, only the navigation control while advancing.
     * Adapters without such a notion omit it; a stage scope is then ignored.
     */
    withConfig?(scope: Record<string, unknown>): EnvironmentAdapter;
    /**
     * The part of a state that counts as *progress*.
     *
     * The runtime fingerprints this to notice a stalled run. Adapters override it
     * to drop addressing that churns: element numbers are not state, so a page
     * that rebuilds its controls hands back new numbers for an unchanged
     * situation, and a whole-state fingerprint reports "changed" forever.
     */
    progressKey?(state: unknown): unknown;
    /** Release held resources. */
    dispose?(): Promise<void> | void;
}
/** Per-call input for {@link EnvironmentAdapter.observe}. */
export interface ObserveInput {
    /** Cancellation. */
    signal?: AbortSignal;
    /** Per-observation budget in milliseconds. */
    timeoutMs?: number;
    /** The objective, when the observation is shaped by what the caller wants. */
    objective?: Objective;
}
/** Per-call input for {@link EnvironmentAdapter.execute}. */
export interface ExecuteInput {
    /** Cancellation. */
    signal?: AbortSignal;
    /** Per-action budget in milliseconds. */
    timeoutMs?: number;
    /**
     * Whether risky actions may actually run. The runtime sets this only after
     * the caller promoted the execution mode; an adapter must refuse otherwise.
     */
    allowRisky?: boolean;
}
/** Re-exported so a custom environment author imports one protocol module, not two. */
export type { CustomCandidate, CustomEnvironmentSpec, CustomExecutionResult } from './custom/adapter.ts';
//# sourceMappingURL=types.d.ts.map