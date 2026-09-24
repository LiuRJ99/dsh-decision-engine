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
  DecisionSettingsCard: () => DecisionSettingsCard,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var NAMESPACE = "decision-engine";
var PROVIDER_CATALOG_ROUTE = "/plugins/dsh-decision-engine/providers";
function field(object, key) {
  return typeof object === "object" && object !== null && Object.hasOwn(object, key) ? object[key] : void 0;
}
function configuredIds(snapshot) {
  const providers = field(snapshot.value, "providers");
  if (typeof providers !== "object" || providers === null) return [];
  return Object.entries(providers).flatMap(([id, config]) => typeof config === "object" && config !== null && field(config, "enabled") !== false ? [id] : []);
}
var STYLE = `
.dsh-de-card{list-style:none;border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:12px;background:var(--dsw-alias-bg-layer-3,#fff);overflow:hidden;color:inherit}
.dsh-de-head{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsh-de-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c78ff);outline-offset:-2px}.dsh-de-head-text{display:grid;gap:3px}
.dsh-de-title{font-size:15px;font-weight:600}.dsh-de-subtitle,.dsh-de-hint,.dsh-de-status{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#747b86)}
.dsh-de-chevron{font-size:14px;color:var(--dsw-alias-label-tertiary,#747b86)}.dsh-de-body{padding:16px;border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb)}
.dsh-de-field{display:grid;gap:7px}.dsh-de-label{font-size:13px;font-weight:500}.dsh-de-select{box-sizing:border-box;width:100%;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#d9dde3);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#fff);color:inherit;font:inherit;font-size:13px;cursor:pointer}
.dsh-de-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4c78ff)}.dsh-de-select:disabled{opacity:.55;cursor:default}
.dsh-de-hint,.dsh-de-status{margin:0}.dsh-de-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb)}
.dsh-de-actions button{border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer}.dsh-de-actions button:disabled{opacity:.45;cursor:default}
.dsh-de-secondary{border:1px solid var(--dsw-alias-border-l2,#d9dde3);background:var(--dsw-alias-bg-layer-3,#fff);color:inherit}
.dsh-de-save{border:0;background:var(--dsw-alias-label-primary,#111827);color:var(--dsw-alias-bg-layer-3,#fff);font-weight:500}
.dsh-de-error{color:var(--dsw-alias-label-error,#c33)}
`;
function DecisionSettingsCard({ scope }) {
  const subscribe = (0, import_react.useCallback)((listener) => scope.subscribe(listener), [scope]);
  const getSnapshot = (0, import_react.useCallback)(() => scope.getSnapshot(), [scope]);
  const snapshot = (0, import_react.useSyncExternalStore)(subscribe, getSnapshot, getSnapshot);
  const [open, setOpen] = (0, import_react.useState)(false);
  const [catalog, setCatalog] = (0, import_react.useState)({ status: "idle", ids: [] });
  const [refresh, setRefresh] = (0, import_react.useState)(0);
  const [draft, setDraft] = (0, import_react.useState)();
  const [saving, setSaving] = (0, import_react.useState)(false);
  const [message, setMessage] = (0, import_react.useState)("");
  const editRevision = (0, import_react.useRef)(void 0);
  (0, import_react.useEffect)(() => {
    if (!open) return;
    let active = true;
    setCatalog((previous) => ({ ...previous, status: "loading" }));
    void fetch(PROVIDER_CATALOG_ROUTE, { headers: { accept: "application/json" } }).then(async (response) => {
      if (!response.ok) throw new Error("provider catalog unavailable");
      const ids = field(await response.json(), "providers");
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new Error("invalid provider catalog");
      return ids;
    }).then((ids) => {
      if (active) setCatalog({ status: "ready", ids });
    }).catch(() => {
      if (active) setCatalog((previous) => ({ ...previous, status: "error" }));
    });
    return () => {
      active = false;
    };
  }, [open, refresh]);
  const saved = field(snapshot.value, "defaultProvider");
  const base = field(snapshot.base, "defaultProvider");
  const shown = draft?.kind === "set" ? draft.value : draft?.kind === "unset" ? base : saved;
  const value = typeof shown === "string" ? shown : "";
  const overridden = field(snapshot.user, "defaultProvider") !== void 0;
  const available = catalog.status === "ready" ? catalog.ids : configuredIds(snapshot);
  const options = [.../* @__PURE__ */ new Set([...available, ...value ? [value] : []])];
  const stage = (next) => {
    if (draft === void 0) editRevision.current = snapshot.revision;
    setDraft(next);
    setMessage("");
  };
  const save = async (event) => {
    event.preventDefault();
    if (draft === void 0 || saving || snapshot.status !== "ready" || !snapshot.writable) return;
    const selected = draft.kind === "set" ? draft.value : "";
    const write = selected === "" ? { op: "unset", path: ["defaultProvider"] } : { op: "set", path: ["defaultProvider"], value: selected };
    setSaving(true);
    setMessage("");
    try {
      await scope.mutate([write], editRevision.current);
      const userValue = field(scope.getSnapshot().user, "defaultProvider");
      if (write.op === "set" ? userValue !== selected : userValue !== void 0) {
        throw new Error("settings write was not accepted");
      }
      setDraft(void 0);
      editRevision.current = void 0;
      setMessage("\u5DF2\u4FDD\u5B58\uFF0C\u540E\u7EED\u51B3\u7B56\u7ACB\u5373\u751F\u6548\u3002");
    } catch {
      setMessage("\u4FDD\u5B58\u672A\u751F\u6548\u3002\u8BF7\u5237\u65B0\u6A21\u578B\u5217\u8868\uFF0C\u6216\u68C0\u67E5\u5176\u4ED6\u9875\u9762\u7684\u4FEE\u6539\u3002");
    } finally {
      setSaving(false);
    }
  };
  if (snapshot.status === "unavailable") return null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "dsh-de-card", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", className: "dsh-de-head", "aria-expanded": open, onClick: () => setOpen((previous) => !previous), children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-de-head-text", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-de-title", children: "\u51B3\u7B56\u5F15\u64CE" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-de-subtitle", children: [
          "\u9ED8\u8BA4\u51B3\u7B56\u6A21\u578B",
          typeof saved === "string" ? ` \xB7 ${saved}` : ""
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-de-chevron", "aria-hidden": "true", children: open ? "\u2303" : "\u2304" })
    ] }),
    open && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", { className: "dsh-de-body", onSubmit: (event) => {
      void save(event);
    }, children: [
      snapshot.status === "loading" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-hint", children: "\u6B63\u5728\u8BFB\u53D6\u8BBE\u7F6E\u2026" }),
      snapshot.status === "ready" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-de-field", htmlFor: "dsh-de-provider", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-de-label", children: "\u9ED8\u8BA4\u51B3\u7B56\u6A21\u578B" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "select",
            {
              id: "dsh-de-provider",
              className: "dsh-de-select",
              value,
              disabled: !snapshot.writable || saving || options.length === 0,
              onChange: (event) => stage({ kind: "set", value: event.target.value }),
              children: [
                value === "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: "\u81EA\u52A8\u9009\u62E9" }),
                options.map((id) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: id, children: [
                  id === "laya" ? "Laya \xB7 laya" : id,
                  !available.includes(id) ? "\uFF08\u4E0D\u5728\u53EF\u7528\u5217\u8868\uFF09" : ""
                ] }, id))
              ]
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-de-hint", children: "\u9009\u62E9\u5DF2\u6CE8\u518C\u7684 Provider\uFF1B\u5355\u6B21\u4EFB\u52A1\u4ECD\u53EF\u7528 provider \u53C2\u6570\u6307\u5B9A\u5176\u4ED6\u6A21\u578B\u3002" })
        ] }),
        catalog.status === "loading" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-hint", children: "\u6B63\u5728\u8BFB\u53D6\u53EF\u7528\u6A21\u578B\u2026" }),
        catalog.status === "error" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-hint", children: "\u6A21\u578B\u5217\u8868\u6682\u4E0D\u53EF\u7528\uFF0C\u5F53\u524D\u663E\u793A\u5DF2\u914D\u7F6E\u9879\u3002" }),
        !snapshot.writable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dsh-de-hint", children: "\u5F53\u524D\u90E8\u7F72\u7684\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\u3002" }),
        message && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: message.startsWith("\u4FDD\u5B58\u672A") ? "dsh-de-status dsh-de-error" : "dsh-de-status", role: "status", children: message }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-de-actions", children: [
          catalog.status === "error" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-de-secondary", onClick: () => setRefresh((previous) => previous + 1), children: "\u5237\u65B0\u6A21\u578B" }),
          overridden && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-de-secondary", disabled: !snapshot.writable || saving, onClick: () => stage({ kind: "unset" }), children: "\u6062\u590D\u9ED8\u8BA4" }),
          draft !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dsh-de-secondary", disabled: saving, onClick: () => {
            setDraft(void 0);
            editRevision.current = void 0;
            setMessage("");
          }, children: "\u653E\u5F03\u4FEE\u6539" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "submit", className: "dsh-de-save", disabled: draft === void 0 || saving || !snapshot.writable, children: saving ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58" })
        ] })
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
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
    name: "settings.plugin.item",
    key: NAMESPACE,
    inject: () => ({ scope })
  }, DecisionSettingsCard));
}

return module.exports; } });
