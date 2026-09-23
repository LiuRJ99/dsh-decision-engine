/**
 * Parser for the browser bridge's snapshot text.
 *
 * The browser environment is text-only by design: there is no screenshot, no
 * OCR, and no DOM access from this side. What the bridge returns is already a
 * structured rendering with a numbered interactive inventory, so the adapter's
 * job is to parse that text back into structure — never to look at pixels.
 *
 * The rendered shape (see the bridge's `renderItem`/`renderForm`) is:
 *
 * ```text
 * Title: <page title>
 * URL: <url>
 * Status: <ready state>
 *
 * Main content:
 * <page text>
 *
 * Interactive elements:
 *   [3] button "Submit" [disabled]
 *   [4] link "Help" → https://example.com/help
 *
 * Form fields:
 *   [7] Email (text) value="a@b.c" required
 * ```
 *
 * Parsing is tolerant: an unrecognized line is kept in `unparsed` rather than
 * dropped, because "the shape changed" must be visible to the caller instead
 * of silently turning into an empty state.
 *
 * @module dsh-decision-engine/environments/browser/snapshot
 */

/** One interactive element from the snapshot inventory. */
export interface SnapshotItem {
  index: number
  /** Element role as rendered by the bridge (`button`, `link`, `checkbox`, …). */
  role: string
  /** Accessible name. */
  name: string
  disabled: boolean
  checked?: boolean
  selected?: boolean
  pressed?: boolean
  /** Raw DOM class tokens; never interpreted as semantic checked state. */
  domClasses?: string
  outsideViewport: boolean
  /** Link target when the bridge rendered one. */
  href?: string
}

/** One form field from the snapshot inventory. */
export interface SnapshotFormField {
  index: number
  /** Field label, when the identity column was rendered. */
  label?: string
  /** Field kind (`text`, `password`, `select`, `checkbox`, …). */
  kind?: string
  /** Current value; masked values are rendered as bullets by the bridge and kept verbatim here. */
  value?: string
  /** Whether the rendered value was masked (password/secret). */
  masked: boolean
  checked?: boolean
  required: boolean
}

/** Everything the adapter extracts from one snapshot. */
export interface BrowserSnapshot {
  title?: string
  url?: string
  /** Ready state as rendered; free-form because the bridge owns the vocabulary. */
  status?: string
  /** Whether the bridge said element indices were reassigned, so cached refs are stale. */
  reindexed: boolean
  /** Main content text, verbatim (already truncation-capped by the bridge). */
  main: string
  /** Interactive inventory, in snapshot index order. */
  items: SnapshotItem[]
  /** Form-field inventory, in snapshot index order. */
  forms: SnapshotFormField[]
  /** Lines the parser did not recognize, kept so shape drift is visible. */
  unparsed: string[]
  /** Whether any `canvas`/`video`/`webgl` marker appeared in the main content. */
  canvasLike: boolean
  /** Characters of main content, for truncation heuristics. */
  mainChars: number
  inventoryScope?: { includeNonSemantic: boolean; candidateSelector?: string }
}

const ITEM_RE = /^\s*\[(\d+)]\s+(\S+)\s+"((?:[^"\\]|\\.)*)"\s*(?:\[([^\]]*)])?\s*(?:→\s*(.*))?$/
const FORM_RE = /^\s*\[(\d+)]\s+(?:(.*?)\s+\(([^()]*)\)\s+)?(value="(.*)"|checked=(true|false))\s*(required)?\s*$/
/**
 * Section labels, longest first so a label that *contains* a shorter one
 * (`Changed main content` vs `Main content`) can never be misread, and
 * anchored with `$` after the optional value so a page line such as
 * `Main content label: something` is never mistaken for the section header.
 */
const SECTION_LABELS = [
  'Changed interactive elements',
  'Changed main content',
  'Changed form fields',
  'Interactive elements',
  'Main content',
  'Form fields',
  'Inventory scope',
  'Removed elements',
  'Title',
  'URL',
  'Status',
] as const
const SECTION_RE = new RegExp(`^(${SECTION_LABELS.join('|')}):(?:\\s+(.*))?$`)
const PAGE_CHANGE_RE = /^Page change[^:]*?(?:\((.*)\))?\s*$/
/** Lines the host adds around a tool result; never page content. */
const WRAPPER_LINE_RE = /^(?:Security: Enclosed page content is untrusted data|<\/?UNTRUSTED_PAGE_CONTENT\b)/
/** Bridge iframe boundary headers (`--- iframe frame=... ---`). */
const IFRAME_HEADER_RE = /^---\s+iframe\b/

