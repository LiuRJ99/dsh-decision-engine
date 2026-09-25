/** Decision Engine page in the first-level Settings sidebar. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'

const NAMESPACE = 'decision-engine'
const PROVIDER_CATALOG_ROUTE = '/plugins/dsh-decision-engine/providers'

interface SettingsSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value?: unknown
  base?: unknown
  user?: unknown
  revision?: number
  writable: boolean
}
interface SettingsScope {
  getSnapshot(): SettingsSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly SettingsOp[], expectedRevision?: number): Promise<boolean>
}
interface SettingsOp {
  op: 'set' | 'unset'
  path: string[]
  value?: string
}
type Draft = { kind: 'set'; value: string } | { kind: 'unset' }
interface ClientContext {
  configForms: { get<T>(entryId: string): T }
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: object, component: unknown): () => void
  }
  effect(install: () => () => void, label: string): void
}
type Catalog = { status: 'idle' | 'loading' | 'ready' | 'error'; ids: string[] }

function field(object: unknown, key: string): unknown {
  return typeof object === 'object' && object !== null && Object.hasOwn(object, key)
    ? (object as Record<string, unknown>)[key] : undefined
}

/** Configured IDs keep the control usable while the live catalog is loading. */
function configuredIds(snapshot: SettingsSnapshot): string[] {
  const providers = field(snapshot.value, 'providers')
  if (typeof providers !== 'object' || providers === null) return []
  return Object.entries(providers).flatMap(([id, config]) =>
    typeof config === 'object' && config !== null && field(config, 'enabled') !== false ? [id] : [])
}

const STYLE = `
.dsh-de-card{border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:12px;background:var(--dsw-alias-bg-layer-3,#fff);overflow:hidden;color:inherit}
.dsh-de-head{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsh-de-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c78ff);outline-offset:-2px}.dsh-de-head-text{display:grid;gap:3px}
.dsh-de-title{font-size:15px;font-weight:600}.dsh-de-subtitle,.dsh-de-hint,.dsh-de-status{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#747b86)}
.dsh-de-chevron{font-size:14px;color:var(--dsw-alias-label-tertiary,#747b86)}.dsh-de-body{padding:16px;border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb)}
.dsh-de-field{display:grid;gap:7px}.dsh-de-label{font-size:13px;font-weight:500}.dsh-de-select{box-sizing:border-box;width:100%;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);color:inherit;font:inherit;font-size:13px;cursor:pointer}
.dsh-de-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4c78ff)}.dsh-de-select:disabled{opacity:.55;cursor:default}
.dsh-de-hint,.dsh-de-status{margin:0}.dsh-de-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb)}
.dsh-de-actions button{border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer}.dsh-de-actions button:disabled{opacity:.45;cursor:default}
.dsh-de-secondary{border:1px solid var(--dsw-alias-border-l2,#d9dde3);background:var(--dsw-alias-bg-layer-3,#fff);color:inherit}
.dsh-de-save{border:0;background:var(--dsw-alias-label-primary,#111827);color:var(--dsw-alias-bg-layer-3,#fff);font-weight:500}
.dsh-de-error{color:var(--dsw-alias-label-error,#c33)}
`

