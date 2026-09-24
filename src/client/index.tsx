/** First-level Decision Engine settings section for the host-side namespace. */
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'

const NAMESPACE = 'decision-engine'

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
  mutate(ops: readonly SettingsOp[], expectedRevision?: number): Promise<void>
}
interface SettingsOp {
  op: 'set' | 'unset'
  path: string[]
  value?: string
}
type Draft = { kind: 'set'; value: string } | { kind: 'unset' }
interface ClientContext {
  settingsScope: { bind<T>(spec: { namespace: string }): T }
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: object, component: unknown): () => void
  }
  effect(install: () => () => void, label: string): void
}

function field(object: unknown, key: string): unknown {
  return typeof object === 'object' && object !== null && Object.hasOwn(object, key)
    ? (object as Record<string, unknown>)[key] : undefined
}

/** Suggestions come from configured providers; free text also accepts a provider added at runtime. */
function providerSuggestions(snapshot: SettingsSnapshot): string[] {
  const providers = field(snapshot.value, 'providers')
  if (typeof providers !== 'object' || providers === null) return []
  return Object.entries(providers).flatMap(([id, config]) =>
    typeof config === 'object' && config !== null && field(config, 'enabled') !== false ? [id] : [])
}

const STYLE = `
.dsh-de-page{display:grid;gap:18px;max-width:640px;color:inherit}
.dsh-de-title{font-size:18px;font-weight:600;margin:0}.dsh-de-intro,.dsh-de-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#747b86);line-height:1.5}
.dsh-de-intro{margin:5px 0 0}.dsh-de-card{border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#fff);padding:16px}
.dsh-de-label{display:block;font-size:13px;font-weight:600;margin-bottom:8px}.dsh-de-control{display:flex;gap:8px;align-items:center}
.dsh-de-control input{box-sizing:border-box;min-width:0;flex:1;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:7px;background:var(--dsw-alias-bg-layer-3,#fff);color:inherit;font:inherit;font-size:13px}
.dsh-de-hint{display:block;margin:8px 0 0}.dsh-de-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.dsh-de-actions button,.dsh-de-reset{border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:7px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:inherit;font:inherit;font-size:12px;cursor:pointer}
.dsh-de-actions button:disabled,.dsh-de-reset:disabled{opacity:.45;cursor:default}.dsh-de-error{color:var(--dsw-alias-label-error,#c33);font-size:12px;margin:10px 0 0}
`

export function DecisionSettingsSection({ scope }: { scope: SettingsScope }) {
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const getSnapshot = useCallback(() => scope.getSnapshot(), [scope])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const editRevision = useRef<number | undefined>(undefined)
  const saved = field(snapshot.value, 'defaultProvider')
  const base = field(snapshot.base, 'defaultProvider')
  const shown = draft?.kind === 'set' ? draft.value : draft?.kind === 'unset' ? base : saved
  const value = typeof shown === 'string' ? shown : ''
  const overridden = field(snapshot.user, 'defaultProvider') !== undefined

  const stage = (next: Draft) => {
    if (draft === undefined) editRevision.current = snapshot.revision
    setDraft(next)
    setError('')
  }
  const save = async () => {
    if (draft === undefined || saving || snapshot.status !== 'ready' || !snapshot.writable) return
    const selected = draft.kind === 'set' ? draft.value.trim() : ''
    const write: SettingsOp = selected === ''
      ? { op: 'unset', path: ['defaultProvider'] }
      : { op: 'set', path: ['defaultProvider'], value: selected }
    setSaving(true)
    setError('')
    try {
      await scope.mutate([write], editRevision.current)
      const userValue = field(scope.getSnapshot().user, 'defaultProvider')
      if (write.op === 'set' ? userValue !== selected : userValue !== undefined) {
        throw new Error('settings write was not accepted')
      }
      setDraft(undefined)
      editRevision.current = undefined
    } catch {
      setError('保存未生效。请检查 Provider ID，或刷新后重试。')
    } finally {
      setSaving(false)
    }
  }

  return <div className="dsh-de-page">
    <header>
      <h2 className="dsh-de-title">决策引擎</h2>
      <p className="dsh-de-intro">选择默认决策模型。单次任务也可以指定其他 Provider。</p>
    </header>
    {snapshot.status === 'unavailable' && <p className="dsh-de-hint">当前部署无法读取决策引擎设置。</p>}
    {snapshot.status === 'loading' && <p className="dsh-de-hint">正在读取设置…</p>}
    {snapshot.status === 'ready' && <div className="dsh-de-card">
      <label className="dsh-de-label" htmlFor="dsh-de-provider">默认决策模型（Provider ID）</label>
      <div className="dsh-de-control">
        <input id="dsh-de-provider" type="text" list="dsh-de-providers" value={value} disabled={!snapshot.writable || saving} onChange={event => stage({ kind: 'set', value: event.target.value })} />
        <datalist id="dsh-de-providers">{providerSuggestions(snapshot).map(id => <option value={id} key={id} />)}</datalist>
        {(overridden || draft !== undefined) && <button type="button" className="dsh-de-reset" disabled={!snapshot.writable || saving} onClick={() => stage({ kind: 'unset' })}>恢复默认</button>}
      </div>
      <p className="dsh-de-hint">候选 ID 来自已配置的 Provider；也可输入运行时已注册的 ID。切换默认值立即生效，单次调用的 provider 参数可以覆盖它。</p>
      {!snapshot.writable && <p className="dsh-de-hint">当前部署的设置为只读。</p>}
      {error && <p className="dsh-de-error" role="status">{error}</p>}
      {draft !== undefined && <div className="dsh-de-actions">
        <button type="button" disabled={saving} onClick={() => { setDraft(undefined); editRevision.current = undefined; setError('') }}>放弃修改</button>
        <button type="button" disabled={saving || !snapshot.writable} onClick={() => { void save() }}>{saving ? '保存中…' : '保存修改'}</button>
      </div>}
    </div>}
  </div>
}

export const inject = ['slots', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<SettingsScope>({ namespace: NAMESPACE })
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
    order: 16,
    label: '决策引擎',
    inject: () => ({ scope }),
  }, DecisionSettingsSection))
}
