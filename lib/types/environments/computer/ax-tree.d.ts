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
    index: number;
    /** Plain-language role (`button`, `standard window`, `static text`, …), lowercased. */
    role: string;
    /** The element's title, when it had one. */
    title?: string;
    /** `Description:` — often the real label for icons and images. */
    description?: string;
    /** `Value:` — rendered text, number, or boolean. */
    value?: string;
    /** `ID:` — the developer-assigned accessibility identifier. */
    identifier?: string;
    /** `Help:` — tooltip text. */
    help?: string;
    /** Named accessibility actions other than the primary press. */
    secondaryActions: string[];
    /** The element's primary press action is unavailable. */
    disabled: boolean;
    /** The value is writable, so `computer_use_set_value` applies. */
    settable: boolean;
    /** Depth by leading tabs. */
    depth: number;
    /** Whether the node carried the diff's `+` add marker. */
    added: boolean;
    /** Whether the node carried the diff's `-` remove marker. */
    removed: boolean;
    /** Raw line, for diagnostics. */
    raw: string;
}
/** A parsed capture. */
export interface AxCapture {
    /** `full` when the payload is a complete tree; `diff` when it is a marked diff. */
    kind: 'full' | 'diff';
    /** Nodes in render order (including removed ones, marked). */
    nodes: AxNode[];
    /** The app id from the header line, when present. */
    app?: string;
    /** The window title from the header line, when present. */
    window?: string;
    /** Lines that did not parse as nodes or headers. */
    unparsed: string[];
    /** Whether the provider said the text was truncated. */
    truncated: boolean;
}
/**
 * Parse one accessibility capture.
 *
 * @param text - the text returned by `computer_use_get_app_state`.
 * @param truncated - the provider's own truncation flag, when it reported one.
 * @returns the parsed capture. Never throws.
 */
export declare function parseAxTree(text: string, truncated?: boolean): AxCapture;
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
export declare function mergeAxDiff(previous: AxCapture, diff: AxCapture): AxNode[] | undefined;
/** Whether any candidate can be derived from this node. */
export declare function isAddressable(node: AxNode): boolean;
/** Whether a node's value can be replaced with `computer_use_set_value`. */
export declare function isSettable(node: AxNode): boolean;
/** Whether a node carries no addressable behaviour of its own. */
export declare function isPassive(node: AxNode): boolean;
/** The best human label a node offers, for candidate descriptions. */
export declare function labelOf(node: AxNode): string;
/** A one-line rendering of a node, for prompts and previews. */
export declare function describeAxNode(node: AxNode): string;
/** `AXScrollLeftByPage` → `Scroll Left By Page`, matching the daemon's labels. */
export declare function humanActionLabel(actionName: string): string;
//# sourceMappingURL=ax-tree.d.ts.map