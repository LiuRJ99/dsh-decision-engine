/**
 * Laya runtime: the only file in this project that knows how the Laya SDK is
 * loaded and invoked.
 *
 * Responsibilities, all Laya-private:
 *
 * - load `@receptron/laya` lazily, so the plugin imports and starts without the
 *   dependency present (a missing model degrades the provider, it does not
 *   break the host);
 * - hold one ONNX session for the process;
 * - serialize calls, because one ONNX session runs one request at a time and
 *   concurrent calls would only inflate latency;
 * - record call statistics (calls, failures, latency, input tokens).
 *
 * The runtime exposes `systemOne(state, questions)` — Laya's own one-forward-pass
 * multiple-question call — and nothing above this file sees the SDK again.
 *
 * @module dsh-decision-engine/providers/laya/runtime
 */
import { type LayaConfig, type ResolvedLayaConfig } from './config.ts';
/** Minimal structural view of the Laya SDK, so this file does not import it statically. */
export interface LayaQuestionShape {
    type: 'choice' | 'score' | 'noul';
    instructions: string;
    criteria?: unknown;
}
/** Minimal structural view of one Laya answer. */
export interface LayaAnswerShape {
    type: 'choice' | 'score' | 'noul';
    choice?: string;
    score?: number;
    noul?: number;
    probabilities?: Record<string, number>;
    confidence?: number;
    legend?: Record<string, string>;
}
/** Minimal structural view of a Laya systemOne result. */
export interface LayaSystemOneResult {
    model?: string;
    answers: Record<string, LayaAnswerShape | undefined>;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
    };
}
/** The Laya instance surface this runtime uses. */
export interface LayaInstance {
    readonly modelDir?: string;
    readonly config?: {
        max_len?: number;
        head_max_len?: number;
    };
    systemOne(state: unknown, questions: Record<string, LayaQuestionShape>): Promise<LayaSystemOneResult>;
    close(): Promise<void>;
}
/** The SDK module surface this runtime uses. */
export interface LayaModule {
    Laya: {
        load(options?: Record<string, unknown>): Promise<LayaInstance>;
    };
}
/** Injectable SDK loader, so tests can drive the provider without ONNX. */
export type LayaModuleLoader = () => Promise<LayaModule>;
/** Runtime status. */
export type LayaRuntimeStatus = 'idle' | 'loading' | 'ready' | 'offline' | 'failed' | 'closed';
/** Runtime call statistics. */
export interface LayaRuntimeStats {
    calls: number;
    failures: number;
    lastLatencyMs: number;
    totalLatencyMs: number;
    inputTokens: number;
}
/** Default loader: the real SDK, imported at first use. */
export declare const defaultLayaModuleLoader: LayaModuleLoader;
/** Options for {@link LayaRuntime}. */
export interface LayaRuntimeOptions {
    config?: LayaConfig;
    /** Override the SDK loader (tests). */
    loadModule?: LayaModuleLoader;
    /** Pre-built instance (tests): skips loading entirely. */
    instance?: LayaInstance;
    /** Whether to start loading immediately. Defaults to true. */
    autoLoad?: boolean;
}
/**
 * One Laya session, with a serial request queue.
 */
export declare class LayaRuntime {
    #private;
    constructor(options?: LayaRuntimeOptions);
    /** The resolved, environment-applied configuration. */
    get config(): ResolvedLayaConfig;
    /** Current runtime status. */
    get status(): LayaRuntimeStatus;
    /** Last load or call error, when any. */
    get error(): string | undefined;
    /** Milliseconds the last successful load took. */
    get loadMs(): number;
    /** A copy of the call statistics. */
    get stats(): LayaRuntimeStats;
    /** The loaded instance, when ready. */
    get instance(): LayaInstance | undefined;
    /**
     * Load the SDK and open the ONNX session. Idempotent and concurrent-safe: a
     * second caller awaits the first load.
     *
     * A missing module lands as `offline` (the SDK is not installed); any other
     * failure lands as `failed`. The distinction matters: `offline` is a
     * deployment choice, `failed` is a broken deployment.
     */
    load(): Promise<LayaInstance>;
    /**
     * Ask the model every question about one state, in one forward pass.
     *
     * Calls are serialized: `engine.ask` chains onto the queue regardless of how
     * many callers arrive at once.
     *
     * @throws DecisionError with `provider_unavailable` when the model is not ready.
     */
    systemOne(state: unknown, questions: Record<string, LayaQuestionShape>, signal?: AbortSignal): Promise<LayaSystemOneResult>;
    /** Release the ONNX session. */
    close(): Promise<void>;
}
//# sourceMappingURL=runtime.d.ts.map