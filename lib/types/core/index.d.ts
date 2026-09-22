/**
 * Core barrel: the model-agnostic decision protocol.
 *
 * Importing from here must never pull in a provider, an environment, or a
 * host package — the core is the part that survives deleting
 * `providers/laya/`.
 *
 * @module dsh-decision-engine/core
 */
export * from './types.ts';
export * from './errors.ts';
export * from './validate.ts';
export * from './provider-registry.ts';
export * from './router.ts';
export * from './decision-engine.ts';
export * from './telemetry.ts';
//# sourceMappingURL=index.d.ts.map