/**
 * Parser for the computer-use accessibility-tree text.
 *
 * The computer environment is accessibility-only: no screenshot is read, no OCR
 * runs, and window coordinates are never inferred from pixels.
 *
 * ## The format this parses
 *
 * The daemon renders one node per line
 * (`dsh-computer-daemon/Sources/StateCapture.swift`, `describe()`):
 *
 * ```text
 * App=com.apple.finder (pid 757)
 * Window: "dsh-work", App: 访达.
 * 0 standard window dsh-work ID: FinderWindow Secondary Actions: Raise
 * \t1 split group
 * \t\t2 scroll area Secondary Actions: Scroll Left By Page, Scroll Right By Page
 * \t\t\t3 outline Description: 边栏 Secondary Actions: Show Menu
 * \t\t\t\t4 row Secondary Actions: Show Default U I, Show Alternate U I
 * \t\t\t\t\t5 cell Secondary Actions: Open
 * \t\t\t\t\t\t6 static text Value: 最近使用
 * \t\t\t\t\t\t7 image Description: 时钟
 * ```
 *
 * So a line is: tab-indented depth, a depth-first **index**, then a descriptor
 * made of space-joined parts:
 *
 * ```text
 * <role> [<title>] [Description: <text>] [(traits)] [Value: <text>] [Help: <text>] [ID: <id>] [Secondary Actions: a, b]
 * ```
 *
 * Three properties of that grammar drive this parser:
 *
 * 1. **Roles are plain-language, multi-word, and unquoted**, and the title that
 *    may follow them is unquoted too (`button 推出`, `standard window dsh-work`).
 *    Roles are therefore matched longest-first against the daemon's own
 *    vocabulary — the one list that can disambiguate them.
 * 2. **Traits are parenthesized** (`(disabled)`, `(settable, string)`) and sit
 *    directly before `Value:`, which is the only unambiguous anchor for a value
 *    that contains arbitrary text.
 * 3. **`Secondary Actions` is the non-press action vocabulary**, and the daemon
 *    filters `AXPress` out of it. A pressable control therefore often shows no
 *    secondary actions at all, so actionability cannot be decided by that field
 *    alone — this parser also classifies by role.
 *
 * The index is the addressing key for every `computer_use_*` action tool, so
 * `index` is preserved verbatim and never renumbered.
 *
 * @module dsh-decision-engine/environments/computer/ax-tree
 */

/** One accessibility node, as the daemon rendered it. */
export interface AxNode {
  /** Element index used by the `computer_use_*` action tools. Preserved verbatim. */
  index: number
  /** Plain-language role (`button`, `standard window`, `static text`, …), lowercased. */
  role: string
  /** The element's title, when it had one. */
  title?: string
  /** `Description:` — often the real label for icons and images. */
  description?: string
  /** `Value:` — rendered text, number, or boolean. */
  value?: string
  /** `ID:` — the developer-assigned accessibility identifier. */
  identifier?: string
  /** `Help:` — tooltip text. */
  help?: string
  /** Named accessibility actions other than the primary press. */
  secondaryActions: string[]
  /** The element's primary press action is unavailable. */
  disabled: boolean
  /** The value is writable, so `computer_use_set_value` applies. */
  settable: boolean
  /** Depth by leading tabs. */
  depth: number
  /** Whether the node carried the diff's `+` add marker. */
  added: boolean
  /** Whether the node carried the diff's `-` remove marker. */
  removed: boolean
  /** Raw line, for diagnostics. */
  raw: string
}

/** A parsed capture. */
export interface AxCapture {
  /** `full` when the payload is a complete tree; `diff` when it is a marked diff. */
  kind: 'full' | 'diff'
  /** Nodes in render order (including removed ones, marked). */
  nodes: AxNode[]
  /** The app id from the header line, when present. */
  app?: string
  /** The window title from the header line, when present. */
  window?: string
  /** Lines that did not parse as nodes or headers. */
  unparsed: string[]
  /** Whether the provider said the text was truncated. */
  truncated: boolean
}

