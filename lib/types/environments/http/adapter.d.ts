import type { DecisionCandidate, DecisionRequest, DecisionResult } from '../../core/types.ts';
import type { ActionResult, EnvironmentAction, EnvironmentAdapter, ExecuteInput, Objective, Observation, ObserveInput } from '../types.ts';
export declare const ENVIRONMENT_PROTOCOL: "dsh-environment/v1";
export interface EnvironmentSnapshot {
    protocol: typeof ENVIRONMENT_PROTOCOL;
    environmentId: string;
    episodeId: string;
    revision: string;
    state: string | Record<string, unknown>;
    candidates: Array<DecisionCandidate & {
        risky?: boolean;
    }>;
    done: boolean;
    /** Authoritative final outcome, for example { score: 120, outcome: 'won' }. */
    result?: Record<string, unknown>;
}
export interface EnvironmentActionRequest {
    protocol: typeof ENVIRONMENT_PROTOCOL;
    actionId: string;
    environmentId: string;
    episodeId: string;
    revision: string;
    candidateId: string;
}
export interface HttpEnvironmentOptions {
    /** Base URL exposing GET state and POST action. */
    endpoint: string;
    id?: string;
    headers?: Record<string, string>;
    /** For trusted embedders/tests; DSH uses the standard fetch transport. */
    fetch?: typeof globalThis.fetch;
}
export declare class HttpEnvironmentAdapter implements EnvironmentAdapter {
    #private;
    readonly id: string;
    readonly source: "custom";
    readonly capabilities: readonly ["observe", "execute", "terminal-result"];
    constructor(options: HttpEnvironmentOptions);
    observe(input?: ObserveInput): Promise<Observation>;
    buildDecisionRequest(observation: Observation, objective: Objective): DecisionRequest;
    mapDecision(decision: DecisionResult, observation: Observation): EnvironmentAction;
    execute(action: EnvironmentAction, input?: ExecuteInput): Promise<ActionResult>;
    isDone(observation: Observation): boolean;
}
//# sourceMappingURL=adapter.d.ts.map