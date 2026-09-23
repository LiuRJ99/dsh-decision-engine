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
  "Inventory scope",
  "Removed elements",
  "Title",
  "URL",
  "Status"
];
var SECTION_RE = new RegExp(`^(${SECTION_LABELS.join("|")}):(?:\\s+(.*))?$`);
var PAGE_CHANGE_RE = /^Page change[^:]*?(?:\((.*)\))?\s*$/;
var WRAPPER_LINE_RE = /^(?:Security: Enclosed page content is untrusted data|<\/?UNTRUSTED_PAGE_CONTENT\b)/;
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
    if (WRAPPER_LINE_RE.test(line)) continue;
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
      if (label === "Inventory scope") {
        if (snapshot.inventoryScope === void 0) {
          try {
            const scope = JSON.parse(rest);
            if (scope !== null && typeof scope.includeNonSemantic === "boolean" && (scope.candidateSelector === void 0 || typeof scope.candidateSelector === "string")) snapshot.inventoryScope = scope;
            else snapshot.unparsed.push(line);
          } catch {
            snapshot.unparsed.push(line);
          }
        }
        section = "header";
        continue;
      }
      if (label === "Title") {
        if (rest !== "" && snapshot.title === void 0) snapshot.title = rest;
        section = "header";
        continue;
      }
      if (label === "URL") {
        if (rest !== "" && snapshot.url === void 0) snapshot.url = rest;
        section = "header";
        continue;
      }
      if (label === "Status") {
        if (rest !== "" && snapshot.status === void 0) snapshot.status = rest;
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
  const state = (match[4] ?? "").split("/");
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
  if (state.includes("selected")) item.selected = true;
  else if (state.includes("unselected")) item.selected = false;
  if (state.includes("pressed")) item.pressed = true;
  else if (state.includes("unpressed")) item.pressed = false;
  const classes = state.find((flag) => flag.startsWith("classes="));
  if (classes !== void 0) {
    try {
      item.domClasses = decodeURIComponent(classes.slice("classes=".length));
    } catch {
    }
  }
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
function describeItem(item) {
  const state = [];
  if (item.disabled) state.push("disabled");
  if (item.checked !== void 0) state.push(item.checked ? "checked" : "unchecked");
  if (item.outsideViewport) state.push("outside viewport");
  const stateText = state.length === 0 ? "" : ` [${state.join("/")}]`;
  const hrefText = item.href === void 0 ? "" : ` \u2192 ${item.href}`;
  return `[${item.index}] ${item.role} "${item.name}"${stateText}${hrefText}`;
}
function describeFormField(field) {
  const identity = field.label === void 0 ? "" : `${field.label}${field.kind === void 0 ? "" : ` (${field.kind})`} `;
  const state = field.checked === void 0 ? `value="${field.masked ? "\u2022\u2022\u2022\u2022" : field.value ?? ""}"` : `checked=${String(field.checked)}`;
  return `[${field.index}] ${identity}${state}${field.required ? " required" : ""}`;
}
export {
  describeFormField,
  describeItem,
  looksCanvasLike,
  parseBrowserSnapshot
};