/**
 * The daemon's role vocabulary, longest first.
 *
 * This list is what makes the grammar parseable: `standard window` must be
 * matched before `window`, and `static text` before `text`.
 */
const ROLE_VOCABULARY = [
  'progress indicator',
  'disclosure triangle',
  'text entry area',
  'standard window',
  'radio button',
  'pop up button',
  'dialog window',
  'color well',
  'menu button',
  'split group',
  'scroll area',
  'static text',
  'menu item',
  'text field',
  'tab group',
  'checkbox',
  'toolbar',
  'outline',
  'slider',
  'column',
  'window',
  'button',
  'splitter',
  'heading',
  'element',
  'image',
  'table',
  'link',
  'list',
  'cell',
  'row',
].sort((left, right) => right.length - left.length)

const NODE_LINE_RE = /^(\t*)([+-]?)\s*(\d+)\s+(.*)$/
const APP_HEADER_RE = /^App=(\S+)(?:\s+\(pid\s+\d+\))?/
const WINDOW_HEADER_RE = /^Window:\s*"((?:[^"\\]|\\.)*)"/
/**
 * A recognized field marker. Everything before the first one is the role and
 * its optional title; this is what keeps a trailing `ID:` or
 * `Secondary Actions:` out of the title.
 */
const FIELD_START_RE = /\s+(?:Description|Value|Help|ID|Secondary Actions):\s/
const DESCRIPTION_RE = /Description:\s*(.*)$/
const VALUE_RE = /Value:\s*(.*)$/
// An id is one whitespace-delimited token; `Secondary Actions:` may follow it,
// so the pattern is not anchored to the end of the line.
const ID_RE = /(?:^|\s)ID:\s*(\S+)/
const HELP_RE = /Help:\s*(.*)$/
const SECONDARY_RE = /Secondary Actions:\s*(.*)$/
/**
 * The daemon's own diff/unchanged announcements (verbatim from
 * `StateCapture.swift`). Detection is by these sentences and by the line
 * prefixes below — never by scanning free text for words like "changed", which
 * is exactly the bug that made an ordinary Finder window look like a diff.
 */
const DIFF_HEADER = 'The following is a diff from the previous accessibility tree'
const CUMULATIVE_DIFF_HEADER = 'The following is a cumulative diff from the initial accessibility tree'
const UNCHANGED_TEXT = 'There has been no change in the accessibility tree for the previous capture.'
const TRUNCATION_MARK = '(element limit reached; the tree is incomplete)'
/** `+`/`~`/`-` immediately before a node index; `~` marks a changed line. */
const DIFF_LINE_RE = /^(?:\t*)([+~-])\s+\d+\s/
const TRUNCATION_MARKER = new RegExp(`accessibility tree truncated|truncated at|…\\(truncated|${TRUNCATION_MARK.replace(/[()]/g, '\\$&')}`, 'i')

/**
 * Roles whose primary action is a press, so a click candidate makes sense even
 * when the daemon rendered no secondary actions for them (`AXPress` is filtered
 * out of that list).
 */
const PRESSABLE_ROLES = new Set([
  'button',
  'pop up button',
  'menu button',
  'menu item',
  'checkbox',
  'radio button',
  'link',
  'disclosure triangle',
  'color well',
  'slider',
  'row',
  'cell',
  'image',
])

/** Roles that never become candidates on their own: containers and read-only text. */
const PASSIVE_ROLES = new Set([
  'standard window',
  'window',
  'dialog window',
  'split group',
  'scroll area',
  'outline',
  'toolbar',
  'table',
  'list',
  'column',
  'splitter',
  'heading',
  'static text',
  'progress indicator',
  'element',
])

/**
 * Parse one accessibility capture.
 *
 * @param text - the text returned by `computer_use_get_app_state`.
 * @param truncated - the provider's own truncation flag, when it reported one.
 * @returns the parsed capture. Never throws.
 */
