/**
 * Capability-gate awareness — read-only, never a second gate.
 *
 * The decision layer does not own browser or computer permission, does not
 * duplicate the gate, and cannot open it. What it does is *ask* the existing
 * session-lazy gate whether a capability is unlocked, so it can decline early
 * with an accurate message instead of dispatching a call that will be denied.
 *
 * The gate service is consumed opportunistically by its published service name
 * (`toolLazyGate`) and its narrow read-only query, through a structural type.
 * That keeps this plugin free of a compile-time dependency on the gate: when
 * no gate is mounted, `isCapabilityUnlocked()` returns `undefined` ("unknown"),
 * and every environment call is still governed by the registry's own guard.
 *
 * @module dsh-decision-engine/gate
 */
/** Skill names whose user invocation unlocks each capability in the shipped configuration. */
export declare const GATE_SKILL_NAMES: Record<'browser' | 'computer', string>;
/** The read-only slice of the lazy gate this plugin consumes. */
export interface ToolLazyGateSurface {
    /**
     * Whether the capability selected by `skillName` is unlocked for this agent's
     * session. Returns true when the session does not gate that skill at all.
     */
    isUnlocked(agent: unknown, skillName: string): boolean;
}
/** Whether a value looks like the gate's read-only surface. */
export declare function isToolLazyGateSurface(value: unknown): value is ToolLazyGateSurface;
/** The published service name of the session-lazy capability gate. */
export declare const TOOL_LAZY_GATE_SERVICE = "toolLazyGate";
/**
 * Ask the gate whether a capability is unlocked.
 *
 * @returns `true`/`false` when a gate answered, `undefined` when no gate is
 *   mounted or the query is not answerable — in which case callers must not
 *   treat the capability as blocked (the registry guard still decides).
 */
export declare function queryCapabilityUnlocked(gate: unknown, agent: unknown, capability: 'browser' | 'computer'): boolean | undefined;
//# sourceMappingURL=gate.d.ts.map