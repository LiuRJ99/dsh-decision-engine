window.__ModuleLoader__.load({ id: "dsh-decision-engine", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  DecisionSettingsSection: () => DecisionSettingsSection,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var NAMESPACE = "decision-engine";
var FIELDS = [
  { path: "defaultProvider", label: "\u9ED8\u8BA4 Provider", hint: "\u586B\u5DF2\u6CE8\u518C\u7684 Provider ID\uFF1B\u5F53\u524D\u5185\u7F6E\u7684\u662F laya\u3002", kind: "text", group: "provider" },
  { path: "providers.laya.enabled", label: "\u542F\u7528 Laya", hint: "\u6539\u53D8\u6CE8\u518C\u7684 Provider \u96C6\u5408\uFF0C\u91CD\u542F\u540E\u751F\u6548\u3002", kind: "boolean", group: "provider", restart: true },
  { path: "providers.laya.modelDir", label: "Laya \u6A21\u578B\u76EE\u5F55", hint: "\u672C\u673A bundle \u76EE\u5F55\uFF1B\u7559\u7A7A\u4F7F\u7528 SDK \u7684\u67E5\u627E\u65B9\u5F0F\u3002\u91CD\u542F\u540E\u751F\u6548\u3002", kind: "text", group: "provider", restart: true },
  { path: "providers.laya.autoLoad", label: "\u542F\u52A8\u65F6\u52A0\u8F7D\u6A21\u578B", hint: "\u5173\u95ED\u65F6\u9996\u6B21\u51B3\u7B56\u624D\u52A0\u8F7D\uFF1B\u6539\u53D8\u52A0\u8F7D\u7B56\u7565\u9700\u91CD\u542F\u3002", kind: "boolean", group: "residency", restart: true },
  { path: "providers.laya.idleTtlMs", label: "\u7A7A\u95F2\u91CA\u653E\u65F6\u95F4\uFF08\u6BEB\u79D2\uFF09", hint: "0 \u8868\u793A\u8FDB\u7A0B\u5B58\u7EED\u671F\u95F4\u5E38\u9A7B\u3002\u91CD\u542F\u540E\u751F\u6548\u3002", kind: "integer", group: "residency", restart: true, min: 0 },
  { path: "runtime.maxSteps", label: "\u5355\u6B21\u5FAA\u73AF\u6700\u591A\u6B65\u9AA4", hint: "\u8FD0\u884C\u65F6\u9884\u7B97\uFF1B\u6574\u4EFB\u52A1\u53EF\u5728\u8C03\u7528\u53C2\u6570\u4E2D\u8986\u76D6\u3002", kind: "integer", group: "budget", min: 1 },
  { path: "runtime.maxDurationMs", label: "\u5355\u6B21\u5FAA\u73AF\u6700\u957F\u65F6\u95F4\uFF08\u6BEB\u79D2\uFF09", hint: "\u8FD0\u884C\u65F6\u603B\u65F6\u957F\u9884\u7B97\uFF1B\u6574\u4EFB\u52A1\u53EF\u5728\u8C03\u7528\u53C2\u6570\u4E2D\u8986\u76D6\u3002", kind: "integer", group: "budget", min: 1 },
  { path: "runtime.observeTimeoutMs", label: "\u89C2\u5BDF\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", hint: "\u4E5F\u4F5C\u4E3A\u5355\u6B21 Provider \u51B3\u7B56\u7684\u9ED8\u8BA4\u9884\u7B97\u3002", kind: "integer", group: "budget", min: 1 },
  { path: "runtime.executeTimeoutMs", label: "\u52A8\u4F5C\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", hint: "\u4E00\u6B21\u73AF\u5883\u52A8\u4F5C\u5141\u8BB8\u7684\u6700\u957F\u65F6\u95F4\u3002", kind: "integer", group: "budget", min: 1 },
  { path: "runtime.noProgressLimit", label: "\u65E0\u8FDB\u5C55\u505C\u6B62\u6B21\u6570", hint: "\u8FDE\u7EED\u591A\u5C11\u6B65\u72B6\u6001\u4E0D\u53D8\u65F6\u505C\u6B62\uFF1B0 \u5173\u95ED\u8BE5\u68C0\u6D4B\u3002", kind: "integer", group: "budget", min: 0 }
];
var GROUPS = [
  { id: "provider", title: "\u6A21\u578B\u4E0E Provider", subtitle: "\u9ED8\u8BA4 Provider\u3001Laya \u548C\u6A21\u578B\u76EE\u5F55" },
  { id: "residency", title: "\u6A21\u578B\u9A7B\u7559", subtitle: "\u52A0\u8F7D\u65F6\u673A\u4E0E\u7A7A\u95F2\u91CA\u653E" },
  { id: "budget", title: "\u6267\u884C\u9884\u7B97", subtitle: "\u6B65\u9AA4\u3001\u8017\u65F6\u4E0E\u505C\u6B62\u6761\u4EF6" }
];
var DEFAULTS = {
  defaultProvider: "",
  "providers.laya.enabled": true,
  "providers.laya.modelDir": "",
  "providers.laya.autoLoad": false,
  "providers.laya.idleTtlMs": 0,
  "runtime.maxSteps": 10,
  "runtime.maxDurationMs": 12e4,
  "runtime.observeTimeoutMs": 9e4,
  "runtime.executeTimeoutMs": 9e4,
  "runtime.noProgressLimit": 3
};
function part(object, path) {
  let value = object;
  for (const key of path) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return void 0;
    value = value[key];
  }
  return value;
}
function hasPart(object, path) {
  let value = object;
  for (const key of path) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return false;
    value = value[key];
  }
  return true;
}
function fieldValue(snapshot, spec, draft) {
  const path = spec.path.split(".");
  if (draft?.kind === "set") return draft.value;
  const layer = draft?.kind === "unset" ? snapshot.base : snapshot.value;
  const value = part(layer, path);
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : DEFAULTS[spec.path];
}
function operation(spec, draft) {
  const path = spec.path.split(".");
  if (draft.kind === "unset") return { op: "unset", path };
  if (spec.kind === "boolean") return typeof draft.value === "boolean" ? { op: "set", path, value: draft.value } : void 0;
  const text = String(draft.value).trim();
  if (spec.kind === "text") {
    if (text === "") return { op: "unset", path };
    return { op: "set", path, value: text };
  }
  if (text === "") return void 0;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= (spec.min ?? 0) ? { op: "set", path, value } : void 0;
}
var STYLE = `
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
`;
function DecisionSettingsSection({ scope }) {
  const subscribe = (0, import_react.useCallback)((listener) => scope.subscribe(listener), [scope]);
  const getSnapshot = (0, import_react.useCallback)(() => scope.getSnapshot(), [scope]);
  const snapshot = (0, import_react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
  const [expanded, setExpanded] = (0, import_react.useState)({ provider: true });
  const [drafts, setDrafts] = (0, import_react.useState)({});
  const [saving, setSaving] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)("");
  const editRevision = (0, import_react.useRef)(void 0);
  const dirty = Object.keys(drafts).length > 0;
  const invalid = FIELDS.some((spec) => {
    const draft = drafts[spec.path];
    return draft !== void 0 && operation(spec, draft) === void 0;
  });
  const stage = (path, draft) => {
    if (!dirty) editRevision.current = snapshot.revision;
    setDrafts((previous) => ({ ...previous, [path]: draft }));
    setError("");
  };
  const save = async () => {
    const ops = FIELDS.flatMap((spec) => {
      const draft = drafts[spec.path];
      return draft === void 0 ? [] : [operation(spec, draft)];
    });
    if (!dirty || saving || invalid || snapshot.status !== "ready" || !snapshot.writable || ops.some((op) => op === void 0)) return;
    const writes = ops;
    setSaving(true);
    setError("");
    try {
      await scope.mutate(writes, editRevision.current);
      const user = scope.getSnapshot().user;
      const landed = writes.every((write) => write.op === "unset" ? !hasPart(user, write.path) : hasPart(user, write.path) && part(user, write.path) === write.value);
      if (!landed) throw new Error("settings write was not accepted");
      setDrafts({});
      editRevision.current = void 0;
    } catch {
      setError("\u4FDD\u5B58\u672A\u751F\u6548\u3002\u8BF7\u68C0\u67E5\u8F93\u5165\uFF0C\u6216\u5237\u65B0\u540E\u5904\u7406\u5176\u4ED6\u9875\u9762\u7684\u4FEE\u6539\u3002");
    } finally {
      setSaving(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-de-page", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "dsh-de-title", children: "\u51B3\u7B56\u5F15\u64CE" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-intro", children: "\u914D\u7F6E\u6A21\u578B\u4E0E\u6267\u884C\u9884\u7B97\u3002\u6D4F\u89C8\u5668\u548C\u7535\u8111\u80FD\u529B\u5728\u4EFB\u52A1\u4F7F\u7528\u65F6\u6309\u9700\u8C03\u7528\u3002" })
    ] }),
    snapshot.status === "unavailable" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-notice", children: "\u5F53\u524D\u90E8\u7F72\u65E0\u6CD5\u8BFB\u53D6\u51B3\u7B56\u5F15\u64CE\u8BBE\u7F6E\u3002" }),
    snapshot.status === "loading" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-notice", children: "\u6B63\u5728\u8BFB\u53D6\u8BBE\u7F6E\u2026" }),
    snapshot.status === "ready" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      !snapshot.writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-notice", children: "\u5F53\u524D\u90E8\u7F72\u7684\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\u3002" }),
      GROUPS.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { className: "dsh-de-group", open: expanded[group.id] === true, onToggle: (event) => {
        const open = event.currentTarget.open;
        setExpanded((previous) => previous[group.id] === open ? previous : { ...previous, [group.id]: open });
      }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("summary", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-de-group-title", children: group.title }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-de-subtitle", children: group.subtitle })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-de-chevron", "aria-hidden": "true", children: "\u2304" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-de-body", children: FIELDS.filter((spec) => spec.group === group.id).map((spec) => {
          const current = drafts[spec.path];
          const value = fieldValue(snapshot, spec, current);
          const overridden = current?.kind === "set" || current === void 0 && hasPart(snapshot.user, spec.path.split("."));
          const id = `dsh-de-${spec.path.replaceAll(".", "-")}`;
          return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-de-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-de-label", htmlFor: id, children: [
              spec.label,
              spec.restart && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-de-tag", children: "\u91CD\u542F\u540E\u751F\u6548" }),
              overridden && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-de-tag", children: "\u5DF2\u8986\u76D6" })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-de-control", children: [
              spec.kind === "boolean" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { id, type: "checkbox", checked: value === true, disabled: !snapshot.writable || saving, onChange: (event) => stage(spec.path, { kind: "set", value: event.target.checked }) }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { id, type: "text", inputMode: spec.kind === "integer" ? "numeric" : "text", value: String(value), disabled: !snapshot.writable || saving, "aria-invalid": current !== void 0 && operation(spec, current) === void 0, onChange: (event) => stage(spec.path, { kind: "set", value: event.target.value }) }),
              (overridden || current !== void 0) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-de-reset", disabled: !snapshot.writable || saving, onClick: () => stage(spec.path, { kind: "unset" }), children: "\u6062\u590D\u9ED8\u8BA4" })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-de-hint", children: spec.hint })
          ] }, spec.path);
        }) })
      ] }, group.id)),
      error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-error", role: "status", children: error }),
      dirty && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-de-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: saving, onClick: () => {
          setDrafts({});
          editRevision.current = void 0;
          setError("");
        }, children: "\u653E\u5F03\u4FEE\u6539" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: invalid || saving || !snapshot.writable, onClick: () => {
          void save();
        }, children: saving ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u4FEE\u6539" })
      ] })
    ] })
  ] });
}
var inject = ["slots", "settingsScope"];
function apply(ctx) {
  const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.plugin = NAMESPACE;
    style.textContent = STYLE;
    document.head.appendChild(style);
    return () => style.remove();
  }, "decision-engine settings styles");
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: NAMESPACE,
    order: 16,
    label: "\u51B3\u7B56\u5F15\u64CE",
    inject: () => ({ scope })
  }, DecisionSettingsSection));
}

return module.exports; } });