export function parseAxTree(text: string, truncated = false): AxCapture {
  const capture: AxCapture = {
    kind: 'full',
    nodes: [],
    unparsed: [],
    truncated: truncated || TRUNCATION_MARKER.test(text ?? ''),
  }
  if (typeof text !== 'string' || text === '') return capture

  let diffSignals = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const trimmed = line.trim()

    // An explicit diff announcement is authoritative.
    if (trimmed.includes(CUMULATIVE_DIFF_HEADER) || trimmed.includes(DIFF_HEADER)) {
      capture.kind = 'diff'
      continue
    }
    if (trimmed.includes(UNCHANGED_TEXT)) {
      capture.kind = 'diff'
      continue
    }
    // The removal summary is not a node: it is one id-range list, kept in
    // `unparsed` for the merge to read.
    if (trimmed.startsWith('Removed element IDs:')) {
      diffSignals += 1
      capture.unparsed.push(trimmed)
      continue
    }

    const appHeader = APP_HEADER_RE.exec(line)
    if (appHeader?.[1] !== undefined) {
      capture.app = appHeader[1]
      continue
    }
    const windowHeader = WINDOW_HEADER_RE.exec(line)
    if (windowHeader?.[1] !== undefined) {
      capture.window = windowHeader[1].replace(/\\(.)/g, '$1')
      continue
    }

    // A diff line carries `+`/`~`/`-` before its index. This is the only
    // structural signal; free text is never scanned for diff vocabulary. The
    // marker is stripped here and recorded on the node, because a diff line
    // renders its node in full and must still parse as one.
    const diffLine = DIFF_LINE_RE.exec(line)
    const diffMarker = diffLine?.[1] ?? ''
    if (diffMarker !== '') diffSignals += 1
    const stripped = diffMarker === '' ? line : line.replace(/(\t*)[+~-]\s+/, '$1')

    const match = NODE_LINE_RE.exec(stripped)
    if (match === null) {
      capture.unparsed.push(line)
      continue
    }
    const indent = match[1] ?? ''
    // `~` means "changed", which is neither an addition nor a removal: for a
    // merge it simply replaces whatever the previous capture held at that index.
    const marker = diffMarker === '~' ? '' : diffMarker === '' ? (match[2] ?? '') : diffMarker
    const index = Number(match[3])
    const descriptor = (match[4] ?? '').trim()
    if (!Number.isInteger(index) || descriptor === '') {
      capture.unparsed.push(line)
      continue
    }

    capture.nodes.push(parseDescriptor(index, descriptor, indent.length, marker, line))
  }
  if (diffSignals > 0) capture.kind = 'diff'
  return capture
}

/**
 * Overlay a diff capture onto the full capture it was diffed from.
 *
 * A diff renders `+` (added) and `~` (changed) lines in full, and collapses
 * removals into one `Removed element IDs:` range summary — so the previous
 * capture plus a diff reconstructs the current tree. This is what lets a caller
 * that explicitly asked for a diff still build a candidate set, while a diff
 * that arrives with no previous capture remains unusable (and is reported as
 * such rather than silently shrinking the tree).
 *
 * @param previous - the last full capture for the same app.
 * @param diff - the diff capture.
 * @returns the merged nodes, or `undefined` when the diff announced no change
 *   (in which case the previous capture still stands).
 */
