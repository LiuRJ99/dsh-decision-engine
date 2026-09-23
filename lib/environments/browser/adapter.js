// src/core/errors.ts
var DECISION_ERROR_BRAND = "dsh-decision-engine/decision-error";
var DecisionError = class extends Error {
  /**
   * Present on every copy of this class, so a `DecisionError` thrown by one
   * export entry is recognizable from another without sharing a class identity.
   */
  static brand = DECISION_ERROR_BRAND;
  /** Instance-side brand, for a structural check. */
  brand = DECISION_ERROR_BRAND;
  code;
  subject;
  details;
  constructor(code, message, options) {
    super(message, options?.cause === void 0 ? void 0 : { cause: options.cause });
    this.name = "DecisionError";
    this.code = code;
    this.subject = options?.subject;
    this.details = options?.details;
  }
  /**
   * Whether a value is a `DecisionError` from **any** copy of this package.
   *
   * Also makes `instanceof` work across bundled copies (see
   * {@link DECISION_ERROR_BRAND}).
   */
  static isDecisionError(value) {
    return isDecisionError(value);
  }
  static [Symbol.hasInstance](value) {
    return isDecisionError(value);
  }
  /** The serializable form. Never throws. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...this.subject === void 0 ? {} : { subject: this.subject },
      ...this.details === void 0 ? {} : { details: this.details }
    };
  }
};
function isDecisionError(value) {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value;
  if (candidate.brand === DECISION_ERROR_BRAND) return true;
  return candidate.name === "DecisionError" && typeof candidate.code === "string";
}

// src/environments/types.ts
function okObservation(source, state, extra) {
  return { status: "ok", source, state, ...extra };
}
function failedObservation(source, status, reason, extra) {
  return { status, source, reason, ...extra };
}

// src/environments/dispatch.ts
function requireDispatcher(dispatcher, environmentId) {
  if (dispatcher === void 0) {
    throw new DecisionError("environment_unavailable", `Environment "${environmentId}" has no tool dispatcher wired in this deployment.`, {
      subject: environmentId,
      details: { hint: "The decision-engine plugin wires it automatically; a hand-built adapter needs one passed in." }
    });
  }
  return dispatcher;
}

// src/environments/browser/snapshot.ts
var ITEM_RE = /^\s*\[(\d+)]\s+(\S+)\s+"((?:[^"\\]|\\.)*)"\s*(?:\[([^\]]*)])?\s*(?:→\s*(.*))?$/;
var FORM_RE = /^\s*\[(\d+)]\s+(?:(.*?)\s+\(([^()]*)\)\s+)?(value="(.*)"|checked=(true|false))\s*(required)?\s*$/;
var SECTION_LABELS = [
  "Changed interactive elements",
  "Changed main content",
  "Changed form fields",
  "Interactive elements",
  "Main content",
  "Form fields",
  "Removed elements",
  "Title",
  "URL",
  "Status"
];
var SECTION_RE = new RegExp(`^(${SECTION_LABELS.join("|")}):(?:\\s+(.*))?$`);
var PAGE_CHANGE_RE = /^Page change[^:]*?(?:\((.*)\))?\s*$/;
function unescapeName(value) {
  return value.replace(/\\(.)/g, "$1");
}
function parseBrowserSnapshot(text) {
  const snapshot = {
    reindexed: false,
    main: "",
    items: [],
    forms: [],
    unparsed: [],
    canvasLike: false,
    mainChars: 0
  };
  if (typeof text !== "string" || text.trim() === "") return snapshot;
  const lines = text.split("\n");
  let section = "header";
  const mainLines = [];
  for (const line of lines) {
    const pageChange = PAGE_CHANGE_RE.exec(line);
    if (pageChange !== null && line.startsWith("Page change")) {
      const url = pageChange[1];
      if (url !== void 0 && url !== "") snapshot.url = url;
      section = "header";
      continue;
    }
    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch !== null) {
      const label = sectionMatch[1] ?? "";
      const rest = (sectionMatch[2] ?? "").trim();
      if (label === "Title") {
        if (rest !== "") snapshot.title = rest;
        section = "header";
        continue;
      }
      if (label === "URL") {
        if (rest !== "") snapshot.url = rest;
        section = "header";
        continue;
      }
      if (label === "Status") {
        if (rest !== "") snapshot.status = rest;
        if (rest.includes("reassigned")) snapshot.reindexed = true;
        section = "header";
        continue;
      }
      if (label.startsWith("Page change")) {
        const url = PAGE_CHANGE_RE.exec(label)?.[1];
        if (url !== void 0 && url !== "") snapshot.url = url;
        section = "header";
        continue;
      }
      if (label === "Main content" || label === "Changed main content") {
        if (rest !== "") mainLines.push(rest);
        section = "main";
        continue;
      }
      if (label === "Interactive elements" || label === "Changed interactive elements") {
        section = "items";
        continue;
      }
      if (label === "Form fields" || label === "Changed form fields") {
        section = "forms";
        continue;
      }
      if (label === "Removed elements") {
        section = "other";
        continue;
      }
      section = "other";
      continue;
    }
    if (line.trim() === "") {
      if (section === "main") mainLines.push("");
      continue;
    }
    if (section === "items") {
      const item = parseItem(line);
      if (item === void 0) snapshot.unparsed.push(line);
      else snapshot.items.push(item);
      continue;
    }
    if (section === "forms") {
      const form = parseForm(line);
      if (form === void 0) snapshot.unparsed.push(line);
      else snapshot.forms.push(form);
      continue;
    }
    if (section === "main") {
      mainLines.push(line);
      continue;
    }
    if (line.startsWith("(") && line.includes(")")) continue;
    snapshot.unparsed.push(line);
  }
  snapshot.main = mainLines.join("\n").trim();
  snapshot.mainChars = snapshot.main.length;
  snapshot.canvasLike = looksCanvasLike(snapshot);
  return snapshot;
}
function looksCanvasLike(snapshot) {
  if (snapshot.items.length + snapshot.forms.length > 0) return false;
  const probe = `${snapshot.main}
${snapshot.unparsed.join("\n")}`;
  if (/<canvas|webgl|three\.js|video (element|player)/i.test(probe)) return true;
  return snapshot.mainChars === 0;
}
function parseItem(line) {
  const match = ITEM_RE.exec(line);
  if (match === null) return void 0;
  const index = Number(match[1]);
  if (!Number.isInteger(index)) return void 0;
  const role = match[2] ?? "";
  const name = unescapeName(match[3] ?? "");
  const state = match[4] ?? "";
  const href = match[5];
  const item = {
    index,
    role,
    name,
    disabled: state.includes("disabled"),
    outsideViewport: state.includes("outside viewport")
  };
  if (state.includes("checked")) item.checked = true;
  else if (state.includes("unchecked")) item.checked = false;
  if (href !== void 0 && href.trim() !== "") item.href = href.trim();
  return item;
}
function parseForm(line) {
  const match = FORM_RE.exec(line);
  if (match === null) return void 0;
  const index = Number(match[1]);
  if (!Number.isInteger(index)) return void 0;
  const label = match[2];
  const kind = match[3];
  const valueRaw = match[5];
  const checkedRaw = match[6];
  const field = {
    index,
    masked: valueRaw !== void 0 && valueRaw.includes("\u2022\u2022"),
    required: (match[7] ?? "").includes("required")
  };
  if (label !== void 0 && label.trim() !== "") field.label = label.trim();
  if (kind !== void 0 && kind.trim() !== "") field.kind = kind.trim();
  if (valueRaw !== void 0) field.value = valueRaw;
  if (checkedRaw !== void 0) field.checked = checkedRaw === "true";
  return field;
}

// src/environments/browser/adapter.ts
var BROWSER_TOOLS = {
  snapshot: "browser_snapshot",
  getText: "browser_get_text",
  click: "browser_click",
  type: "browser_type",
  press: "browser_press",
  scroll: "browser_scroll",
  navigate: "browser_navigate",
  wait: "browser_wait"
};
var DEFAULT_MAX_CANDIDATES = 12;
var DEFAULT_MAX_STATE_CHARS = 6e3;
var DEFAULT_MAX_OBJECTIVE_CHARS = 2e3;
var PRIMARY_ROLES = ["button", "link", "menuitem", "tab", "checkbox", "radio"];
var BrowserEnvironmentAdapter = class {
  id;
  source = "browser";
  capabilities = ["observe", "buildDecisionRequest", "mapDecision", "execute"];
  #dispatcher;
  #config;
  /** Candidate index for the observation the last request was built from. */
  #pendingCandidates = /* @__PURE__ */ new Map();
  constructor(options) {
    this.id = options.id ?? "browser";
    this.#dispatcher = options.dispatcher;
    const config = options.config ?? {};
    this.#config = {
      strategy: config.strategy ?? "form",
      candidates: config.candidates,
      maxCandidates: config.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
      maxStateChars: config.maxStateChars ?? DEFAULT_MAX_STATE_CHARS,
      maxObjectiveChars: config.maxObjectiveChars ?? DEFAULT_MAX_OBJECTIVE_CHARS,
      observeTimeoutMs: config.observeTimeoutMs ?? 9e4,
      executeTimeoutMs: config.executeTimeoutMs ?? 9e4
    };
  }
  /**
   * Read the page as structured text.
   *
   * A refused or failed snapshot becomes `unsupported`/`error`, never a guess:
   * the caller escalates instead of the adapter inventing state.
   */
  async observe(input) {
    void input;
    const result = await this.#dispatcher.call({
      name: BROWSER_TOOLS.snapshot,
      arguments: {},
      ...input?.signal === void 0 ? {} : { signal: input.signal }
    });
    if (!result.ok) {
      const message = result.error ?? "browser_snapshot failed.";
      return failedObservation("browser", "unsupported", message, {
        metadata: { tool: BROWSER_TOOLS.snapshot, hint: "Authorize the browser capability for this session (/browser) and retry." }
      });
    }
    const snapshot = parseBrowserSnapshot(result.text);
    return this.#observationFrom(snapshot, result.text.length);
  }
  /**
   * Build the decision request from a browser snapshot.
   *
   * The state handed to the provider is a *structured digest* — url, title, the
   * interactive inventory, the form inventory, and a bounded slice of page
   * text — so a provider reads structure rather than re-parsing prose. Page
   * text is treated as untrusted data and is explicitly labelled as such.
   */
  buildDecisionRequest(observation, objective) {
    if (observation.status !== "ok") {
      throw new DecisionError("insufficient_observation", `Cannot build a decision request from a ${observation.status} observation.`, {
        subject: this.id,
        details: { reason: observation.reason }
      });
    }
    const snapshot = observation.state;
    const candidates = this.#candidatesFor(snapshot);
    if (candidates.length === 0) {
      throw new DecisionError("no_candidates", "The page offers no addressable action for this objective.", {
        subject: this.id,
        details: { url: snapshot.url, strategy: this.#config.strategy }
      });
    }
    this.#pendingCandidates = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const state = {
      url: snapshot.url ?? "",
      title: snapshot.title ?? "",
      status: snapshot.status ?? "",
      pageTextUntrusted: truncate(snapshot.main, this.#config.maxStateChars),
      interactive: snapshot.items.map((item) => ({
        index: item.index,
        role: item.role,
        name: item.name,
        ...item.disabled ? { disabled: true } : {},
        ...item.checked === void 0 ? {} : { checked: item.checked },
        ...item.href === void 0 ? {} : { href: item.href }
      })),
      formFields: snapshot.forms.map((field) => ({
        index: field.index,
        ...field.label === void 0 ? {} : { label: field.label },
        ...field.kind === void 0 ? {} : { kind: field.kind },
        ...field.value === void 0 ? {} : { value: field.masked ? "(masked)" : field.value },
        ...field.checked === void 0 ? {} : { checked: field.checked },
        ...field.required ? { required: true } : {}
      }))
    };
    return {
      objective: truncate(objective.description, this.#config.maxObjectiveChars),
      state,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        description: candidate.description,
        ...candidate.metadata === void 0 ? {} : { metadata: candidate.metadata }
      })),
      ...objective.constraints === void 0 ? {} : { constraints: objective.constraints },
      mode: "choice",
      metadata: { environment: this.id, url: snapshot.url ?? "" }
    };
  }
  /**
   * Map a chosen candidate id to a browser action.
   *
   * @throws DecisionError with `unknown_candidate` when the id is not one this
   *   adapter offered for the observation the request was built from.
   */
  mapDecision(result, observation) {
    const selected = result.selected;
    if (selected === void 0) {
      throw new DecisionError("invalid_decision", `Provider "${result.provider}" returned no selection.`, { subject: result.provider });
    }
    const candidate = this.#pendingCandidates.get(selected) ?? this.#recoverCandidate(observation, selected);
    if (candidate === void 0) {
      throw new DecisionError("unknown_candidate", `Decision "${selected}" does not map to a browser action.`, {
        subject: this.id,
        details: { selected, offered: [...this.#pendingCandidates.keys()] }
      });
    }
    return this.#actionFrom(candidate);
  }
  /** Execute a mapped action through the browser tool set. */
  async execute(action, input) {
    const payload = action.payload ?? {};
    const signal = input?.signal;
    const target = action.target;
    switch (action.kind) {
      case "click": {
        if (typeof target !== "number") {
          throw new DecisionError("action_mapping_failed", `click requires a numeric snapshot index; got ${String(target)}.`, { subject: this.id });
        }
        const result = await this.#dispatcher.call({
          name: BROWSER_TOOLS.click,
          arguments: { index: target },
          ...signal === void 0 ? {} : { signal }
        });
        return outcome(result, "click failed");
      }
      case "type": {
        if (typeof target !== "number") {
          throw new DecisionError("action_mapping_failed", `type requires a numeric field index; got ${String(target)}.`, { subject: this.id });
        }
        const text = typeof payload.text === "string" ? payload.text : "";
        const result = await this.#dispatcher.call({
          name: BROWSER_TOOLS.type,
          arguments: { index: target, text, ...payload.replace === true ? { replace: true } : {} },
          ...signal === void 0 ? {} : { signal }
        });
        return outcome(result, "type failed");
      }
      case "press": {
        const key = typeof target === "string" ? target : "Enter";
        const result = await this.#dispatcher.call({
          name: BROWSER_TOOLS.press,
          arguments: { key },
          ...signal === void 0 ? {} : { signal }
        });
        return outcome(result, "press failed");
      }
      case "scroll": {
        const direction = typeof target === "string" ? target : "down";
        const result = await this.#dispatcher.call({
          name: BROWSER_TOOLS.scroll,
          arguments: { direction, ...typeof payload.amount === "number" ? { amount: payload.amount } : {} },
          ...signal === void 0 ? {} : { signal }
        });
        return outcome(result, "scroll failed");
      }
      case "navigate": {
        if (typeof target !== "string") {
          throw new DecisionError("action_mapping_failed", `navigate requires a url string; got ${String(target)}.`, { subject: this.id });
        }
        const result = await this.#dispatcher.call({
          name: BROWSER_TOOLS.navigate,
          arguments: { url: target },
          ...signal === void 0 ? {} : { signal }
        });
        return outcome(result, "navigate failed");
      }
      case "wait": {
        const ms = typeof payload.ms === "number" ? payload.ms : 500;
        const result = await this.#dispatcher.call({
          name: BROWSER_TOOLS.wait,
          arguments: { ms },
          ...signal === void 0 ? {} : { signal }
        });
        return outcome(result, "wait failed");
      }
      default:
        throw new DecisionError("action_mapping_failed", `Unsupported browser action kind "${action.kind}".`, { subject: this.id });
    }
  }
  /** The tool names this adapter needs visible in the session. */
  requiredTools() {
    return Object.values(BROWSER_TOOLS);
  }
  /** Assert the dispatcher is present, with a typed error. */
  assertWired() {
    requireDispatcher(this.#dispatcher, this.id);
  }
  #observationFrom(snapshot, textChars) {
    const addressable = snapshot.items.length + snapshot.forms.length;
    if (addressable === 0 && snapshot.mainChars === 0) {
      return failedObservation("browser", "insufficient", "The snapshot contained no readable text and no interactive elements.", {
        metadata: { url: snapshot.url, textChars, unparsed: snapshot.unparsed.slice(0, 5) }
      });
    }
    if (looksCanvasLike(snapshot)) {
      return failedObservation("browser", "unsupported", "The page exposes no structured state (canvas/WebGL/video only, or an effectively empty DOM).", {
        metadata: { url: snapshot.url, textChars, addressable }
      });
    }
    if (snapshot.unparsed.length > snapshot.items.length + snapshot.forms.length) {
      return failedObservation("browser", "insufficient", "Most snapshot lines could not be parsed, so the page structure is not trustworthy.", {
        metadata: { url: snapshot.url, unparsed: snapshot.unparsed.slice(0, 5) }
      });
    }
    return okObservation("browser", snapshot, {
      summary: summarize(snapshot),
      metadata: {
        ...snapshot.url === void 0 ? {} : { url: snapshot.url },
        itemCount: snapshot.items.length,
        formCount: snapshot.forms.length,
        reindexed: snapshot.reindexed,
        ...snapshot.mainChars > this.#config.maxStateChars ? { pageTextTruncated: true } : {}
      }
    });
  }
  /**
   * Derive the finite candidate set. In `form` strategy the page's own
   * controls become candidates; each candidate carries the exact action it
   * performs, so mapping is total by construction.
   */
  #candidatesFor(snapshot) {
    if (this.#config.strategy === "patch") {
      const patched = this.#config.candidates ?? [];
      return patched.slice(0, this.#config.maxCandidates);
    }
    const candidates = [];
    const seen = /* @__PURE__ */ new Set();
    const push = (candidate) => {
      if (candidates.length >= this.#config.maxCandidates) return;
      if (seen.has(candidate.id)) return;
      seen.add(candidate.id);
      candidates.push(candidate);
    };
    const items = [...snapshot.items].sort((left, right) => {
      const leftPrimary = PRIMARY_ROLES.includes(left.role) ? 0 : 1;
      const rightPrimary = PRIMARY_ROLES.includes(right.role) ? 0 : 1;
      if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;
      if (left.disabled !== right.disabled) return left.disabled ? 1 : -1;
      return left.index - right.index;
    });
    for (const item of items) {
      if (item.disabled) continue;
      const role = item.role.toLowerCase();
      if (!PRIMARY_ROLES.includes(role)) continue;
      const label = item.name === "" ? `element ${item.index}` : item.name;
      if (role === "checkbox" || role === "radio") {
        push({
          id: `set-${slug(label)}-${item.index}`,
          description: `${item.checked === true ? "Uncheck" : "Check"} "${label}"`,
          action: { kind: "click", target: item.index },
          metadata: { role, index: item.index }
        });
        continue;
      }
      push({
        id: `click-${slug(label)}-${item.index}`,
        description: `${role === "link" ? "Follow" : "Activate"} "${label}"${item.href === void 0 ? "" : ` (${item.href})`}`,
        action: { kind: "click", target: item.index },
        metadata: { role, index: item.index, ...item.href === void 0 ? {} : { href: item.href } }
      });
    }
    for (const field of snapshot.forms) {
      const label = field.label ?? `field ${field.index}`;
      if (field.checked !== void 0) continue;
      if (field.value !== void 0 && field.value !== "" && field.masked !== true) {
        push({
          id: `clear-${slug(label)}-${field.index}`,
          description: `Clear the "${label}" field`,
          action: { kind: "type", target: field.index, text: "", replace: true },
          metadata: { role: "field", index: field.index }
        });
        continue;
      }
      push({
        id: `focus-${slug(label)}-${field.index}`,
        description: `Focus the "${label}" field`,
        action: { kind: "click", target: field.index },
        metadata: { role: "field", index: field.index }
      });
    }
    if (snapshot.status === "loading" && (snapshot.items.length > 0 || snapshot.forms.length > 0)) {
      push({ id: "wait", description: "Wait for the page to change", action: { kind: "wait", target: "wait" } });
    }
    return candidates;
  }
  /** Recover an action candidate from a fresh parse, for a request built by another instance/call. */
  #recoverCandidate(observation, selected) {
    if (observation.status !== "ok") return void 0;
    const snapshot = observation.state;
    return this.#candidatesFor(snapshot).find((candidate) => candidate.id === selected);
  }
  #actionFrom(candidate) {
    const action = {
      kind: candidate.action.kind,
      candidateId: candidate.id,
      description: candidate.description
    };
    if (candidate.action.target !== void 0) action.target = candidate.action.target;
    const payload = {};
    if (candidate.action.text !== void 0) payload.text = candidate.action.text;
    if (candidate.action.replace !== void 0) payload.replace = candidate.action.replace;
    if (Object.keys(payload).length > 0) action.payload = payload;
    if (candidate.action.risky === true) action.risky = true;
    return action;
  }
};
function selectionOrder(ranking, selected) {
  const ids = (ranking ?? []).map((entry) => entry.id);
  return ids.includes(selected) ? ids : [selected, ...ids];
}
function summarize(snapshot) {
  const parts = [];
  if (snapshot.title !== void 0 && snapshot.title !== "") parts.push(snapshot.title);
  if (snapshot.url !== void 0 && snapshot.url !== "") parts.push(snapshot.url);
  parts.push(`${snapshot.items.length} interactive element(s)`);
  if (snapshot.forms.length > 0) parts.push(`${snapshot.forms.length} form field(s)`);
  if (snapshot.reindexed) parts.push("indices reassigned");
  return parts.join(" \xB7 ");
}
function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit)}\u2026[truncated]`;
}
function slug(value) {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "item" : cleaned.slice(0, 32);
}
function firstLine(value) {
  const line = value.split("\n").map((part) => part.trim()).find((part) => part !== "");
  return line === void 0 ? void 0 : line.slice(0, 200);
}
function outcome(result, fallback) {
  if (result.ok) return { ok: true, message: firstLine(result.text) ?? "ok" };
  return { ok: false, message: result.error ?? fallback };
}
export {
  BROWSER_TOOLS,
  BrowserEnvironmentAdapter,
  selectionOrder
};
