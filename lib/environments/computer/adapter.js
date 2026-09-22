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

// src/environments/computer/ax-tree.ts
var ROLE_VOCABULARY = [
  "progress indicator",
  "disclosure triangle",
  "text entry area",
  "standard window",
  "radio button",
  "pop up button",
  "dialog window",
  "color well",
  "menu button",
  "split group",
  "scroll area",
  "static text",
  "menu item",
  "text field",
  "tab group",
  "checkbox",
  "toolbar",
  "outline",
  "slider",
  "column",
  "window",
  "button",
  "splitter",
  "heading",
  "element",
  "image",
  "table",
  "link",
  "list",
  "cell",
  "row"
].sort((left, right) => right.length - left.length);
var NODE_LINE_RE = /^(\t*)([+-]?)\s*(\d+)\s+(.*)$/;
var APP_HEADER_RE = /^App=(\S+)(?:\s+\(pid\s+\d+\))?/;
var WINDOW_HEADER_RE = /^Window:\s*"((?:[^"\\]|\\.)*)"/;
var FIELD_START_RE = /\s+(?:Description|Value|Help|ID|Secondary Actions):\s/;
var DESCRIPTION_RE = /Description:\s*(.*)$/;
var VALUE_RE = /Value:\s*(.*)$/;
var ID_RE = /(?:^|\s)ID:\s*(\S+)/;
var HELP_RE = /Help:\s*(.*)$/;
var SECONDARY_RE = /Secondary Actions:\s*(.*)$/;
var DIFF_HEADER = "The following is a diff from the previous accessibility tree";
var CUMULATIVE_DIFF_HEADER = "The following is a cumulative diff from the initial accessibility tree";
var UNCHANGED_TEXT = "There has been no change in the accessibility tree for the previous capture.";
var TRUNCATION_MARK = "(element limit reached; the tree is incomplete)";
var DIFF_LINE_RE = /^(?:\t*)([+~-])\s+\d+\s/;
var TRUNCATION_MARKER = new RegExp(`accessibility tree truncated|truncated at|\u2026\\(truncated|${TRUNCATION_MARK.replace(/[()]/g, "\\$&")}`, "i");
var PRESSABLE_ROLES = /* @__PURE__ */ new Set([
  "button",
  "pop up button",
  "menu button",
  "menu item",
  "checkbox",
  "radio button",
  "link",
  "disclosure triangle",
  "color well",
  "slider",
  "row",
  "cell",
  "image"
]);
var PASSIVE_ROLES = /* @__PURE__ */ new Set([
  "standard window",
  "window",
  "dialog window",
  "split group",
  "scroll area",
  "outline",
  "toolbar",
  "table",
  "list",
  "column",
  "splitter",
  "heading",
  "static text",
  "progress indicator",
  "element"
]);
function parseAxTree(text, truncated = false) {
  const capture = {
    kind: "full",
    nodes: [],
    unparsed: [],
    truncated: truncated || TRUNCATION_MARKER.test(text ?? "")
  };
  if (typeof text !== "string" || text === "") return capture;
  let diffSignals = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const trimmed = line.trim();
    if (trimmed.includes(CUMULATIVE_DIFF_HEADER) || trimmed.includes(DIFF_HEADER)) {
      capture.kind = "diff";
      continue;
    }
    if (trimmed.includes(UNCHANGED_TEXT)) {
      capture.kind = "diff";
      continue;
    }
    if (trimmed.startsWith("Removed element IDs:")) {
      diffSignals += 1;
      capture.unparsed.push(trimmed);
      continue;
    }
    const appHeader = APP_HEADER_RE.exec(line);
    if (appHeader?.[1] !== void 0) {
      capture.app = appHeader[1];
      continue;
    }
    const windowHeader = WINDOW_HEADER_RE.exec(line);
    if (windowHeader?.[1] !== void 0) {
      capture.window = windowHeader[1].replace(/\\(.)/g, "$1");
      continue;
    }
    const diffLine = DIFF_LINE_RE.exec(line);
    const diffMarker = diffLine?.[1] ?? "";
    if (diffMarker !== "") diffSignals += 1;
    const stripped = diffMarker === "" ? line : line.replace(/(\t*)[+~-]\s+/, "$1");
    const match = NODE_LINE_RE.exec(stripped);
    if (match === null) {
      capture.unparsed.push(line);
      continue;
    }
    const indent = match[1] ?? "";
    const marker = diffMarker === "~" ? "" : diffMarker === "" ? match[2] ?? "" : diffMarker;
    const index = Number(match[3]);
    const descriptor = (match[4] ?? "").trim();
    if (!Number.isInteger(index) || descriptor === "") {
      capture.unparsed.push(line);
      continue;
    }
    capture.nodes.push(parseDescriptor(index, descriptor, indent.length, marker, line));
  }
  if (diffSignals > 0) capture.kind = "diff";
  return capture;
}
function mergeAxDiff(previous, diff) {
  if (diff.kind !== "diff") return diff.nodes;
  const removed = /* @__PURE__ */ new Set();
  for (const node of diff.nodes) {
    if (node.removed) removed.add(node.index);
  }
  for (const line of diff.unparsed) {
    const match = /Removed element IDs:\s*(.*)$/.exec(line);
    if (match?.[1] === void 0) continue;
    for (const part of match[1].split(/,\s*/)) {
      const range = /^(\d+)\s*[–-]\s*(\d+)$/.exec(part.trim());
      if (range?.[1] !== void 0 && range[2] !== void 0) {
        for (let index = Number(range[1]); index <= Number(range[2]); index += 1) removed.add(index);
        continue;
      }
      const single = Number(part.trim());
      if (Number.isInteger(single)) removed.add(single);
    }
  }
  const merged = /* @__PURE__ */ new Map();
  for (const node of previous.nodes) {
    if (removed.has(node.index)) continue;
    merged.set(node.index, node);
  }
  let changed = false;
  for (const node of diff.nodes) {
    if (removed.has(node.index)) continue;
    const existing = merged.get(node.index);
    if (existing === void 0 || existing.raw !== node.raw) changed = true;
    merged.set(node.index, { ...node, added: false, removed: false });
  }
  if (!changed && diff.nodes.length === 0 && removed.size === 0) return void 0;
  return [...merged.values()].sort((left, right) => left.index - right.index);
}
function parseDescriptor(index, descriptor, depth, marker, raw) {
  const trimmed = descriptor.trim();
  const fieldStart = FIELD_START_RE.exec(trimmed);
  const head = (fieldStart === null ? trimmed : trimmed.slice(0, fieldStart.index)).trim();
  const { role, title } = splitRoleAndTitle(head);
  const valueMatch = VALUE_RE.exec(trimmed);
  let value;
  let traits = [];
  if (valueMatch !== null) {
    const span = boundFreeText(valueMatch[1] ?? "", "Value");
    const traitBlock = /\(([^()]*)\)\s*$/.exec(span);
    const inside = traitBlock?.[1]?.split(",").map((part) => part.trim()).filter((part) => part !== "") ?? [];
    const isTraitBlock = inside.some((part) => part === "disabled" || part === "settable") || inside.length >= 2 && /^(?:string|number|float|boolean)$/.test(inside[inside.length - 1] ?? "");
    if (traitBlock !== null && isTraitBlock) {
      traits = inside;
      value = span.slice(0, span.length - (traitBlock[0]?.length ?? 0)).trim();
    } else {
      value = span;
    }
  }
  const descriptionMatch = DESCRIPTION_RE.exec(trimmed);
  const description = descriptionMatch === null ? void 0 : boundFreeText(descriptionMatch[1] ?? "", "Description");
  const disabled = traits.includes("disabled") || /\(\s*disabled\s*\)/.test(trimmed);
  const settable = traits.includes("settable");
  const node = {
    index,
    role,
    secondaryActions: splitSecondaryActions(SECONDARY_RE.exec(trimmed)?.[1]),
    disabled,
    settable,
    depth,
    added: marker === "+",
    removed: marker === "-",
    raw
  };
  if (title !== void 0) node.title = title;
  if (description !== void 0 && description !== "") node.description = description;
  if (value !== void 0 && value !== "") node.value = value;
  const identifier = ID_RE.exec(trimmed)?.[1];
  if (identifier !== void 0) node.identifier = identifier;
  const help = helpOf(trimmed);
  if (help !== void 0) node.help = help;
  return node;
}
function splitRoleAndTitle(head) {
  const lower = head.toLowerCase();
  for (const role of ROLE_VOCABULARY) {
    if (lower === role) return { role };
    if (lower.startsWith(`${role} `)) {
      const title = head.slice(role.length).trim();
      return title === "" ? { role } : { role, title };
    }
  }
  const words = head.split(" ");
  const first = words[0] ?? head;
  const rest = words.slice(1).join(" ").trim();
  return rest === "" ? { role: first.toLowerCase() } : { role: first.toLowerCase(), title: rest };
}
function splitSecondaryActions(value) {
  if (value === void 0) return [];
  return value.split(/,\s*/).map((part) => part.trim()).filter((part) => part !== "" && !/^(?:ID|Help|Value|Description):/i.test(part));
}
function helpOf(descriptor) {
  const match = HELP_RE.exec(descriptor);
  if (match?.[1] === void 0) return void 0;
  const text = boundFreeText(match[1], "Help");
  return text === "" ? void 0 : text;
}
function boundFreeText(text, ownField) {
  const marker = new RegExp(`\\s+(?:(?!${ownField}\\b)[A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)*):\\s`);
  const cut = text.search(marker);
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}
function isAddressable(node) {
  if (node.removed || node.disabled) return false;
  if (node.settable) return true;
  if (node.secondaryActions.length > 0) return true;
  return PRESSABLE_ROLES.has(node.role);
}
function isSettable(node) {
  return !node.removed && node.settable;
}
function isPassive(node) {
  return PASSIVE_ROLES.has(node.role) && !node.settable && node.secondaryActions.length === 0;
}
function labelOf(node) {
  for (const candidate of [node.title, node.description, node.value, node.identifier]) {
    if (candidate !== void 0 && candidate.trim() !== "") return candidate.trim();
  }
  return `${node.role} ${node.index}`;
}