export function mergeAxDiff(previous: AxCapture, diff: AxCapture): AxNode[] | undefined {
  if (diff.kind !== 'diff') return diff.nodes
  const removed = new Set<number>()
  for (const node of diff.nodes) {
    if (node.removed) removed.add(node.index)
  }
  for (const line of diff.unparsed) {
    const match = /Removed element IDs:\s*(.*)$/.exec(line)
    if (match?.[1] === undefined) continue
    for (const part of match[1].split(/,\s*/)) {
      const range = /^(\d+)\s*[–-]\s*(\d+)$/.exec(part.trim())
      if (range?.[1] !== undefined && range[2] !== undefined) {
        for (let index = Number(range[1]); index <= Number(range[2]); index += 1) removed.add(index)
        continue
      }
      const single = Number(part.trim())
      if (Number.isInteger(single)) removed.add(single)
    }
  }

  const merged = new Map<number, AxNode>()
  for (const node of previous.nodes) {
    if (removed.has(node.index)) continue
    merged.set(node.index, node)
  }
  let changed = false
  for (const node of diff.nodes) {
    if (removed.has(node.index)) continue
    const existing = merged.get(node.index)
    if (existing === undefined || existing.raw !== node.raw) changed = true
    merged.set(node.index, { ...node, added: false, removed: false })
  }
  if (!changed && diff.nodes.length === 0 && removed.size === 0) return undefined
  return [...merged.values()].sort((left, right) => left.index - right.index)
}

/**
 * Parse one node descriptor into its fields.
 *
 * The parts are **space-joined with free text inside them**, so the field order
 * is what makes the grammar decidable:
 *
 * ```text
 * ... Value: <text> (traits) Help: <text> ID: <id> Secondary Actions: <a, b>
 * ```
 *
 * A field's value therefore runs from its own marker to the **next** marker of
 * any kind, and at most one parenthesized traits block can sit inside it. That
 * is why this walks the markers in order instead of matching each field with an
 * independent regex: `Value: 最近使用 (settable, string)` must yield the value
 * `最近使用` and the traits `settable, string`, while
 * `Description: 推出 (disabled)` yields the description `推出 (disabled)` — the
 * daemon renders the disabled trait in two different positions, and it means the
 * same thing in both.
 */
function parseDescriptor(index: number, descriptor: string, depth: number, marker: string, raw: string): AxNode {
  const trimmed = descriptor.trim()
  const fieldStart = FIELD_START_RE.exec(trimmed)
  const head = (fieldStart === null ? trimmed : trimmed.slice(0, fieldStart.index)).trim()
  const { role, title } = splitRoleAndTitle(head)

  // Value: runs to the next field marker; a traits block inside that span is a
  // trait block, not part of the value.
  const valueMatch = VALUE_RE.exec(trimmed)
  let value: string | undefined
  let traits: string[] = []
  if (valueMatch !== null) {
    const span = boundFreeText(valueMatch[1] ?? '', 'Value')
    const traitBlock = /\(([^()]*)\)\s*$/.exec(span)
    const inside = traitBlock?.[1]?.split(',').map(part => part.trim()).filter(part => part !== '') ?? []
    const isTraitBlock = inside.some(part => part === 'disabled' || part === 'settable')
      || (inside.length >= 2 && /^(?:string|number|float|boolean)$/.test(inside[inside.length - 1] ?? ''))
    if (traitBlock !== null && isTraitBlock) {
      traits = inside
      value = span.slice(0, span.length - (traitBlock[0]?.length ?? 0)).trim()
    } else {
      value = span
    }
  }

  const descriptionMatch = DESCRIPTION_RE.exec(trimmed)
  const description = descriptionMatch === null ? undefined : boundFreeText(descriptionMatch[1] ?? '', 'Description')

  // `disabled` also appears as a standalone parenthesized trait outside Value:.
  const disabled = traits.includes('disabled') || /\(\s*disabled\s*\)/.test(trimmed)
  const settable = traits.includes('settable')

  const node: AxNode = {
    index,
    role,
    secondaryActions: splitSecondaryActions(SECONDARY_RE.exec(trimmed)?.[1]),
    disabled,
    settable,
    depth,
    added: marker === '+',
    removed: marker === '-',
    raw,
  }
  if (title !== undefined) node.title = title
  if (description !== undefined && description !== '') node.description = description
  if (value !== undefined && value !== '') node.value = value
  const identifier = ID_RE.exec(trimmed)?.[1]
  if (identifier !== undefined) node.identifier = identifier
  const help = helpOf(trimmed)
  if (help !== undefined) node.help = help
  return node
}

