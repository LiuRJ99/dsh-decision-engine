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
function describeAxNode(node) {
  return `[${node.index}] ${node.role}${node.title === void 0 ? "" : ` "${node.title}"`}`;
}
function humanActionLabel(actionName) {
  const base = actionName.startsWith("AX") ? actionName.slice(2) : actionName;
  let spaced = "";
  for (const character of base) {
    if (character >= "A" && character <= "Z" && spaced !== "") spaced += " ";
    spaced += character;
  }
  return spaced;
}
export {
  describeAxNode,
  humanActionLabel,
  isAddressable,
  isPassive,
  isSettable,
  labelOf,
  mergeAxDiff,
  parseAxTree
};
