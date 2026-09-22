/**
 * Parser for the computer-use accessibility-tree text.
 *
 * The computer environment is accessibility-only: no screenshot is read, no
 * OCR runs, and window coordinates are never inferred from pixels. What the
 * engine returns for an app is the Codex-style serialized AX tree, rendered
 * one node per line as `[index] Role "name"`, indented by depth.
 *
 * The computer-use tools are also *stateful*: after the first capture,
 * subsequent captures return a diff. This parser understands both the full
 * tree and the diff form, because a diff that is mistaken for a full tree
 * would silently shrink the candidate set.
 *
 * @module dsh-decision-engine/environments/computer/ax-tree
 */

/** One accessibility node. */
export interface AxNode {
  /** Element index used by the `computer_use_*` action tools. */
  index: number
  /** AX role as rendered (`AXButton`, `AXStaticText`, …). */
  role: string
  /** Accessible name/title, possibly empty. */
  name: string
  /** Depth by leading indentation. */
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
  /** Lines that did not parse as nodes. */
  unparsed: string[]
  /** Whether the provider said the text was truncated. */
  truncated: boolean
}

const NODE_RE = /^(\s*)([+-]?)\s*\[(\d+)]\s+(\S+)\s*(?:"((?:[^"\\]|\\.)*)")?\s*(.*)$/
const DIFF_MARKER = /^\s*(?:[-+]{3}|@@|diff\b|changed since|\(\d+ (?:added|removed|changed)\)|\+\d+ |-\d+ )/i
const TRUNCATION_MARKER = /\(truncated\)|…\(truncated|truncated at|output truncated/i

/** Roles that denote something a click can activate. */
const ACTIONABLE_ROLES = [
  'AXButton',
  'AXLink',
  'AXMenuItem',
  'AXMenuBarItem',
  'AXRadioButton',
  'AXCheckBox',
  'AXPopUpButton',
  'AXTab',
  'AXDisclosureTriangle',
  'AXRow',
  'AXCell',
  'AXImage',
  'AXToolbar',
] as const

/** Roles whose value can be replaced with `set_value`. */
const SETTABLE_ROLES = ['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXSecureTextField'] as const

/** Roles that are plain text and therefore never candidates on their own. */
const TEXT_ROLES = ['AXStaticText', 'AXHeading', 'AXGroup', 'AXWindow', 'AXScrollArea', 'AXUnknown'] as const

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
    if (DIFF_MARKER.test(line) && !NODE_RE.test(line)) {
      diffSignals += 1
      continue
    }
    const match = NODE_RE.exec(line)
    if (match === null) {
      capture.unparsed.push(line)
      continue
    }
    const indent = match[1] ?? ''
    const marker = match[2] ?? ''
    const index = Number(match[3])
    if (!Number.isInteger(index)) {
      capture.unparsed.push(line)
      continue
    }
    const role = match[4] ?? 'AXUnknown'
    const name = (match[5] ?? '').replace(/\\(.)/g, '$1')
    const trailing = (match[6] ?? '').trim()
    if (/^(?:added|removed|changed)$/i.test(trailing)) {
      if (/removed/i.test(trailing) || marker === '-') diffSignals += 1
      else if (/added|changed/i.test(trailing)) diffSignals += 1
    }
    const node: AxNode = {
      index,
      role,
      name,
      depth: Math.floor(indent.replace(/\t/g, '  ').length / 2),
      added: marker === '+',
      removed: marker === '-',
      raw: line,
    }
    capture.nodes.push(node)
  }
  capture.kind = diffSignals > 0 ? 'diff' : 'full'
  return capture
}

/** Whether a node is something a click can activate. */
export function isActionable(node: AxNode): boolean {
  if (node.removed) return false
  return (ACTIONABLE_ROLES as readonly string[]).includes(node.role)
}

/** Whether a node's value can be replaced with `set_value`. */
export function isSettable(node: AxNode): boolean {
  if (node.removed) return false
  return (SETTABLE_ROLES as readonly string[]).includes(node.role)
}

/** Whether a node carries no addressable behaviour of its own. */
export function isPassive(node: AxNode): boolean {
  return (TEXT_ROLES as readonly string[]).includes(node.role)
}

/** A one-line rendering of a node, for prompts and previews. */
export function describeAxNode(node: AxNode): string {
  const name = node.name === '' ? '' : ` "${node.name}"`
  return `[${node.index}] ${node.role}${name}`
}