/** Split `<role> [<title>]` using the daemon's own role vocabulary. */
function splitRoleAndTitle(head: string): { role: string; title?: string } {
  const lower = head.toLowerCase()
  for (const role of ROLE_VOCABULARY) {
    if (lower === role) return { role }
    if (lower.startsWith(`${role} `)) {
      const title = head.slice(role.length).trim()
      return title === '' ? { role } : { role, title }
    }
  }
  // Unknown role: the daemon's fallback for those is spaced camel case, so the
  // first word is taken as the role and the rest as the title. For a genuinely
  // multi-word unknown role that misreads the role, but it keeps the node
  // addressable and named, which is the safer error.
  const words = head.split(' ')
  const first = words[0] ?? head
  const rest = words.slice(1).join(' ').trim()
  return rest === '' ? { role: first.toLowerCase() } : { role: first.toLowerCase(), title: rest }
}

/** Split a `Secondary Actions:` list, tolerating the daemon's `, ` separator. */
function splitSecondaryActions(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(/,\s*/)
    .map(part => part.trim())
    .filter(part => part !== '' && !/^(?:ID|Help|Value|Description):/i.test(part))
}

/** `Help:` text, bounded by whichever recognized field follows it. */
function helpOf(descriptor: string): string | undefined {
  const match = HELP_RE.exec(descriptor)
  if (match?.[1] === undefined) return undefined
  const text = boundFreeText(match[1], 'Help')
  return text === '' ? undefined : text
}

/**
 * Bound one free-text field: it ends where the next recognized field begins.
 *
 * `Description:` and `Value:` carry arbitrary text, so their capture runs to the
 * end of the line and has to be cut at the next marker. The marker set is the
 * daemon's own field vocabulary, which is what keeps a value that happens to
 * contain a colon from truncating early.
 *
 * @param text - everything after this field's own marker.
 * @param ownField - the field being read, excluded from the cut so a value that
 *   repeats its own field name is not truncated at itself.
 */
function boundFreeText(text: string, ownField: string): string {
  const marker = new RegExp(`\\s+(?:(?!${ownField}\\b)[A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*):\\s`)
  const cut = text.search(marker)
  return (cut === -1 ? text : text.slice(0, cut)).trim()
}

/** Whether any candidate can be derived from this node. */
export function isAddressable(node: AxNode): boolean {
  if (node.removed || node.disabled) return false
  if (node.settable) return true
  if (node.secondaryActions.length > 0) return true
  return PRESSABLE_ROLES.has(node.role)
}

/** Whether a node's value can be replaced with `computer_use_set_value`. */
export function isSettable(node: AxNode): boolean {
  return !node.removed && node.settable
}

/** Whether a node carries no addressable behaviour of its own. */
export function isPassive(node: AxNode): boolean {
  return PASSIVE_ROLES.has(node.role) && !node.settable && node.secondaryActions.length === 0
}

/** The best human label a node offers, for candidate descriptions. */
export function labelOf(node: AxNode): string {
  for (const candidate of [node.title, node.description, node.value, node.identifier]) {
    if (candidate !== undefined && candidate.trim() !== '') return candidate.trim()
  }
  return `${node.role} ${node.index}`
}

/** A one-line rendering of a node, for prompts and previews. */
export function describeAxNode(node: AxNode): string {
  return `[${node.index}] ${node.role}${node.title === undefined ? '' : ` "${node.title}"`}`
}

/** `AXScrollLeftByPage` → `Scroll Left By Page`, matching the daemon's labels. */
export function humanActionLabel(actionName: string): string {
  const base = actionName.startsWith('AX') ? actionName.slice(2) : actionName
  let spaced = ''
  for (const character of base) {
    if (character >= 'A' && character <= 'Z' && spaced !== '') spaced += ' '
    spaced += character
  }
  return spaced
}
