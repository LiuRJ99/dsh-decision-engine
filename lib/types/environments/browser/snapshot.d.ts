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
    index: number;
    /** Element role as rendered by the bridge (`button`, `link`, `checkbox`, …). */
    role: string;
    /** Accessible name. */
    name: string;
    disabled: boolean;
    checked?: boolean;
    selected?: boolean;
    pressed?: boolean;
    /** Raw DOM class tokens; never interpreted as semantic checked state. */
    domClasses?: string;
    outsideViewport: boolean;
    /** Link target when the bridge rendered one. */
    href?: string;
}
/** One form field from the snapshot inventory. */
export interface SnapshotFormField {
    index: number;
    /** Field label, when the identity column was rendered. */
    label?: string;
    /** Field kind (`text`, `password`, `select`, `checkbox`, …). */
    kind?: string;
    /** Current value; masked values are rendered as bullets by the bridge and kept verbatim here. */
    value?: string;
    /** Whether the rendered value was masked (password/secret). */
    masked: boolean;
    checked?: boolean;
    required: boolean;
}
/** Everything the adapter extracts from one snapshot. */
export interface BrowserSnapshot {
    title?: string;
    url?: string;
    /** Ready state as rendered; free-form because the bridge owns the vocabulary. */
    status?: string;
    /** Whether the bridge said element indices were reassigned, so cached refs are stale. */
    reindexed: boolean;
    /** Main content text, verbatim (already truncation-capped by the bridge). */
    main: string;
    /** Interactive inventory, in snapshot index order. */
    items: SnapshotItem[];
    /** Form-field inventory, in snapshot index order. */
    forms: SnapshotFormField[];
    /** Lines the parser did not recognize, kept so shape drift is visible. */
    unparsed: string[];
    /** Whether any `canvas`/`video`/`webgl` marker appeared in the main content. */
    canvasLike: boolean;
    /** Characters of main content, for truncation heuristics. */
    mainChars: number;
    inventoryScope?: {
        includeNonSemantic: boolean;
        candidateSelector?: string;
    };
}
/**
 * Parse one `browser_snapshot` text payload.
 *
 * @param text - the tool's text content.
 * @returns the parsed snapshot. Never throws: an unparseable payload yields an
 *   empty inventory plus `unparsed` lines, which the adapter turns into an
 *   `insufficient` observation.
 */
export declare function parseBrowserSnapshot(text: string): BrowserSnapshot;
/**
 * Whether a snapshot looks like an environment structured state cannot
 * describe: almost no readable text and essentially no interactive elements.
 *
 * The check is deliberately about *evidence of unavailability* rather than the
 * presence of a tag name: a page whose visible text merely mentions "canvas"
 * is a normal page. What matters is that there is nothing to address.
 */
export declare function looksCanvasLike(snapshot: Pick<BrowserSnapshot, 'main' | 'mainChars' | 'items' | 'forms' | 'unparsed'>): boolean;
/** Render a snapshot item back to one short model-readable line. */
export declare function describeItem(item: SnapshotItem): string;
/** Render a form field back to one short model-readable line. */
export declare function describeFormField(field: SnapshotFormField): string;
//# sourceMappingURL=snapshot.d.ts.map