export function DecisionSettingsCard({ scope }: { scope: SettingsScope }) {
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const getSnapshot = useCallback(() => scope.getSnapshot(), [scope])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [open, setOpen] = useState(true)
  const [catalog, setCatalog] = useState<Catalog>({ status: 'idle', ids: [] })
  const [refresh, setRefresh] = useState(0)
  const [draft, setDraft] = useState<Draft | undefined>()
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const editRevision = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!open) return
    let active = true
    setCatalog(previous => ({ ...previous, status: 'loading' }))
    void fetch(PROVIDER_CATALOG_ROUTE, { headers: { accept: 'application/json' } })
      .then(async response => {
        if (!response.ok) throw new Error('provider catalog unavailable')
        const ids = field(await response.json() as unknown, 'providers')
        if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) throw new Error('invalid provider catalog')
        return ids as string[]
      })
      .then(ids => { if (active) setCatalog({ status: 'ready', ids }) })
      .catch(() => { if (active) setCatalog(previous => ({ ...previous, status: 'error' })) })
    return () => { active = false }
  }, [open, refresh])

  const saved = field(snapshot.value, 'defaultProvider')
  const base = field(snapshot.base, 'defaultProvider')
  const shown = draft?.kind === 'set' ? draft.value : draft?.kind === 'unset' ? base : saved
  const value = typeof shown === 'string' ? shown : ''
  const overridden = field(snapshot.user, 'defaultProvider') !== undefined
  const available = catalog.status === 'ready' ? catalog.ids : configuredIds(snapshot)
  const options = [...new Set([...available, ...(value ? [value] : [])])]

  const stage = (next: Draft): void => {
    if (draft === undefined) editRevision.current = snapshot.revision
    setDraft(next)
    setMessage('')
  }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (draft === undefined || saving || snapshot.status !== 'ready' || !snapshot.writable) return
    const selected = draft.kind === 'set' ? draft.value : ''
    const write: SettingsOp = selected === ''
      ? { op: 'unset', path: ['defaultProvider'] }
      : { op: 'set', path: ['defaultProvider'], value: selected }
    setSaving(true)
    setMessage('')
    try {
      if (!await scope.mutate([write], editRevision.current)) throw new Error('settings write was not accepted')
      const userValue = field(scope.getSnapshot().user, 'defaultProvider')
      if (write.op === 'set' ? userValue !== selected : userValue !== undefined) {
        throw new Error('settings write was not accepted')
      }
      setDraft(undefined)
      editRevision.current = undefined
      setMessage('已保存，后续决策立即生效。')
    } catch {
      setMessage('保存未生效。请刷新模型列表，或检查其他页面的修改。')
    } finally {
      setSaving(false)
    }
  }

  if (snapshot.status === 'unavailable') return null
  return <section className="dsh-de-card">
    <button type="button" className="dsh-de-head" aria-expanded={open} onClick={() => setOpen(previous => !previous)}>
      <span className="dsh-de-head-text">
        <span className="dsh-de-title">决策引擎</span>
        <span className="dsh-de-subtitle">默认决策模型{typeof saved === 'string' ? ` · ${saved}` : ''}</span>
      </span>
      <span className="dsh-de-chevron" aria-hidden="true">{open ? '⌃' : '⌄'}</span>
    </button>
    {open && <form className="dsh-de-body" onSubmit={event => { void save(event) }}>
      {snapshot.status === 'loading' && <p className="dsh-de-hint">正在读取设置…</p>}
      {snapshot.status === 'ready' && <>
        <div className="dsh-de-field">
          <label className="dsh-de-label" htmlFor="dsh-de-provider">默认决策模型</label>
          <select id="dsh-de-provider" className="dsh-de-select" value={value} disabled={!snapshot.writable || saving || options.length === 0}
            onChange={event => stage({ kind: 'set', value: event.target.value })}>
            {value === '' && <option value="">自动选择</option>}
            {options.map(id => <option key={id} value={id}>{id === 'laya' ? 'Laya · laya' : id}{!available.includes(id) ? '（不在可用列表）' : ''}</option>)}
          </select>
          <span className="dsh-de-hint">选择已注册的 Provider；单次任务仍可用 provider 参数指定其他模型。</span>
        </div>
        {catalog.status === 'loading' && <p className="dsh-de-hint">正在读取可用模型…</p>}
        {catalog.status === 'error' && <p className="dsh-de-hint">模型列表暂不可用，当前显示已配置项。</p>}
        {!snapshot.writable && <p className="dsh-de-hint">当前部署的设置为只读。</p>}
        {message && <p className={message.startsWith('保存未') ? 'dsh-de-status dsh-de-error' : 'dsh-de-status'} role="status">{message}</p>}
        <div className="dsh-de-actions">
          {catalog.status === 'error' && <button type="button" className="dsh-de-secondary" onClick={() => setRefresh(previous => previous + 1)}>刷新模型</button>}
          {overridden && <button type="button" className="dsh-de-secondary" disabled={!snapshot.writable || saving} onClick={() => stage({ kind: 'unset' })}>恢复默认</button>}
          {draft !== undefined && <button type="button" className="dsh-de-secondary" disabled={saving} onClick={() => { setDraft(undefined); editRevision.current = undefined; setMessage('') }}>放弃修改</button>}
          <button type="submit" className="dsh-de-save" disabled={draft === undefined || saving || !snapshot.writable}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </>}
    </form>}
  </section>
}

export const inject = ['slots', 'configForms']

export function apply(ctx: ClientContext): void {
  const scope = ctx.configForms.get<SettingsScope>(NAMESPACE)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = NAMESPACE
    style.textContent = STYLE
    document.head.appendChild(style)
    return () => style.remove()
  }, 'decision-engine settings styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NAMESPACE,
    order: 30,
    label: '决策引擎',
    inject: () => ({ scope }),
  }, DecisionSettingsCard))
}
