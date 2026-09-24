/** First-level Decision Engine settings section for the host-side namespace. */
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

type FieldKind = 'text' | 'integer' | 'boolean'
interface FieldSpec {
  path: FieldPath
  label: string
  hint: string
  kind: FieldKind
  group: 'provider' | 'residency' | 'budget'
  restart?: boolean
  min?: number
}

const FIELDS: readonly FieldSpec[] = [
  { path: 'defaultProvider', label: '默认 Provider', hint: '填已注册的 Provider ID；当前内置的是 laya。', kind: 'text', group: 'provider' },
  { path: 'providers.laya.enabled', label: '启用 Laya', hint: '改变注册的 Provider 集合，重启后生效。', kind: 'boolean', group: 'provider', restart: true },
  { path: 'providers.laya.modelDir', label: 'Laya 模型目录', hint: '本机 bundle 目录；留空使用 SDK 的查找方式。重启后生效。', kind: 'text', group: 'provider', restart: true },
  { path: 'providers.laya.autoLoad', label: '启动时加载模型', hint: '关闭时首次决策才加载；改变加载策略需重启。', kind: 'boolean', group: 'residency', restart: true },
  { path: 'providers.laya.idleTtlMs', label: '空闲释放时间（毫秒）', hint: '0 表示进程存续期间常驻。重启后生效。', kind: 'integer', group: 'residency', restart: true, min: 0 },
  { path: 'runtime.maxSteps', label: '单次循环最多步骤', hint: '运行时预算；整任务可在调用参数中覆盖。', kind: 'integer', group: 'budget', min: 1 },
  { path: 'runtime.maxDurationMs', label: '单次循环最长时间（毫秒）', hint: '运行时总时长预算；整任务可在调用参数中覆盖。', kind: 'integer', group: 'budget', min: 1 },
  { path: 'runtime.observeTimeoutMs', label: '观察超时（毫秒）', hint: '也作为单次 Provider 决策的默认预算。', kind: 'integer', group: 'budget', min: 1 },
  { path: 'runtime.executeTimeoutMs', label: '动作超时（毫秒）', hint: '一次环境动作允许的最长时间。', kind: 'integer', group: 'budget', min: 1 },
  { path: 'runtime.noProgressLimit', label: '无进展停止次数', hint: '连续多少步状态不变时停止；0 关闭该检测。', kind: 'integer', group: 'budget', min: 0 },
]

const GROUPS = [
  { id: 'provider', title: '模型与 Provider', subtitle: '默认 Provider、Laya 和模型目录' },
  { id: 'residency', title: '模型驻留', subtitle: '加载时机与空闲释放' },
  { id: 'budget', title: '执行预算', subtitle: '步骤、耗时与停止条件' },
] as const

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
interface SectionProps { scope: SettingsScope }
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
.dsh-de-page{display:grid;gap:14px;max-width:720px;color:inherit}
.dsh-de-title{font-size:18px;font-weight:600;margin:0}.dsh-de-intro,.dsh-de-subtitle,.dsh-de-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#747b86);line-height:1.5}
.dsh-de-intro{margin:5px 0 0}.dsh-de-group{border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#fff);overflow:hidden}
.dsh-de-group summary{display:flex;align-items:center;justify-content:space-between;gap:12px;list-style:none;padding:14px 16px;cursor:pointer}.dsh-de-group summary::-webkit-details-marker{display:none}
.dsh-de-group summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c78ff);outline-offset:-2px}.dsh-de-group-title{display:block;font-size:14px;font-weight:600}.dsh-de-chevron{font-size:16px;color:var(--dsw-alias-label-tertiary,#747b86)}.dsh-de-group[open] .dsh-de-chevron{transform:rotate(180deg)}
.dsh-de-body{padding:2px 16px 14px;border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb)}
.dsh-de-field{display:grid;gap:5px;margin:10px 0}.dsh-de-label{font-size:13px;font-weight:500;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dsh-de-control{display:flex;align-items:center;gap:8px}.dsh-de-control input:not([type=checkbox]){box-sizing:border-box;min-width:0;flex:1;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:7px;background:var(--dsw-alias-bg-layer-3,#fff);color:inherit;font:inherit;font-size:13px}
.dsh-de-control input[type=checkbox]{width:17px;height:17px;accent-color:var(--dsw-alias-brand-primary,#4c78ff)}.dsh-de-tag{font-size:11px;color:var(--dsw-alias-label-secondary,#5a6470);border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:999px;padding:1px 6px}
.dsh-de-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}.dsh-de-actions button,.dsh-de-reset{border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:7px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:inherit;font:inherit;font-size:12px;cursor:pointer}.dsh-de-actions button:disabled,.dsh-de-reset:disabled{opacity:.45;cursor:default}
.dsh-de-error{color:var(--dsw-alias-label-error,#c33);font-size:12px;margin:10px 0 0}.dsh-de-notice{font-size:12px;color:var(--dsw-alias-label-tertiary,#747b86);margin:14px 0 0}
`

export function DecisionSettingsSection({ scope }: SectionProps) {
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const getSnapshot = useCallback(() => scope.getSnapshot(), [scope])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ provider: true })
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
    } catch {
      setError('保存未生效。请检查输入，或刷新后处理其他页面的修改。')
    } finally {
      setSaving(false)
    }
  }

  return <div className="dsh-de-page">
    <header>
      <h2 className="dsh-de-title">决策引擎</h2>
      <p className="dsh-de-intro">配置模型与执行预算。浏览器和电脑能力在任务使用时按需调用。</p>
    </header>
    {snapshot.status === 'unavailable' && <p className="dsh-de-notice">当前部署无法读取决策引擎设置。</p>}
    {snapshot.status === 'loading' && <p className="dsh-de-notice">正在读取设置…</p>}
    {snapshot.status === 'ready' && <>
      {!snapshot.writable && <p className="dsh-de-notice">当前部署的设置为只读。</p>}
      {GROUPS.map(group => <details key={group.id} className="dsh-de-group" open={expanded[group.id] === true} onToggle={event => {
        const open = event.currentTarget.open
        setExpanded(previous => previous[group.id] === open ? previous : { ...previous, [group.id]: open })
      }}>
        <summary><span><span className="dsh-de-group-title">{group.title}</span><span className="dsh-de-subtitle">{group.subtitle}</span></span><span className="dsh-de-chevron" aria-hidden="true">⌄</span></summary>
        <div className="dsh-de-body">
          {FIELDS.filter(spec => spec.group === group.id).map(spec => {
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
        </div>
      </details>)}
      {error && <p className="dsh-de-error" role="status">{error}</p>}
      {dirty && <div className="dsh-de-actions">
        <button type="button" disabled={saving} onClick={() => { setDrafts({}); editRevision.current = undefined; setError('') }}>放弃修改</button>
        <button type="button" disabled={invalid || saving || !snapshot.writable} onClick={() => { void save() }}>{saving ? '保存中…' : '保存修改'}</button>
      </div>}
    </>}
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
