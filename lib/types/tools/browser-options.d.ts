import { BrowserEnvironmentAdapter, type BrowserAdapterConfig } from '../environments/browser/adapter.ts';
import type { DecisionEngineService } from '../service.ts';
export type BrowserTaskOptions = Pick<BrowserAdapterConfig, 'includeNonSemantic' | 'candidateSelector' | 'maxCandidates'>;
export declare const BROWSER_OPTIONS_PARAMETER: {
    type: "object";
    additionalProperties: boolean;
    description: string;
    properties: {
        includeNonSemantic: {
            type: "boolean";
            description: string;
        };
        candidateSelector: {
            type: "string";
            description: string;
        };
        maxCandidates: {
            type: "integer";
            description: string;
        };
    };
};
export declare function taskEnvironment(service: DecisionEngineService, id: string | undefined, browser: BrowserTaskOptions | undefined): string | BrowserEnvironmentAdapter;
//# sourceMappingURL=browser-options.d.ts.map