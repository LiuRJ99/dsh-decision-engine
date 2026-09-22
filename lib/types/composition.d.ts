/**
 * The decision-engine composition root — host-free.
 *
 * Everything that can be assembled without a DSH process lives here: build one
 * engine, register the providers the config enables, build the environment
 * adapters, and construct the bounded runtime. `plugin.ts` adds the host
 * wiring on top (the tool dispatcher, the tool registration, the skill, and
 * `ctx.decisionEngine`).
 *
 * Two invariants this file owns:
 *
 * 1. The Laya provider is constructed here and nowhere else. Deleting
 *    `providers/laya/` breaks exactly this file's import and nothing in
 *    `core/`, `runtime/`, `environments/`, or `tools/`.
 * 2. Environments are built over an injected {@link ToolDispatcher}, never over
 *    a concrete transport. Whether that dispatcher is the host tool registry or
 *    a test map is the caller's decision, so the capability gate stays outside
 *    this layer.
 *
 * @module dsh-decision-engine/composition
 */
import z from '@deepseek-ai/schemastery';
import { DecisionEngine } from './core/decision-engine.ts';
import { DecisionProviderRegistry } from './core/provider-registry.ts';
import { type DecisionTelemetry } from './core/telemetry.ts';
import type { DecisionProvider } from './core/types.ts';
import { EnvironmentRegistry } from './environments/registry.ts';
import { type BrowserActionCandidate } from './environments/browser/adapter.ts';
import { type ComputerSeam } from './environments/computer/adapter.ts';
import type { ToolDispatcher } from './environments/dispatch.ts';
import { DecisionRuntime, type RuntimeConfigInput } from './runtime/runner.ts';
import type { DecisionEngineService } from './service.ts';
/**
 * Plugin configuration. Mirrors the documented shape:
 *
 * ```yaml
 * decisionEngine:
 *   enabled: true
 *   defaultProvider: laya
 *   providers:
 *     laya:
 *       enabled: true
 *       modelDir: /path/to/bundle
 *   runtime:
 *     confidenceThreshold: 0.55
 *     maxSteps: 10
 *   browser:
 *     enabled: true
 *   computer:
 *     enabled: true
 * ```
 *
 * Provider-private settings live under `providers.<id>` — `providers.laya` —
 * never as top-level keys, so a second provider cannot collide with the first.
 */
export interface Config {
    /** Whether the plugin wires anything at all. Defaults to true. */
    enabled?: boolean;
    /** Provider id used when a request does not name one. Defaults to the first enabled provider. */
    defaultProvider?: string;
    /** Per-provider settings, keyed by provider id. */
    providers?: Record<string, Record<string, unknown>>;
    /** Runtime budgets and stop conditions. */
    runtime?: RuntimeConfigInput;
    /** Browser environment settings. */
    browser?: BrowserEnvironmentConfig;
    /** Computer environment settings. */
    computer?: ComputerEnvironmentConfig;
    /** Number of telemetry records kept in memory. Defaults to 200. */
    telemetryLimit?: number;
}
/** Browser environment config, as read from `decisionEngine.browser`. */
export interface BrowserEnvironmentConfig {
    /** Whether the browser environment is registered. Defaults to true. */
    enabled?: boolean;
    /** Environment id to register it under. Defaults to `browser`. */
    environmentId?: string;
    /** Hard cap on derived candidates. */
    maxCandidates?: number;
    /** Hard cap on characters of page text placed into the decision state. */
    maxStateChars?: number;
    /**
     * Explicit candidate set. When present the adapter runs in `patch` strategy
     * and offers exactly these candidates instead of deriving them from the page.
     * Validated by the browser adapter at registration time.
     */
    candidates?: unknown[];
}
/** Computer environment config, as read from `decisionEngine.computer`. */
export interface ComputerEnvironmentConfig {
    /** Whether the computer environment is registered. Defaults to true. */
    enabled?: boolean;
    /** Environment id to register it under. Defaults to `computer`. */
    environmentId?: string;
    /** Target app identifier. Omit until an app is chosen. */
    app?: string;
    /** Hard cap on derived candidates. */
    maxCandidates?: number;
    /** Hard cap on characters of AX text placed into the decision state. */
    maxStateChars?: number;
    /** Maximum accessibility-tree nodes to capture. */
    maxTreeNodes?: number;
    /** How long to wait for one accessibility capture before giving up, in milliseconds. */
    captureTimeoutMs?: number;
}
/** One configurable candidate for the browser adapter's patch strategy. */
export type { BrowserActionCandidate };
/** Schemastery schema, so the loader validates and defaults the config. */
export declare const Config: z<Config>;
/**
 * Build the whole composition without touching Cordis.
 *
 * Exported so tests and embedders can assemble the layer with their own
 * dispatcher — and so the host-facing `plugin.ts` stays a thin adapter.
 */
export declare function createDecisionEngineComposition(options: {
    config?: Config;
    dispatcher: ToolDispatcher;
    /** In-process computer seam, when the computer-use plugin is mounted. */
    computerSeam?: ComputerSeam;
    /** Read-only capability-gate query. */
    readCapabilityGate?: (capability: 'browser' | 'computer') => boolean | undefined;
    /** Extra providers to register after the built-in ones. */
    extraProviders?: Array<{
        provider: DecisionProvider;
        enabled?: boolean;
        config?: Record<string, unknown>;
    }>;
}): DecisionEngineComposition;
/** The full composition, so callers and tests can reach every part directly. */
export interface DecisionEngineComposition {
    service: DecisionEngineService;
    engine: DecisionEngine;
    providers: DecisionProviderRegistry;
    environments: EnvironmentRegistry;
    runtime: DecisionRuntime;
    telemetryRecords: DecisionTelemetry[];
    dispose(): Promise<void>;
}
//# sourceMappingURL=composition.d.ts.map