// src/environments/computer/adapter.ts
var COMPUTER_TOOLS = {
  listApps: "computer_use_list_apps",
  getAppState: "computer_use_get_app_state",
  click: "computer_use_click",
  typeText: "computer_use_type_text",
  pressKey: "computer_use_press_key",
  scroll: "computer_use_scroll",
  setValue: "computer_use_set_value",
  selectText: "computer_use_select_text"
};
var DEFAULT_MAX_CANDIDATES = 12;
var DEFAULT_MAX_STATE_CHARS = 8e3;
async function withDeadline(work, ms, message) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
var ComputerEnvironmentAdapter = class {
  id;
  source = "computer";
  capabilities = ["observe", "buildDecisionRequest", "mapDecision", "execute"];
  #seam;
  #dispatcher;
  #config;
  #pendingCandidates = /* @__PURE__ */ new Map();
  #pendingApp;
  /**
   * The last full capture per app, so a diff the provider returns can be
   * overlaid onto it. The documented `ctx.computer` contract returns a diff for
   * every capture after the first, and a diff alone cannot yield a candidate
   * set — but previous-plus-diff can, exactly as the provider intends.
   */
  #lastFullCapture = /* @__PURE__ */ new Map();
  constructor(options) {
    this.id = options.id ?? "computer";
    this.#seam = options.seam;
    this.#dispatcher = options.dispatcher;
    const config = options.config ?? {};
    this.#config = {
      app: config.app,
      candidates: config.candidates,
      listAppsInObservation: config.listAppsInObservation ?? false,
      maxCandidates: config.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
      maxStateChars: config.maxStateChars ?? DEFAULT_MAX_STATE_CHARS,
      maxTreeNodes: config.maxTreeNodes ?? 1200,
      captureTimeoutMs: config.captureTimeoutMs ?? 3e4
    };
  }
  /** Whether the in-process seam is available. */
  get hasSeam() {
    return this.#seam !== void 0;
  }
  /** The app this adapter targets, once configured. */
  get app() {
    return this.#config.app;
  }
  /**
   * Capture the target app's accessibility tree.
   *
   * A missing app target, a refused capture, or an unreadable tree becomes a
   * non-`ok` observation: an AX tree that only contains anonymous groups
   * cannot express a task, and this adapter says so instead of guessing.
   */
  async observe(input) {
    const app = this.#config.app;
    if (app === void 0 || app === "") {
      return failedObservation("computer", "insufficient", "No target app is configured for the computer environment.", {
        metadata: { hint: "Pass app in the environment config, or list apps and choose one first." }
      });
    }
    const capture = await this.#capture(app, input?.signal);
    if (!capture.ok) {
      return failedObservation("computer", "unsupported", capture.error, {
        metadata: { app, hint: "Authorize the computer capability for this session (/computer-use) and retry." }
      });
    }
    this.#pendingApp = capture.app;
    const parsed = parseAxTree(capture.text, capture.truncated);
    const ax = this.#resolveCapture(capture.app, parsed);
    if (ax === void 0) {
      return failedObservation(
        "computer",
        "insufficient",
        "The provider returned a diff and no full capture of this app is available to reconstruct the tree from.",
        {
          metadata: {
            app: capture.app,
            hint: "Capture once with disableDiff, or capture the same app twice so the second capture can be merged."
          }
        }
      );
    }
    return this.#observationFrom(capture.app, ax, capture.text);
  }
  /** Apps the desktop exposes, for choosing a target. */
  async listApps() {
    if (this.#seam !== void 0) {
      try {
        const value = await this.#seam.listApps({});
        return { ok: true, text: typeof value === "string" ? value : JSON.stringify(value) };
      } catch (error) {
        return { ok: false, text: error instanceof Error ? error.message : String(error) };
      }
    }
    const dispatcher = requireDispatcher(this.#dispatcher, this.id);
    const result = await dispatcher.call({ name: COMPUTER_TOOLS.listApps, arguments: {} });
    return { ok: result.ok, text: result.ok ? result.text : result.error ?? "" };
  }
  /**
   * Build the decision request from an AX capture.
   *
   * The state is a structured digest: the app id, the capture kind (full vs
   * diff), and the nodes with their roles, names, and depths. The rendered
   * tree text is included only as a bounded, explicitly-untrusted transcript.
   */
  buildDecisionRequest(observation, objective) {
    if (observation.status !== "ok") {
      throw new DecisionError("insufficient_observation", `Cannot build a decision request from a ${observation.status} observation.`, {
        subject: this.id,
        details: { reason: observation.reason }
      });
    }
    const state = observation.state;
    const candidates = this.#candidatesFor(state.ax);
    if (candidates.length === 0) {
      throw new DecisionError("no_candidates", "The accessibility tree offers no addressable action for this objective.", {
        subject: this.id,
        details: { app: state.app, nodeCount: state.ax.nodes.length }
      });
    }
    this.#pendingCandidates = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    return {
      objective: objective.description,
      state: {
        app: state.app,
        captureKind: state.ax.kind,
        window: state.ax.window ?? null,
        nodes: state.ax.nodes.filter((node) => !node.removed).map((node) => ({
          index: node.index,
          role: node.role,
          label: labelOf(node),
          depth: node.depth,
          ...node.value === void 0 ? {} : { value: node.value },
          ...node.disabled ? { disabled: true } : {},
          ...node.settable ? { settable: true } : {},
          ...node.secondaryActions.length === 0 ? {} : { secondaryActions: node.secondaryActions }
        })),
        truncated: state.ax.truncated,
        treeTextUntrusted: truncate(state.text, this.#config.maxStateChars)
      },
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        description: candidate.description,
        ...candidate.metadata === void 0 ? {} : { metadata: candidate.metadata }
      })),
      ...objective.constraints === void 0 ? {} : { constraints: objective.constraints },
      mode: "choice",
      metadata: { environment: this.id, app: state.app }
    };
  }
  /** Map a chosen candidate id to a desktop action. */
  mapDecision(result, observation) {
    const selected = result.selected;
    if (selected === void 0) {
      throw new DecisionError("invalid_decision", `Provider "${result.provider}" returned no selection.`, { subject: result.provider });
    }
    const candidate = this.#pendingCandidates.get(selected) ?? (observation.status === "ok" ? this.#candidatesFor(observation.state.ax).find((entry) => entry.id === selected) : void 0);
    if (candidate === void 0) {
      throw new DecisionError("unknown_candidate", `Decision "${selected}" does not map to a desktop action.`, {
        subject: this.id,
        details: { selected, offered: [...this.#pendingCandidates.keys()] }
      });
    }
    const action = {
      kind: candidate.action.kind,
      candidateId: candidate.id,
      description: candidate.description
    };
    if (candidate.action.elementIndex !== void 0) action.target = candidate.action.elementIndex;
    const payload = {};
    for (const key of ["value", "key", "direction", "text", "find"]) {
      const value = candidate.action[key];
      if (value !== void 0) payload[key] = value;
    }
    if (Object.keys(payload).length > 0) action.payload = payload;
    return action;
  }
  /** Execute a mapped desktop action. */
  async execute(action, input) {
    if (input?.signal?.aborted) throw new DecisionError("aborted", "The desktop action was cancelled.");
    const app = this.#pendingApp ?? this.#config.app;
    if (app === void 0) {
      throw new DecisionError("action_mapping_failed", "No target app is known; observe before executing an action.", { subject: this.id });
    }
    const elementIndex = typeof action.target === "number" ? action.target : void 0;
    const payload = action.payload ?? {};
    switch (action.kind) {
      case "click":
        return this.#invoke("click", { app, ...elementIndex === void 0 ? {} : { elementIndex } }, input);
      case "set_value": {
        if (elementIndex === void 0) {
          throw new DecisionError("action_mapping_failed", "set_value requires an element index.", { subject: this.id });
        }
        return this.#invoke("setValue", { app, elementIndex, value: String(payload.value ?? "") }, input);
      }
      case "press_key":
        return this.#invoke("pressKey", { app, key: String(payload.key ?? "Return") }, input);
      case "scroll": {
        if (elementIndex === void 0) {
          throw new DecisionError("action_mapping_failed", "scroll requires an element index.", { subject: this.id });
        }
        return this.#invoke("scroll", { app, elementIndex, direction: String(payload.direction ?? "down") }, input);
      }
      case "type_text":
        return this.#invoke("typeText", { app, text: String(payload.text ?? "") }, input);
      case "select_text": {
        if (elementIndex === void 0) {
          throw new DecisionError("action_mapping_failed", "select_text requires an element index.", { subject: this.id });
        }
        return this.#invoke("selectText", { app, elementIndex, text: String(payload.find ?? "") }, input);
      }
      default:
        throw new DecisionError("action_mapping_failed", `Unsupported computer action kind "${action.kind}".`, { subject: this.id });
    }
  }
  /** The tool names this adapter needs visible when it uses the tool path. */
  requiredTools() {
    return Object.values(COMPUTER_TOOLS);
  }
  async #capture(app, signal) {
    if (this.#seam !== void 0) {
      try {
        const request = {
          app,
          maxTreeNodes: this.#config.maxTreeNodes,
          ...signal === void 0 ? {} : { signal }
        };
        const spec = typeof this.#seam.resolve === "function" ? await this.#seam.resolve(request) : request;
        const state = await withDeadline(
          this.#seam.getAppState(spec),
          this.#config.captureTimeoutMs,
          `the accessibility capture of "${app}" did not answer within ${this.#config.captureTimeoutMs}ms`
        );
        if (state === void 0 || state === null) {
          return { ok: false, error: `the accessibility capture of "${app}" returned no state` };
        }
        return {
          ok: true,
          app: typeof state.app === "string" && state.app !== "" ? state.app : app,
          text: typeof state.text === "string" ? state.text : "",
          truncated: state.truncated === true
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (this.#dispatcher === void 0) {
      return { ok: false, error: `Environment "${this.id}" has neither the ctx.computer seam nor a tool dispatcher.` };
    }
    const result = await this.#dispatcher.call({
      name: COMPUTER_TOOLS.getAppState,
      arguments: { app, max_tree_nodes: this.#config.maxTreeNodes, disable_diff: true },
      ...signal === void 0 ? {} : { signal }
    });
    if (!result.ok) return { ok: false, error: result.error ?? "computer_use_get_app_state failed." };
    return { ok: true, app, text: result.text, truncated: /truncated/i.test(result.text) };
  }
  async #invoke(operation, args, input) {
    if (this.#seam !== void 0) {
      args = { ...args, ...input?.signal === void 0 ? {} : { signal: input.signal }, ...input?.timeoutMs === void 0 ? {} : { timeoutMs: input.timeoutMs } };
      const method = this.#seam[operation];
      if (typeof method !== "function") {
        throw new DecisionError("environment_unavailable", `The mounted computer seam does not implement ${operation}().`, { subject: this.id });
      }
      try {
        const spec = typeof this.#seam.resolve === "function" ? await this.#seam.resolve(args) : args;
        const value = await method.call(this.#seam, spec);
        return { ok: true, ...typeof value === "string" && value !== "" ? { message: value.slice(0, 200) } : {} };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
    const dispatcher = requireDispatcher(this.#dispatcher, this.id);
    const toolName = operation === "setValue" ? COMPUTER_TOOLS.setValue : operation === "pressKey" ? COMPUTER_TOOLS.pressKey : operation === "typeText" ? COMPUTER_TOOLS.typeText : operation === "selectText" ? COMPUTER_TOOLS.selectText : operation === "scroll" ? COMPUTER_TOOLS.scroll : COMPUTER_TOOLS.click;
    const toolArgs = { ...args };
    if ("elementIndex" in toolArgs) {
      toolArgs.element_index = toolArgs.elementIndex;
      delete toolArgs.elementIndex;
    }
    const result = await dispatcher.call({ name: toolName, arguments: toolArgs, ...input?.signal === void 0 ? {} : { signal: input.signal } });
    return result.ok ? { ok: true, ...firstLine(result.text) === void 0 ? {} : { message: firstLine(result.text) } } : { ok: false, message: result.error ?? `${toolName} failed` };
  }
  /**
   * Turn a parsed capture into a usable full tree.
   *
   * A full capture is stored as the merge base. A diff is overlaid onto it; a
   * diff that announces no change reuses the stored tree as-is.
   */
  #resolveCapture(app, parsed) {
    if (parsed.kind === "full") {
      this.#lastFullCapture.set(app, parsed);
      return parsed;
    }
    const base = this.#lastFullCapture.get(app);
    if (base === void 0) return void 0;
    const merged = mergeAxDiff(base, parsed);
    if (merged === void 0) return base;
    const next = { ...base, kind: "full", nodes: merged, unparsed: [] };
    const appId = parsed.app ?? base.app;
    if (appId !== void 0) next.app = appId;
    const window = parsed.window ?? base.window;
    if (window !== void 0) next.window = window;
    this.#lastFullCapture.set(app, next);
    return next;
  }
  #observationFrom(app, ax, text) {
    const live = ax.nodes.filter((node) => !node.removed);
    if (live.length === 0) {
      return failedObservation("computer", "insufficient", "The accessibility capture contained no elements.", {
        metadata: { app, textChars: text.length, unparsed: ax.unparsed.slice(0, 5) }
      });
    }
    const addressable = live.filter((node) => isAddressable(node));
    const named = live.filter((node) => labelOf(node) !== `${node.role} ${node.index}`);
    const groups = live.filter((node) => node.role === "group").length;
    if (addressable.length === 0) {
      if (groups >= live.length && live.length > 1) {
        return failedObservation("computer", "insufficient", "The accessibility tree exposes only anonymous groups, which cannot express the current task.", {
          metadata: { app, nodeCount: live.length, groupCount: groups }
        });
      }
      if (named.length === 0) {
        return failedObservation("computer", "insufficient", "The accessibility tree exposes no named or actionable elements.", {
          metadata: { app, nodeCount: live.length, unparsed: ax.unparsed.slice(0, 5) }
        });
      }
    }
    if (ax.kind === "diff") {
      return failedObservation("computer", "insufficient", "The provider returned a diff rather than a full tree, which cannot be used to build a candidate set.", {
        metadata: { app, hint: "Capture with disableDiff, or capture the same app twice so the diff can be merged onto the first capture." }
      });
    }
    return okObservation("computer", { app, ax, text }, {
      summary: `${app} \xB7 ${live.length} node(s) \xB7 ${addressable.length} actionable \xB7 ${named.length} named${ax.window === void 0 ? "" : ` \xB7 window "${ax.window}"`}`,
      metadata: {
        app,
        nodeCount: live.length,
        actionableCount: addressable.length,
        namedCount: named.length,
        truncated: ax.truncated,
        textChars: text.length
      }
    });
  }
  /**
   * Derive candidates from the tree.
   *
   * Element-addressed candidates carry their AX index, so the provider chooses
   * a *meaning* (`open the download`, `reveal in Finder`) and the index never
   * leaves this adapter.
   */
  #candidatesFor(ax) {
    if (this.#config.candidates !== void 0) return this.#config.candidates.slice(0, this.#config.maxCandidates);
    const candidates = [];
    const seen = /* @__PURE__ */ new Set();
    const push = (candidate) => {
      if (candidates.length >= this.#config.maxCandidates) return;
      if (seen.has(candidate.id)) return;
      seen.add(candidate.id);
      candidates.push(candidate);
    };
    for (const node of ax.nodes) {
      if (candidates.length >= this.#config.maxCandidates) break;
      if (node.removed || node.disabled) continue;
      const label = labelOf(node);
      if (isSettable(node)) {
        push({
          id: `set-${slug(label)}-${node.index}`,
          description: `Set the value of "${label}" (${node.role})`,
          action: { kind: "set_value", elementIndex: node.index, value: "" },
          metadata: { role: node.role, index: node.index, settable: true }
        });
        continue;
      }
      if (isAddressable(node)) {
        const actions = node.secondaryActions.length === 0 ? "" : ` \u2014 supports ${node.secondaryActions.join(", ")}`;
        push({
          id: `click-${slug(label)}-${node.index}`,
          description: `Click "${label}" (${node.role})${actions}`,
          action: { kind: "click", elementIndex: node.index },
          metadata: {
            role: node.role,
            index: node.index,
            ...node.secondaryActions.length === 0 ? {} : { secondaryActions: node.secondaryActions }
          }
        });
        continue;
      }
      if (isPassive(node)) continue;
    }
    return candidates;
  }
};
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
export {
  COMPUTER_TOOLS,
  ComputerEnvironmentAdapter
};
