/**
 * dsh-decision-engine — a model-agnostic low-latency decision layer for DSH.
 *
 * Public surface, in one place:
 *
 * - `./composition.ts` — build the layer with your own dispatcher (no host needed);
 * - `./plugin.ts` — the Cordis entry that wires it into a DSH profile;
 * - `./core` — the decision protocol;
 * - `./runtime` — the bounded runner;
 * - `./environments/*` — the environment adapters;
 * - `./providers/laya` — the first decision provider.
 *
 * The import direction is one-way: core → runtime → environments → tools, and
 * providers hang off the side. Deleting `src/providers/laya/` leaves all of it
 * compiling, and the architecture tests in `tests/unit/architecture.test.ts`
 * enforce that.
 *
 * @module dsh-decision-engine
 */
export * from './composition.ts';
export * from './core/types.ts';
export * from './core/errors.ts';
export * from './core/telemetry.ts';
export * from './environments/types.ts';
export * from './runtime/runner.ts';
export * from './service.ts';
export type { Config as DecisionEnginePluginConfig } from './composition.ts';
//# sourceMappingURL=index.d.ts.map