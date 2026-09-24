/** Same-origin catalog for the decision model selector in Web settings. */
import type { IncomingMessage, ServerResponse } from 'node:http'

export const PROVIDER_CATALOG_ROUTE = '/plugins/dsh-decision-engine/providers'

export function serveProviderCatalog(
  req: IncomingMessage,
  res: ServerResponse,
  enabledIds: () => string[],
): void {
  const send = (status: number, body: unknown): void => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'GET') return send(405, { error: 'method-not-allowed' })
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin !== undefined && (host === undefined || (origin !== `http://${host}` && origin !== `https://${host}`))) {
    return send(403, { error: 'origin-rejected' })
  }
  send(200, { providers: enabledIds() })
}