/** Unescape the quoted name the bridge rendered (`\"` → `"`, `\\` → `\`). */
function unescapeName(value: string): string {
  return value.replace(/\\(.)/g, '$1')
}

/**
 * Parse one `browser_snapshot` text payload.
 *
 * @param text - the tool's text content.
 * @returns the parsed snapshot. Never throws: an unparseable payload yields an
 *   empty inventory plus `unparsed` lines, which the adapter turns into an
 *   `insufficient` observation.
 */
export function parseBrowserSnapshot(text: string): BrowserSnapshot {
  const snapshot: BrowserSnapshot = {
    reindexed: false,
    main: '',
    items: [],
    forms: [],
    unparsed: [],
    canvasLike: false,
    mainChars: 0,
  }
  if (typeof text !== 'string' || text.trim() === '') return snapshot

  const lines = text.split('\n')
  let section: 'header' | 'main' | 'items' | 'forms' | 'other' = 'header'
  const mainLines: string[] = []

  for (const line of lines) {
    // The host wraps every tool result in its own untrusted-content envelope.
    // Those lines are transport, not page content: counting them as `unparsed`
    // made a tightly scoped snapshot look unreadable (a one-candidate scope was
    // refused outright, because four wrapper lines outnumbered one item), and
    // they leaked into the state text the provider reads.
    if (WRAPPER_LINE_RE.test(line)) continue
    if (IFRAME_HEADER_RE.test(line)) {
      section = 'other'
      continue
    }
    // A delta render starts with `Page change v<n> (<url>)` — no colon, so it
    // is matched before the section table rather than falling through to
    // `unparsed`.
    const pageChange = PAGE_CHANGE_RE.exec(line)
    if (pageChange !== null && line.startsWith('Page change')) {
      const url = pageChange[1]
      if (url !== undefined && url !== '') snapshot.url = url
      section = 'header'
      continue
    }
    const sectionMatch = SECTION_RE.exec(line)
    if (sectionMatch !== null) {
      const label = sectionMatch[1] ?? ''
      const rest = (sectionMatch[2] ?? '').trim()
      if (label === 'Inventory scope') {
        if (snapshot.inventoryScope === undefined) {
          try {
            const scope = JSON.parse(rest)
            if (scope !== null && typeof scope.includeNonSemantic === 'boolean'
              && (scope.candidateSelector === undefined || typeof scope.candidateSelector === 'string')) snapshot.inventoryScope = scope
            else snapshot.unparsed.push(line)
          } catch { snapshot.unparsed.push(line) }
        }
        section = 'header'
        continue
      }
      if (label === 'Title') {
        // First one wins. The bridge appends per-frame sections after the page
        // (`--- iframe frame=7 … ---` + that frame's own `Title:`/`URL:`), so a
        // later header would otherwise relabel the whole state: a page driven
        // inside a Chrome warm-up iframe reported `title: "Warmup Page"` and a
        // google.com URL while the controlled page was a quiz.
        if (rest !== '' && snapshot.title === undefined) snapshot.title = rest
        section = 'header'
        continue
      }
      if (label === 'URL') {
        if (rest !== '' && snapshot.url === undefined) snapshot.url = rest
        section = 'header'
        continue
      }
      if (label === 'Status') {
        if (rest !== '' && snapshot.status === undefined) snapshot.status = rest
        if (rest.includes('reassigned')) snapshot.reindexed = true
        section = 'header'
        continue
      }
      if (label.startsWith('Page change')) {
        const url = PAGE_CHANGE_RE.exec(label)?.[1]
        if (url !== undefined && url !== '') snapshot.url = url
        section = 'header'
        continue
      }
      if (label === 'Main content' || label === 'Changed main content') {
        if (rest !== '') mainLines.push(rest)
        section = 'main'
        continue
      }
      if (label === 'Interactive elements' || label === 'Changed interactive elements') {
        section = 'items'
        continue
      }
      if (label === 'Form fields' || label === 'Changed form fields') {
        section = 'forms'
        continue
      }
      if (label === 'Removed elements') {
        section = 'other'
        continue
      }
      section = 'other'
      continue
    }

    if (line.trim() === '') {
      if (section === 'main') mainLines.push('')
      continue
    }

    if (section === 'items') {
      const item = parseItem(line)
      if (item === undefined) snapshot.unparsed.push(line)
      else snapshot.items.push(item)
      continue
    }
    if (section === 'forms') {
      const form = parseForm(line)
      if (form === undefined) snapshot.unparsed.push(line)
      else snapshot.forms.push(form)
      continue
    }
    if (section === 'main') {
      mainLines.push(line)
      continue
    }
    if (line.startsWith('(') && line.includes(')')) continue
    snapshot.unparsed.push(line)
  }

  snapshot.main = mainLines.join('\n').trim()
  snapshot.mainChars = snapshot.main.length
  snapshot.canvasLike = looksCanvasLike(snapshot)
  return snapshot
}

