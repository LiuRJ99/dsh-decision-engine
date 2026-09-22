// src/gate.ts
var GATE_SKILL_NAMES = {
  browser: "browser",
  computer: "computer-use"
};
function isToolLazyGateSurface(value) {
  return typeof value === "object" && value !== null && typeof value.isUnlocked === "function";
}
var TOOL_LAZY_GATE_SERVICE = "toolLazyGate";
function queryCapabilityUnlocked(gate, agent, capability) {
  if (!isToolLazyGateSurface(gate)) return void 0;
  if (agent === void 0 || agent === null) return void 0;
  try {
    return gate.isUnlocked(agent, GATE_SKILL_NAMES[capability]);
  } catch {
    return void 0;
  }
}
export {
  GATE_SKILL_NAMES,
  TOOL_LAZY_GATE_SERVICE,
  isToolLazyGateSurface,
  queryCapabilityUnlocked
};
