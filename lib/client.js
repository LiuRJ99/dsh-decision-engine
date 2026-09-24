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
function field(object, key) {
  return typeof object === "object" && object !== null && Object.hasOwn(object, key) ? object[key] : void 0;
}
function providerSuggestions(snapshot) {
  const providers = field(snapshot.value, "providers");
  if (typeof providers !== "object" || providers === null) return [];
  return Object.entries(providers).flatMap(([id, config]) => typeof config === "object" && config !== null && field(config, "enabled") !== false ? [id] : []);
}
var STYLE = `
.dsh-de-page{display:grid;gap:18px;max-width:640px;color:inherit}
.dsh-de-title{font-size:18px;font-weight:600;margin:0}.dsh-de-intro,.dsh-de-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#747b86);line-height:1.5}
.dsh-de-intro{margin:5px 0 0}.dsh-de-card{border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#fff);padding:16px}
.dsh-de-label{display:block;font-size:13px;font-weight:600;margin-bottom:8px}.dsh-de-control{display:flex;gap:8px;align-items:center}
.dsh-de-control input{box-sizing:border-box;min-width:0;flex:1;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:7px;background:var(--dsw-alias-bg-layer-3,#fff);color:inherit;font:inherit;font-size:13px}
.dsh-de-hint{display:block;margin:8px 0 0}.dsh-de-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.dsh-de-actions button,.dsh-de-reset{border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:7px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:inherit;font:inherit;font-size:12px;cursor:pointer}
.dsh-de-actions button:disabled,.dsh-de-reset:disabled{opacity:.45;cursor:default}.dsh-de-error{color:var(--dsw-alias-label-error,#c33);font-size:12px;margin:10px 0 0}
`;
function DecisionSettingsSection({ scope }) {
  const subscribe = (0, import_react.useCallback)((listener) => scope.subscribe(listener), [scope]);
  const getSnapshot = (0, import_react.useCallback)(() => scope.getSnapshot(), [scope]);
  const snapshot = (0, import_react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
  const [draft, setDraft] = (0, import_react.useState)(void 0);
  const [saving, setSaving] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)("");
  const editRevision = (0, import_react.useRef)(void 0);
  const saved = field(snapshot.value, "defaultProvider");
  const base = field(snapshot.base, "defaultProvider");
  const shown = draft?.kind === "set" ? draft.value : draft?.kind === "unset" ? base : saved;
  const value = typeof shown === "string" ? shown : "";
  const overridden = field(snapshot.user, "defaultProvider") !== void 0;
  const stage = (next) => {
    if (draft === void 0) editRevision.current = snapshot.revision;
    setDraft(next);
    setError("");
  };
  const save = async () => {
    if (draft === void 0 || saving || snapshot.status !== "ready" || !snapshot.writable) return;
    const selected = draft.kind === "set" ? draft.value.trim() : "";
    const write = selected === "" ? { op: "unset", path: ["defaultProvider"] } : { op: "set", path: ["defaultProvider"], value: selected };
    setSaving(true);
    setError("");
    try {
      await scope.mutate([write], editRevision.current);
      const userValue = field(scope.getSnapshot().user, "defaultProvider");
      if (write.op === "set" ? userValue !== selected : userValue !== void 0) {
        throw new Error("settings write was not accepted");
      }
      setDraft(void 0);
      editRevision.current = void 0;
    } catch {
      setError("\u4FDD\u5B58\u672A\u751F\u6548\u3002\u8BF7\u68C0\u67E5 Provider ID\uFF0C\u6216\u5237\u65B0\u540E\u91CD\u8BD5\u3002");
    } finally {
      setSaving(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-de-page", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "dsh-de-title", children: "\u51B3\u7B56\u5F15\u64CE" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-intro", children: "\u9009\u62E9\u9ED8\u8BA4\u51B3\u7B56\u6A21\u578B\u3002\u5355\u6B21\u4EFB\u52A1\u4E5F\u53EF\u4EE5\u6307\u5B9A\u5176\u4ED6 Provider\u3002" })
    ] }),
    snapshot.status === "unavailable" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-hint", children: "\u5F53\u524D\u90E8\u7F72\u65E0\u6CD5\u8BFB\u53D6\u51B3\u7B56\u5F15\u64CE\u8BBE\u7F6E\u3002" }),
    snapshot.status === "loading" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-hint", children: "\u6B63\u5728\u8BFB\u53D6\u8BBE\u7F6E\u2026" }),
    snapshot.status === "ready" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-de-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { className: "dsh-de-label", htmlFor: "dsh-de-provider", children: "\u9ED8\u8BA4\u51B3\u7B56\u6A21\u578B\uFF08Provider ID\uFF09" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-de-control", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { id: "dsh-de-provider", type: "text", list: "dsh-de-providers", value, disabled: !snapshot.writable || saving, onChange: (event) => stage({ kind: "set", value: event.target.value }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("datalist", { id: "dsh-de-providers", children: providerSuggestions(snapshot).map((id) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: id }, id)) }),
        (overridden || draft !== void 0) && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-de-reset", disabled: !snapshot.writable || saving, onClick: () => stage({ kind: "unset" }), children: "\u6062\u590D\u9ED8\u8BA4" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-hint", children: "\u5019\u9009 ID \u6765\u81EA\u5DF2\u914D\u7F6E\u7684 Provider\uFF1B\u4E5F\u53EF\u8F93\u5165\u8FD0\u884C\u65F6\u5DF2\u6CE8\u518C\u7684 ID\u3002\u5207\u6362\u9ED8\u8BA4\u503C\u7ACB\u5373\u751F\u6548\uFF0C\u5355\u6B21\u8C03\u7528\u7684 provider \u53C2\u6570\u53EF\u4EE5\u8986\u76D6\u5B83\u3002" }),
      !snapshot.writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-hint", children: "\u5F53\u524D\u90E8\u7F72\u7684\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\u3002" }),
      error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-error", role: "status", children: error }),
      draft !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-de-actions", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: saving, onClick: () => {
          setDraft(void 0);
          editRevision.current = void 0;
          setError("");
        }, children: "\u653E\u5F03\u4FEE\u6539" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: saving || !snapshot.writable, onClick: () => {
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