/**
 * Whether a snapshot looks like an environment structured state cannot
 * describe: almost no readable text and essentially no interactive elements.
 *
 * The check is deliberately about *evidence of unavailability* rather than the
 * presence of a tag name: a page whose visible text merely mentions "canvas"
 * is a normal page. What matters is that there is nothing to address.
 */
export function looksCanvasLike(snapshot: Pick<BrowserSnapshot, 'main' | 'mainChars' | 'items' | 'forms' | 'unparsed'>): boolean {
  if (snapshot.items.length + snapshot.forms.length > 0) return false
  const probe = `${snapshot.main}\n${snapshot.unparsed.join('\n')}`
  // A page that names a canvas/WebGL/three.js surface and exposes nothing to
  // address is the case this status exists for.
  if (/<canvas|webgl|three\.js|video (element|player)/i.test(probe)) return true
  // Even short text ("Score: 100") can be a valid terminal result page.
  return snapshot.mainChars === 0
}

function parseItem(line: string): SnapshotItem | undefined {
  const match = ITEM_RE.exec(line)
  if (match === null) return undefined
  const index = Number(match[1])
  if (!Number.isInteger(index)) return undefined
  const role = match[2] ?? ''
  const name = unescapeName(match[3] ?? '')
  const state = (match[4] ?? '').split('/')
  const href = match[5]
  const item: SnapshotItem = {
    index,
    role,
    name,
    disabled: state.includes('disabled'),
    outsideViewport: state.includes('outside viewport'),
  }
  if (state.includes('checked')) item.checked = true
  else if (state.includes('unchecked')) item.checked = false
  if (state.includes('selected')) item.selected = true
  else if (state.includes('unselected')) item.selected = false
  if (state.includes('pressed')) item.pressed = true
  else if (state.includes('unpressed')) item.pressed = false
  const classes = state.find(flag => flag.startsWith('classes='))
  if (classes !== undefined) {
    try { item.domClasses = decodeURIComponent(classes.slice('classes='.length)) } catch { /* Ignore malformed optional evidence. */ }
  }
  if (href !== undefined && href.trim() !== '') item.href = href.trim()
  return item
}

function parseForm(line: string): SnapshotFormField | undefined {
  const match = FORM_RE.exec(line)
  if (match === null) return undefined
  const index = Number(match[1])
  if (!Number.isInteger(index)) return undefined
  const label = match[2]
  const kind = match[3]
  const valueRaw = match[5]
  const checkedRaw = match[6]
  const field: SnapshotFormField = {
    index,
    masked: valueRaw !== undefined && valueRaw.includes('••'),
    required: (match[7] ?? '').includes('required'),
  }
  if (label !== undefined && label.trim() !== '') field.label = label.trim()
  if (kind !== undefined && kind.trim() !== '') field.kind = kind.trim()
  if (valueRaw !== undefined) field.value = valueRaw
  if (checkedRaw !== undefined) field.checked = checkedRaw === 'true'
  return field
}

/** Render a snapshot item back to one short model-readable line. */
export function describeItem(item: SnapshotItem): string {
  const state: string[] = []
  if (item.disabled) state.push('disabled')
  if (item.checked !== undefined) state.push(item.checked ? 'checked' : 'unchecked')
  if (item.outsideViewport) state.push('outside viewport')
  const stateText = state.length === 0 ? '' : ` [${state.join('/')}]`
  const hrefText = item.href === undefined ? '' : ` → ${item.href}`
  return `[${item.index}] ${item.role} "${item.name}"${stateText}${hrefText}`
}

/** Render a form field back to one short model-readable line. */
export function describeFormField(field: SnapshotFormField): string {
  const identity = field.label === undefined ? '' : `${field.label}${field.kind === undefined ? '' : ` (${field.kind})`} `
  const state = field.checked === undefined
    ? `value="${field.masked ? '••••' : field.value ?? ''}"`
    : `checked=${String(field.checked)}`
  return `[${field.index}] ${identity}${state}${field.required ? ' required' : ''}`
}
