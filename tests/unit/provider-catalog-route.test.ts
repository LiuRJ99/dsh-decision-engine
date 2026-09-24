import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { serveProviderCatalog } from '../../src/provider-catalog-route.ts'

function request(method = 'GET', origin?: string): IncomingMessage {
  return { method, headers: { host: 'localhost:3000', ...origin === undefined ? {} : { origin } } } as IncomingMessage
}

function response(): { res: ServerResponse; result: () => { status: number; body: unknown } } {
  let status = 200
  let body = ''
  const res = {
    set statusCode(value: number) { status = value },
    setHeader() {},
    end(value: string) { body = value },
  } as unknown as ServerResponse
  return { res, result: () => ({ status, body: JSON.parse(body) as unknown }) }
}

describe('provider catalog route', () => {
  it('reads live enabled membership on every request', () => {
    const ids = ['laya']
    const first = response()
    serveProviderCatalog(request(), first.res, () => [...ids])
    assert.deepEqual(first.result(), { status: 200, body: { providers: ['laya'] } })
    ids.push('second-model')
    const second = response()
    serveProviderCatalog(request(), second.res, () => [...ids])
    assert.deepEqual(second.result(), { status: 200, body: { providers: ['laya', 'second-model'] } })
  })

  it('refuses cross-origin and non-GET requests', () => {
    const crossOrigin = response()
    serveProviderCatalog(request('GET', 'https://elsewhere.example'), crossOrigin.res, () => ['laya'])
    assert.equal(crossOrigin.result().status, 403)
    const post = response()
    serveProviderCatalog(request('POST'), post.res, () => ['laya'])
    assert.equal(post.result().status, 405)
  })
})
