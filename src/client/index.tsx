/** Settings → Plugins → Plugin configuration card for the host-side namespace. */
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'

const NAMESPACE = 'decision-engine'

type FieldPath =
  | 'defaultProvider'
  | 'providers.laya.enabled'
  | 'providers.laya.modelDir'
  | 'providers.laya.autoLoad'
  | 'providers.laya.idleTtlMs'
  | 'runtime.maxSteps'
  | 'runtime.maxDurationMs'
  | 'runtime.observeTimeoutMs'
  | 'runtime.executeTimeoutMs'
  | 'runtime.noProgressLimit'
  | 'browser.enabled'
  | 'computer.enabled'

type FieldKind = 'text' | 'integer' | 'boolean'
interface FieldSpec {
  path: FieldPath
  label: string
  hint: string
  kind: FieldKind
  group: string
  restart?: boolean
  min?: number
}

const FIELDS: readonly FieldSpec[] = [
  { path: 'defaultProvider', label: '默认 Provider', hint: '填已注册的 Provider ID；当前内置的是 laya。', kind: 'text', group: '决策提供方' },
  { path: 'providers.laya.enabled', label: '启用 Laya', hint: '改变注册的 Provider 集合，重启后生效。', kind: 'boolean', group: '决策提供方', restart: true },
  { path: 'providers.laya.modelDir', label: 'Laya 模型目录', hint: '本机 bundle 目录；留空使用 SDK 的查找方式。重启后生效。', kind: 'text', group: '决策提供方', restart: true },
  { path: 'providers.laya.autoLoad', label: '启动时加载模型', hint: '关闭时首次决策才加载；改变加载策略需重启。', kind: 'boolean', group: '模型驻留', restart: true },
  { path: 'providers.laya.idleTtlMs', label: '空闲释放时间（毫秒）', hint: '0 表示进程存续期间常驻。重启后生效。', kind: 'integer', group: '模型驻留', restart: true, min: 0 },
  { path: 'runtime.maxSteps', label: '单次循环最多步骤', hint: '运行时预算；整任务可在调用参数中覆盖。', kind: 'integer', group: '执行预算', min: 1 },
  { path: 'runtime.maxDurationMs', label: '单次循环最长时间（毫秒）', hint: '运行时总时长预算；整任务可在调用参数中覆盖。', kind: 'integer', group: '执行预算', min: 1 },
  { path: 'runtime.observeTimeoutMs', label: '观察超时（毫秒）', hint: '也作为单次 Provider 决策的默认预算。', kind: 'integer', group: '执行预算', min: 1 },
  { path: 'runtime.executeTimeoutMs', label: '动作超时（毫秒）', hint: '一次环境动作允许的最长时间。', kind: 'integer', group: '执行预算', min: 1 },
  { path: 'runtime.noProgressLimit', label: '无进展停止次数', hint: '连续多少步状态不变时停止；0 关闭该检测。', kind: 'integer', group: '执行预算', min: 0 },
  { path: 'browser.enabled', label: '启用浏览器环境', hint: '控制环境适配器注册；重启后生效。', kind: 'boolean', group: '环境', restart: true },
  { path: 'computer.enabled', label: '启用电脑环境', hint: '控制环境适配器注册；重启后生效。', kind: 'boolean', group: '环境', restart: true },
]

const DEFAULTS: Record<FieldPath, string | number | boolean> = {
  defaultProvider: '',
  'providers.laya.enabled': true,
  'providers.laya.modelDir': '',
  'providers.laya.autoLoad': false,
  'providers.laya.idleTtlMs': 0,
  'runtime.maxSteps': 10,
  'runtime.maxDurationMs': 120_000,
  'runtime.observeTimeoutMs': 90_000,
  'runtime.executeTimeoutMs': 90_000,
  'runtime.noProgressLimit': 3,
  'browser.enabled': true,
  'computer.enabled': true,
}

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
  value?: string | number | boolean
}
interface ClientContext {
  settingsScope: { bind<T>(spec: { namespace: string }): T }
  slots: {
    inject(name: string, register: () => unknown): void
    register(options: object, component: unknown): () => void
  }
  effect(install: () => () => void, label: string): void
}
interface CardProps { scope: SettingsScope }
type Draft = { kind: 'set'; value: string | boolean } | { kind: 'unset' }

