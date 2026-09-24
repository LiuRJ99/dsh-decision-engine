/** Same-origin catalog for the decision model selector in Web settings. */
import type { IncomingMessage, ServerResponse } from 'node:http';
export declare const PROVIDER_CATALOG_ROUTE = "/plugins/dsh-decision-engine/providers";
export declare function serveProviderCatalog(req: IncomingMessage, res: ServerResponse, enabledIds: () => string[]): void;
//# sourceMappingURL=provider-catalog-route.d.ts.map