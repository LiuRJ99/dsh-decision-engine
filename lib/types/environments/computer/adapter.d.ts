/**
 * Computer Environment Adapter.
 *
 * The desktop is observed through its accessibility tree and acted on through
 * element indexes. Screenshots are never read: the computer-use engine returns
 * one alongside the tree, and this adapter ignores it — that is a deliberate
 * boundary, not an oversight.
 *
 * Two access paths are supported, and the choice between them is a deployment
 * decision rather than an architectural one:
 *
 * - `engine` — the in-process `ctx.computer` seam, when the computer-use plugin
 *   is mounted. Cheap, typed, and no tool round-trip.
 * - `tools` — the registered `computer_use_*` tools, when the adapter runs
 *   somewhere the seam is not reachable.
 *
 * Both paths are gated by the same session authorization as a model call, so
 * the adapter cannot reach a desktop the user has not unlocked.
 *
 * @module dsh-decision-engine/environments/computer/adapter
 */
import type { DecisionRequest, DecisionResult } from '../../core/types.ts';
import type { EnvironmentAction, EnvironmentAdapter, ExecuteInput, Objective, ObserveInput, Observation } from '../types.ts';
import { type ToolDispatcher } from '../dispatch.ts';
import { type AxCapture, type AxNode } from './ax-tree.ts';
/** Tool names of the computer-use family that this adapter dispatches. */
export declare const COMPUTER_TOOLS: {
    readonly listApps: "computer_use_list_apps";
    readonly getAppState: "computer_use_get_app_state";
    readonly click: "computer_use_click";
    readonly typeText: "computer_use_type_text";
    readonly pressKey: "computer_use_press_key";
    readonly scroll: "computer_use_scroll";
    readonly setValue: "computer_use_set_value";
    readonly selectText: "computer_use_select_text";
};
/**
 * The in-process computer seam this adapter prefers when it is mounted.
 *
 * Structurally typed on purpose: the decision layer declares the shape it
 * consumes instead of importing the computer-use package, so the two can be
 * versioned independently and neither becomes the other's compile-time
 * dependency. The shapes mirror the documented `ctx.computer` contract.
 */
export interface ComputerSeam {
    /**
     * Apply the implementation's own defaults and caps to a request.
     *
     * The documented `ctx.computer` contract requires it: every operation method
     * receives an already-resolved spec and never re-defaults its fields. It is
     * declared optional because a hand-built seam may not need it, and the
     * adapter passes the raw request when it is absent.
     */
    resolve?<T extends Record<string, unknown>>(request: T): unknown;
    listApps(request?: unknown): Promise<unknown>;
    getAppState(request: unknown): Promise<ComputerSeamState>;
    click(request: unknown): Promise<unknown>;
    typeText(request: unknown): Promise<unknown>;
    pressKey(request: unknown): Promise<unknown>;
    scroll(request: unknown): Promise<unknown>;
    setValue(request: unknown): Promise<unknown>;
    selectText?(request: unknown): Promise<unknown>;
}
/** The subset of a computer seam capture this adapter reads. */
export interface ComputerSeamState {
    app: string;
    text: string;
    truncated?: boolean;
    /** Present on the real seam; deliberately never read by this adapter. */
    screenshot?: unknown;
}
/** One candidate plus the desktop action it performs. */
export interface ComputerActionCandidate {
    id: string;
    description: string;
    action: {
        kind: 'click' | 'set_value' | 'press_key' | 'scroll' | 'type_text' | 'select_text';
        /** AX element index for element-addressed actions. */
        elementIndex?: number;
        /** Value for `set_value`. */
        value?: string;
        /** Key or chord for `press_key`. */
        key?: string;
        /** Direction for `scroll`. */
        direction?: 'up' | 'down' | 'left' | 'right';
        /** Literal text for `type_text`. */
        text?: string;
        /** Text to locate for `select_text`. */
        find?: string;
    };
    metadata?: Record<string, unknown>;
}
/** Adapter configuration. */
export interface ComputerAdapterConfig {
    /** App identifier (bundle id, display name, or path). Required to observe. */
    app?: string;
    /** When true, the observation carries the app list so a later step can choose a target. */
    listAppsInObservation?: boolean;
    /**
     * Fixed candidate set. Omit to derive candidates from the accessibility tree.
     * A fixed set is the "patch" strategy: the workflow decides what may happen.
     */
    candidates?: ComputerActionCandidate[];
    /** Hard cap on derived candidates. Defaults to 12. */
    maxCandidates?: number;
    /** Hard cap on characters of AX text placed into the decision state. Defaults to 8000. */
    maxStateChars?: number;
    /** `max` returns the full tree from the seam; a number caps it. Defaults to 1200 nodes. */
    maxTreeNodes?: number;
    /**
     * How long to wait for one accessibility capture before giving up. A capture
     * can block on a permission prompt or a wedged daemon, and a decision loop
     * must not wait forever for one observation. Defaults to 30 s.
     */
    captureTimeoutMs?: number;
}
/**
 * The computer adapter.
 */
export declare class ComputerEnvironmentAdapter implements EnvironmentAdapter {
    #private;
    readonly id: string;
    readonly source: "computer";
    readonly capabilities: readonly ["observe", "buildDecisionRequest", "mapDecision", "execute"];
    constructor(options: {
        id?: string;
        seam?: ComputerSeam;
        dispatcher?: ToolDispatcher;
        config?: ComputerAdapterConfig;
    });
    /** Whether the in-process seam is available. */
    get hasSeam(): boolean;
    /** The app this adapter targets, once configured. */
    get app(): string | undefined;
    /**
     * Capture the target app's accessibility tree.
     *
     * A missing app target, a refused capture, or an unreadable tree becomes a
     * non-`ok` observation: an AX tree that only contains anonymous groups
     * cannot express a task, and this adapter says so instead of guessing.
     */
    observe(input?: ObserveInput): Promise<Observation>;
    /** Apps the desktop exposes, for choosing a target. */
    listApps(): Promise<{
        ok: boolean;
        text: string;
    }>;
    /**
     * Build the decision request from an AX capture.
     *
     * The state is a structured digest: the app id, the capture kind (full vs
     * diff), and the nodes with their roles, names, and depths. The rendered
     * tree text is included only as a bounded, explicitly-untrusted transcript.
     */
    buildDecisionRequest(observation: Observation, objective: Objective): DecisionRequest;
    /** Map a chosen candidate id to a desktop action. */
    mapDecision(result: DecisionResult, observation: Observation): EnvironmentAction;
    /** Execute a mapped desktop action. */
    execute(action: EnvironmentAction, _input?: ExecuteInput): Promise<{
        ok: boolean;
        message?: string;
    }>;
    /** The tool names this adapter needs visible when it uses the tool path. */
    requiredTools(): string[];
}
/** Re-exported so a custom environment can reuse the same node vocabulary. */
export type { AxCapture, AxNode };
//# sourceMappingURL=adapter.d.ts.map