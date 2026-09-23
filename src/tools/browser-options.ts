import { DecisionError } from '../core/errors.ts'
import { BrowserEnvironmentAdapter, type BrowserAdapterConfig } from '../environments/browser/adapter.ts'
import type { DecisionEngineService } from '../service.ts'

export type BrowserTaskOptions = Pick<BrowserAdapterConfig, 'includeNonSemantic' | 'candidateSelector' | 'maxCandidates'>

export const BROWSER_OPTIONS_PARAMETER = {
  type: 'object' as const,
  additionalProperties: false,
  description: 'Task-local browser candidate settings. Requires a registered browser adapter; does not change global settings. Inspect the page before choosing a selector.',
  properties: {
    includeNonSemantic: { type: 'boolean' as const, description: 'Include inferred clickable div/span controls. Requires browser workspace v0.1.10+.' },
    candidateSelector: { type: 'string' as const, description: 'CSS selector filtering controls before size caps. Include the task controls and required navigation; an empty match never falls back to the whole page.' },
    maxCandidates: { type: 'integer' as const, description: 'Candidate cap, 1–64. Defaults to the registered adapter setting (12).' },
  },
}

export function taskEnvironment(service: DecisionEngineService, id: string | undefined, browser: BrowserTaskOptions | undefined): string | BrowserEnvironmentAdapter {
  if (browser === undefined) return id!
  if (id === undefined || browser === null || typeof browser !== 'object' || Array.isArray(browser)) throw new DecisionError('invalid_request', 'Browser settings require a browser environment and an options object.')
  const adapter = service.environments.require(id)
  if (!(adapter instanceof BrowserEnvironmentAdapter)) throw new DecisionError('invalid_request', 'Browser settings require a registered BrowserEnvironmentAdapter.')
  return adapter.withConfig(browser)
}