function part(object: unknown, path: readonly string[]): unknown {
  let value = object
  for (const key of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

function hasPart(object: unknown, path: readonly string[]): boolean {
  let value = object
  for (const key of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return false
    value = (value as Record<string, unknown>)[key]
  }
  return true
}

function fieldValue(snapshot: SettingsSnapshot, spec: FieldSpec, draft?: Draft): string | number | boolean {
  const path = spec.path.split('.')
  if (draft?.kind === 'set') return draft.value
  const layer = draft?.kind === 'unset' ? snapshot.base : snapshot.value
  const value = part(layer, path)
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value : DEFAULTS[spec.path]
}

function operation(spec: FieldSpec, draft: Draft): SettingsOp | undefined {
  const path = spec.path.split('.')
  if (draft.kind === 'unset') return { op: 'unset', path }
  if (spec.kind === 'boolean') return typeof draft.value === 'boolean' ? { op: 'set', path, value: draft.value } : undefined
  const text = String(draft.value).trim()
  if (spec.kind === 'text') {
    if (text === '') return { op: 'unset', path }
    return { op: 'set', path, value: text }
  }
  if (text === '') return undefined
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= (spec.min ?? 0)
    ? { op: 'set', path, value } : undefined
}

const STYLE = `
.dsh-de-card{list-style:none;border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:12px;background:var(--dsw-alias-bg-layer-3,#fff);overflow:hidden}
.dsh-de-head{width:100%;border:0;background:none;text-align:left;color:inherit;cursor:pointer;padding:14px 16px;font:inherit;display:flex;justify-content:space-between;gap:12px}
.dsh-de-title{display:block;font-size:15px;font-weight:600}.dsh-de-subtitle,.dsh-de-hint{display:block;font-size:12px;color:var(--dsw-alias-label-tertiary,#747b86);line-height:1.5}
.dsh-de-body{padding:0 16px 16px;border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb)}.dsh-de-group{margin:16px 0 0}.dsh-de-group h4{font-size:13px;margin:0 0 8px}
.dsh-de-field{display:grid;gap:5px;margin:10px 0}.dsh-de-label{font-size:13px;font-weight:500;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dsh-de-control{display:flex;align-items:center;gap:8px}.dsh-de-control input:not([type=checkbox]){box-sizing:border-box;min-width:0;flex:1;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:7px;background:var(--dsw-alias-bg-layer-3,#fff);color:inherit;font:inherit;font-size:13px}
.dsh-de-control input[type=checkbox]{width:17px;height:17px;accent-color:var(--dsw-alias-brand-primary,#4c78ff)}.dsh-de-tag{font-size:11px;color:var(--dsw-alias-label-secondary,#5a6470);border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:999px;padding:1px 6px}
.dsh-de-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:18px}.dsh-de-actions button,.dsh-de-reset{border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:7px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:inherit;font:inherit;font-size:12px;cursor:pointer}.dsh-de-actions button:disabled,.dsh-de-reset:disabled{opacity:.45;cursor:default}
.dsh-de-error{color:var(--dsw-alias-label-error,#c33);font-size:12px;margin:10px 0 0}.dsh-de-notice{font-size:12px;color:var(--dsw-alias-label-tertiary,#747b86);margin:14px 0 0}
`

export function DecisionSettingsCard({ scope }: CardProps) {
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const getSnapshot = useCallback(() => scope.getSnapshot(), [scope])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [open, setOpen] = useState(false)
  const [drafts, setDrafts] = useState<Partial<Record<FieldPath, Draft>>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const editRevision = useRef<number | undefined>(undefined)
  const dirty = Object.keys(drafts).length > 0
  const invalid = FIELDS.some(spec => {
    const draft = drafts[spec.path]
    return draft !== undefined && operation(spec, draft) === undefined
  })

  const stage = (path: FieldPath, draft: Draft) => {
    if (!dirty) editRevision.current = snapshot.revision
    setDrafts(previous => ({ ...previous, [path]: draft }))
    setError('')
  }

  const save = async () => {
    const ops = FIELDS.flatMap(spec => {
      const draft = drafts[spec.path]
      return draft === undefined ? [] : [operation(spec, draft)]
    })
    if (!dirty || saving || invalid || snapshot.status !== 'ready' || !snapshot.writable || ops.some(op => op === undefined)) return
    const writes = ops as SettingsOp[]
    setSaving(true)
    setError('')
    try {
      await scope.mutate(writes, editRevision.current)
      const user = scope.getSnapshot().user
      const landed = writes.every(write => write.op === 'unset'
        ? !hasPart(user, write.path)
        : hasPart(user, write.path) && part(user, write.path) === write.value)
      if (!landed) throw new Error('settings write was not accepted')
      setDrafts({})
      editRevision.current = undefined
      setOpen(false)
    } catch {
      setError('保存未生效。请检查输入，或刷新后处理其他页面的修改。')
    } finally {
      setSaving(false)
    }
  }

  if (snapshot.status === 'unavailable') return null
  return <li className="dsh-de-card">
    <button type="button" className="dsh-de-head" aria-expanded={open} aria-label="决策引擎设置" onClick={() => setOpen(!open)}>
      <span><span className="dsh-de-title">决策引擎</span><span className="dsh-de-subtitle">有限候选决策、多阶段执行与环境接入</span></span>
      <span aria-hidden="true">{dirty ? '未保存 · ' : ''}{open ? '⌃' : '⌄'}</span>
    </button>
    {open && <div className="dsh-de-body">
      {snapshot.status === 'loading' && <p className="dsh-de-notice">正在读取设置…</p>}
      {snapshot.status === 'ready' && <>
        {!snapshot.writable && <p className="dsh-de-notice">当前部署的设置为只读。</p>}
        {['决策提供方', '模型驻留', '执行预算', '环境'].map(group => <section key={group} className="dsh-de-group">
          <h4>{group}</h4>
          {FIELDS.filter(spec => spec.group === group).map(spec => {
            const current = drafts[spec.path]
            const value = fieldValue(snapshot, spec, current)
            const overridden = current?.kind === 'set' || (current === undefined && hasPart(snapshot.user, spec.path.split('.')))
            const id = `dsh-de-${spec.path.replaceAll('.', '-')}`
            return <div className="dsh-de-field" key={spec.path}>
              <label className="dsh-de-label" htmlFor={id}>{spec.label}
                {spec.restart && <span className="dsh-de-tag">重启后生效</span>}
                {overridden && <span className="dsh-de-tag">已覆盖</span>}
              </label>
              <div className="dsh-de-control">
                {spec.kind === 'boolean'
                  ? <input id={id} type="checkbox" checked={value === true} disabled={!snapshot.writable || saving} onChange={event => stage(spec.path, { kind: 'set', value: event.target.checked })} />
                  : <input id={id} type="text" inputMode={spec.kind === 'integer' ? 'numeric' : 'text'} value={String(value)} disabled={!snapshot.writable || saving} aria-invalid={current !== undefined && operation(spec, current) === undefined} onChange={event => stage(spec.path, { kind: 'set', value: event.target.value })} />}
                {(overridden || current !== undefined) && <button type="button" className="dsh-de-reset" disabled={!snapshot.writable || saving} onClick={() => stage(spec.path, { kind: 'unset' })}>恢复默认</button>}
              </div>
              <span className="dsh-de-hint">{spec.hint}</span>
            </div>
          })}
        </section>)}
        {error && <p className="dsh-de-error" role="status">{error}</p>}
        <div className="dsh-de-actions">
          <button type="button" disabled={!dirty || saving} onClick={() => { setDrafts({}); editRevision.current = undefined; setError('') }}>放弃修改</button>
          <button type="button" disabled={!dirty || invalid || saving || !snapshot.writable} onClick={() => { void save() }}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </>}
    </div>}
  </li>
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
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NAMESPACE,
    inject: () => ({ scope }),
  }, DecisionSettingsCard))
}
