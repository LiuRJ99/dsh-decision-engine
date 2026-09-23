// src/composition.ts
import z from "@deepseek-ai/schemastery";

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
function toDecisionFailure(error, fallback = "internal") {
  if (isDecisionError(error)) return error.toJSON();
  if (error instanceof Error) {
    return {
      code: fallback,
      message: error.message,
      details: { name: error.name }
    };
  }
  return { code: fallback, message: String(error) };
}
var GUIDANCE = {
  provider_unknown: "Register the provider or route to a provider that is enabled.",
  provider_unavailable: "Fall back to another provider or handle the step with the main agent.",
  provider_unsupported_capability: "Re-issue the request in a supported mode or route it to a capable provider.",
  invalid_decision: "Treat the provider output as unusable and decide this step with the main agent.",
  unknown_candidate: "Re-issue the decision with a candidate set that contains the returned id.",
  low_confidence: "Ask the user or the main agent to decide this step; the model is not confident enough.",
  provider_timeout: "Retry once with a larger budget, then hand the step to the main agent.",
  provider_failed: "Inspect the provider error and fall back to the main agent for this step.",
  insufficient_observation: "Use the main agent with a richer observation source; do not guess.",
  environment_unsupported: "This environment cannot express structured state; use the main agent.",
  environment_unknown: "Register the environment adapter before driving it.",
  environment_unavailable: "Ask the user to authorize the capability (for example /browser) before proceeding.",
  no_candidates: "Supply a finite candidate set before asking for a decision.",
  invalid_request: "Fix the request and retry.",
  action_mapping_failed: "Map the decision yourself and execute it with the main agent.",
  action_execution_failed: "Inspect the environment error and retry or recover with the main agent.",
  no_progress: "Stop looping: the environment is not changing. Re-plan with the main agent.",
  repeated_decision: "Stop looping: the same action keeps being chosen. Re-plan with the main agent.",
  budget_exhausted: "Stop looping and re-plan with the main agent; the step budget is spent.",
  aborted: "The caller aborted; no further action was taken.",
  needs_vision: "This layer is text-only; use the main agent with vision for this step.",
  needs_planning: "The task needs planning beyond a finite candidate set; use the main agent.",
  high_risk_action: "Confirm the action with the user before executing it.",
  internal: "Inspect the failure detail and recover with the main agent."
};
function toEscalation(failure, context) {
  return {
    status: "needs_escalation",
    reason: failure.code,
    guidance: context?.guidance ?? GUIDANCE[failure.code],
    ...context?.environment === void 0 ? {} : { environment: context.environment },
    ...context?.provider === void 0 ? {} : { provider: context.provider },
    ...context?.lastDecision === void 0 ? {} : { lastDecision: context.lastDecision },
    details: { message: failure.message, ...failure.details, ...context?.details }
  };
}

// src/core/types.ts
var DECISION_CAPABILITIES = [
  "choice",
  "ranking",
  "score",
  "classification"
];
function isDecisionCapability(value) {
  return typeof value === "string" && DECISION_CAPABILITIES.includes(value);
}
var DECISION_CONFIDENCE_KINDS = ["normalized", "provider_raw", "unavailable"];
function isDecisionConfidenceKind(value) {
  return typeof value === "string" && DECISION_CONFIDENCE_KINDS.includes(value);
}
function createDecisionResult(init) {
  const result = {
    provider: init.provider,
    mode: init.mode,
    latencyMs: init.latencyMs
  };
  if (init.selected !== void 0) result.selected = init.selected;
  if (init.ranking !== void 0) result.ranking = init.ranking;
  if (init.confidence !== void 0) result.confidence = init.confidence;
  if (init.confidenceKind !== void 0) result.confidenceKind = init.confidenceKind;
  if (init.usage !== void 0) result.usage = init.usage;
  if (init.debug !== void 0) result.debug = init.debug;
  return result;
}

// src/core/provider-registry.ts
var DecisionProviderRegistry = class {
  #entries = /* @__PURE__ */ new Map();
  #defaultId;
  /**
   * Add a provider.
   *
   * @param provider - the provider instance. Its `id` becomes the registry key.
   * @param options - enablement and config.
   * @returns the exact disposer that unregisters this provider.
   * @throws DecisionError with `invalid_request` on a malformed id or a duplicate.
   */
  register(provider, options = {}) {
    const id = provider?.id;
    if (typeof id !== "string" || id.trim() === "") {
      throw new DecisionError("invalid_request", "A decision provider must declare a non-empty string id.");
    }
    if (typeof provider.decide !== "function") {
      throw new DecisionError("invalid_request", `Provider "${id}" must implement decide().`, { subject: id });
    }
    const capabilities = provider.capabilities;
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new DecisionError("invalid_request", `Provider "${id}" must declare at least one capability.`, { subject: id });
    }
    for (const capability of capabilities) {
      if (!isDecisionCapability(capability)) {
        throw new DecisionError("invalid_request", `Provider "${id}" declares unknown capability "${String(capability)}".`, {
          subject: id,
          details: { capability: String(capability) }
        });
      }
    }
    if (this.#entries.has(id) && options.replace !== true) {
      throw new DecisionError("invalid_request", `Provider "${id}" is already registered.`, {
        subject: id,
        details: { hint: "Pass replace: true to override a registered provider id." }
      });
    }
    this.#entries.set(id, {
      provider,
      enabled: options.enabled ?? true,
      config: options.config ?? {}
    });
    if (this.#defaultId === void 0 && (options.enabled ?? true)) this.#defaultId = id;
    return () => {
      this.#entries.delete(id);
      if (this.#defaultId === id) this.#defaultId = this.#firstEnabledId();
    };
  }
  /** Remove a provider by id. Returns whether anything was removed. */
  unregister(id) {
    const removed = this.#entries.delete(id);
    if (removed && this.#defaultId === id) this.#defaultId = this.#firstEnabledId();
    return removed;
  }
  /** Whether a provider id is registered (enabled or not). */
  has(id) {
    return this.#entries.has(id);
  }
  /**
   * Look up a provider.
   *
   * @param id - provider id.
   * @returns the provider, or undefined.
   */
  get(id) {
    return this.#entries.get(id)?.provider;
  }
  /**
   * Look up a provider that must exist and be enabled.
   *
   * @throws DecisionError with `provider_unknown` or `provider_unavailable`.
   */
  require(id) {
    const entry = this.#entries.get(id);
    if (entry === void 0) {
      throw new DecisionError("provider_unknown", `No decision provider is registered as "${id}".`, {
        subject: id,
        details: { registered: [...this.#entries.keys()] }
      });
    }
    if (!entry.enabled) {
      throw new DecisionError("provider_unavailable", `Decision provider "${id}" is registered but disabled.`, {
        subject: id,
        details: { hint: `Enable it under providers.${id}.enabled.` }
      });
    }
    return entry.provider;
  }
  /** Registration entry (provider, enabled flag, config) or undefined. */
  entry(id) {
    return this.#entries.get(id);
  }
  /** Ids of every registered provider, enabled or not, in registration order. */
  ids() {
    return [...this.#entries.keys()];
  }
  /** Ids of enabled providers, in registration order. */
  enabledIds() {
    return [...this.#entries.entries()].filter(([, entry]) => entry.enabled).map(([id]) => id);
  }
  /**
   * Ids of enabled providers that declare `capability`.
   *
   * @param capability - the required capability.
   * @returns matching provider ids in registration order.
   */
  idsWithCapability(capability) {
    return [...this.#entries.entries()].filter(([, entry]) => entry.enabled && entry.provider.capabilities.includes(capability)).map(([id]) => id);
  }
  /** Descriptors for every registered provider. */
  list() {
    return [...this.#entries.entries()].map(([id, entry]) => ({
      id,
      enabled: entry.enabled,
      capabilities: [...entry.provider.capabilities],
      hasHealthCheck: typeof entry.provider.healthCheck === "function",
      isDefault: this.#defaultId === id
    }));
  }
  /** The configured default provider id, or undefined when none is eligible. */
  getDefaultId() {
    return this.#defaultId;
  }
  /**
   * Set the default provider id.
   *
   * @param id - a registered, enabled provider id.
   * @throws DecisionError with `provider_unknown` or `provider_unavailable`.
   */
  setDefault(id) {
    this.require(id);
    this.#defaultId = id;
  }
  /**
   * Resolve the provider for a request: the explicitly named one, else the
   * default.
   *
   * @param requestedId - provider the caller named, if any.
   * @returns the provider to use and its id.
   * @throws DecisionError with `provider_unknown` or `provider_unavailable`.
   */
  resolve(requestedId) {
    if (requestedId !== void 0) {
      if (typeof requestedId !== "string" || requestedId.trim() === "") {
        throw new DecisionError("invalid_request", "provider must be a non-empty string when present.");
      }
      return { id: requestedId, provider: this.require(requestedId) };
    }
    const defaultId = this.#defaultId;
    if (defaultId === void 0) {
      throw new DecisionError("provider_unavailable", "No decision provider is enabled.", {
        details: { registered: [...this.#entries.keys()], hint: "Register a provider or enable one in config." }
      });
    }
    return { id: defaultId, provider: this.require(defaultId) };
  }
  /**
   * Assert that a provider implements a mode before it is asked to run it.
   *
   * @throws DecisionError with `provider_unsupported_capability`.
   */
  assertCapability(id, mode) {
    const provider = this.require(id);
    if (!provider.capabilities.includes(mode)) {
      throw new DecisionError("provider_unsupported_capability", `Decision provider "${id}" does not implement "${mode}".`, {
        subject: id,
        details: { mode, capabilities: [...provider.capabilities] }
      });
    }
  }
  /**
   * Run every enabled provider's health check.
   *
   * A provider without a health check reports `ok` with no details. A health
   * check that throws is reported as `unavailable` rather than failing the
   * whole listing — one broken provider must not blind the caller to the rest.
   */
  async health() {
    const result = {};
    for (const [id, entry] of this.#entries) {
      if (!entry.enabled) {
        result[id] = { status: "unavailable", reason: "disabled" };
        continue;
      }
      const check = entry.provider.healthCheck;
      if (typeof check !== "function") {
        result[id] = { status: "ok" };
        continue;
      }
      try {
        result[id] = await check.call(entry.provider);
      } catch (error) {
        result[id] = {
          status: "unavailable",
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    }
    return result;
  }
  /** Dispose every registered provider that owns resources. */
  async disposeAll() {
    for (const [, entry] of this.#entries) {
      try {
        await entry.provider.dispose?.();
      } catch {
      }
    }
    this.#entries.clear();
    this.#defaultId = void 0;
  }
  #firstEnabledId() {
    for (const [id, entry] of this.#entries) {
      if (entry.enabled) return id;
    }
    return void 0;
  }
};

// src/core/router.ts
var DecisionRouter = class {
  #registry;
  #defaultProviderId;
  #allowCapabilityFallback;
  /**
   * @param registry - provider membership.
   * @param options - routing config.
   */
  constructor(registry, options = {}) {
    this.#registry = registry;
    this.#defaultProviderId = options.defaultProviderId;
    this.#allowCapabilityFallback = options.allowCapabilityFallback ?? true;
  }
  /** The configured default provider id, if any. */
  get defaultProviderId() {
    return this.#defaultProviderId;
  }
  /** Whether a capability miss may fall back to another enabled provider. */
  get allowCapabilityFallback() {
    return this.#allowCapabilityFallback;
  }
  /**
   * Re-point the default provider.
   *
   * @param id - a registered, enabled provider id, or undefined to fall back to
   *   the first enabled provider.
   * @throws DecisionError with `provider_unknown` or `provider_unavailable`.
   */
  setDefaultProvider(id) {
    if (id !== void 0) this.#registry.require(id);
    this.#defaultProviderId = id;
  }
  /** Allow or forbid capability fallback. */
  setAllowCapabilityFallback(allow) {
    this.#allowCapabilityFallback = allow;
  }
  /**
   * Choose a provider for a request.
   *
   * Order: an explicit `request.provider` field; then the configured default;
   * then — only when enabled and only if the chosen provider cannot run the
   * mode — the first enabled provider that declares the capability.
   *
   * @param request - the decision request.
   * @param mode - the resolved mode.
   * @returns the chosen provider id and why.
   * @throws DecisionError with `provider_unknown`, `provider_unavailable`, or
   *   `provider_unsupported_capability`.
   */
  route(request, mode) {
    const explicit = request.provider;
    if (explicit !== void 0) {
      const providerId = explicit;
      this.#registry.require(providerId);
      this.#registry.assertCapability(providerId, mode);
      return { providerId, reason: "explicit" };
    }
    const preferred = this.#defaultProviderId;
    if (preferred !== void 0) {
      const provider = this.#registry.require(preferred);
      if (provider.capabilities.includes(mode)) return { providerId: preferred, reason: "default" };
      if (!this.#allowCapabilityFallback) {
        throw new DecisionError("provider_unsupported_capability", `Default provider "${preferred}" does not implement "${mode}".`, {
          subject: preferred,
          details: { mode, capabilities: [...provider.capabilities] }
        });
      }
      const fallback = this.#registry.idsWithCapability(mode).find((id) => id !== preferred);
      if (fallback !== void 0) return { providerId: fallback, reason: "capability-fallback" };
      throw new DecisionError("provider_unsupported_capability", `No enabled provider implements "${mode}".`, {
        subject: preferred,
        details: { mode, enabled: this.#registry.enabledIds() }
      });
    }
    const capable = this.#registry.idsWithCapability(mode);
    const first = capable[0];
    if (first === void 0) {
      const enabled = this.#registry.enabledIds();
      const detail = { mode, enabled };
      throw enabled.length === 0 ? new DecisionError("provider_unavailable", "No decision provider is enabled.", { details: detail }) : new DecisionError("provider_unsupported_capability", `No enabled provider implements "${mode}".`, { details: detail });
    }
    return { providerId: first, reason: "capability-fallback" };
  }
};

// src/core/validate.ts
var MAX_CANDIDATES = 64;
var MAX_STATE_CHARS = 2e5;
var MAX_OBJECTIVE_CHARS = 8e3;
function validateRequest(request) {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new DecisionError("invalid_request", "A decision request must be an object.");
  }
  const state = request.state;
  if (typeof state !== "string" && (typeof state !== "object" || state === null || Array.isArray(state))) {
    throw new DecisionError("invalid_request", "A decision request must carry state as a string or an object.");
  }
  if (typeof state === "string" && state.length > MAX_STATE_CHARS) {
    throw new DecisionError("invalid_request", `State exceeds the ${MAX_STATE_CHARS}-character limit.`, {
      details: { length: state.length, limit: MAX_STATE_CHARS }
    });
  }
  if (request.objective !== void 0 && typeof request.objective !== "string") {
    throw new DecisionError("invalid_request", "objective must be a string when present.");
  }
  if (typeof request.objective === "string" && request.objective.length > MAX_OBJECTIVE_CHARS) {
    throw new DecisionError("invalid_request", `Objective exceeds the ${MAX_OBJECTIVE_CHARS}-character limit.`, {
      details: { length: request.objective.length, limit: MAX_OBJECTIVE_CHARS }
    });
  }
  if (request.mode !== void 0 && !isDecisionCapability(request.mode)) {
    throw new DecisionError("invalid_request", `Unknown decision mode "${String(request.mode)}".`, {
      details: { supported: ["choice", "ranking", "score", "classification"] }
    });
  }
  if (request.constraints !== void 0 && (!Array.isArray(request.constraints) || request.constraints.some((item) => typeof item !== "string"))) {
    throw new DecisionError("invalid_request", "constraints must be an array of strings when present.");
  }
  if (!Array.isArray(request.candidates)) {
    throw new DecisionError("invalid_request", "A decision request must carry a candidates array.");
  }
  if (request.candidates.length === 0) {
    throw new DecisionError("no_candidates", "A decision request must carry at least one candidate.", {
      details: { hint: "Supply the finite option set the decider may choose from." }
    });
  }
  if (request.candidates.length > MAX_CANDIDATES) {
    throw new DecisionError("invalid_request", `Candidate count exceeds the ${MAX_CANDIDATES}-candidate limit.`, {
      details: { count: request.candidates.length, limit: MAX_CANDIDATES }
    });
  }
  const byId = /* @__PURE__ */ new Map();
  for (let index = 0; index < request.candidates.length; index += 1) {
    const candidate = request.candidates[index];
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new DecisionError("invalid_request", `candidates[${index}] must be an object.`);
    }
    if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
      throw new DecisionError("invalid_request", `candidates[${index}].id must be a non-empty string.`);
    }
    if (typeof candidate.description !== "string" || candidate.description.trim() === "") {
      throw new DecisionError("invalid_request", `candidates[${index}].description must be a non-empty string.`);
    }
    if (byId.has(candidate.id)) {
      throw new DecisionError("invalid_request", `Duplicate candidate id "${candidate.id}".`, { details: { id: candidate.id } });
    }
    byId.set(candidate.id, candidate);
  }
  const mode = request.mode ?? "choice";
  return { request, mode, byId };
}
function readConfidence(value, kind, providerId) {
  const hasNumber = value !== void 0 && value !== null;
  const hasKind = kind !== void 0 && kind !== null;
  if (hasNumber && typeof value !== "number") {
    return { ok: false, message: `Provider "${providerId}" returned a non-numeric confidence.` };
  }
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : void 0;
  if (hasNumber && numeric === void 0) {
    return { ok: false, message: `Provider "${providerId}" returned a non-finite confidence.` };
  }
  if (hasKind && !isDecisionConfidenceKind(kind)) {
    return { ok: false, message: `Provider "${providerId}" returned unknown confidenceKind ${JSON.stringify(kind)}.` };
  }
  const confidenceKind = isDecisionConfidenceKind(kind) ? kind : void 0;
  if (numeric !== void 0 && (numeric < 0 || numeric > 1)) {
    return { ok: false, message: `Provider "${providerId}" returned confidence ${numeric}, outside 0..1.` };
  }
  if (numeric !== void 0 && confidenceKind === void 0) {
    return {
      ok: false,
      message: `Provider "${providerId}" returned a confidence without a confidenceKind, so the engine cannot tell whether it is comparable with the configured threshold.`
    };
  }
  if (numeric !== void 0 && confidenceKind === "unavailable") {
    return { ok: false, message: `Provider "${providerId}" returned confidenceKind "unavailable" together with a number.` };
  }
  if (numeric === void 0 && confidenceKind !== void 0 && confidenceKind !== "unavailable") {
    return {
      ok: false,
      message: `Provider "${providerId}" declared confidenceKind "${confidenceKind}" but returned no confidence number.`
    };
  }
  return {
    ok: true,
    ...numeric === void 0 ? {} : { confidence: numeric },
    ...confidenceKind === void 0 ? {} : { confidenceKind }
  };
}
function sanitizeUsage(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  const record = value;
  const usage = {};
  for (const key of ["inputTokens", "outputTokens"]) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) usage[key] = raw;
  }
  const metrics = record.metrics;
  if (typeof metrics === "object" && metrics !== null && !Array.isArray(metrics)) {
    const kept = {};
    for (const [name, raw] of Object.entries(metrics)) {
      if (typeof raw === "number" && Number.isFinite(raw)) kept[name] = raw;
    }
    if (Object.keys(kept).length > 0) usage.metrics = kept;
  }
  return Object.keys(usage).length === 0 ? void 0 : usage;
}
function byScoreDescending(left, right) {
  const leftScore = left.score ?? Number.NEGATIVE_INFINITY;
  const rightScore = right.score ?? Number.NEGATIVE_INFINITY;
  if (rightScore !== leftScore) return rightScore - leftScore;
  return left.index - right.index;
}
function normalizeDecisionResult(raw, options) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new DecisionError("invalid_decision", `Provider "${options.providerId}" returned a non-object decision.`, {
      subject: options.providerId,
      details: { received: typeof raw }
    });
  }
  const value = raw;
  const { byId } = options.validated;
  const selected = value.selected;
  if (selected !== void 0 && typeof selected !== "string") {
    throw new DecisionError("invalid_decision", `Provider "${options.providerId}" returned a non-string selected id.`, {
      subject: options.providerId,
      details: { received: typeof selected }
    });
  }
  if (selected !== void 0 && !byId.has(selected)) {
    throw new DecisionError("unknown_candidate", `Provider "${options.providerId}" selected "${selected}", which is not in the candidate set.`, {
      subject: options.providerId,
      details: { selected, candidates: [...byId.keys()] }
    });
  }
  const ranking = [];
  const seen = /* @__PURE__ */ new Set();
  if (value.ranking !== void 0) {
    if (!Array.isArray(value.ranking)) {
      throw new DecisionError("invalid_decision", `Provider "${options.providerId}" returned a non-array ranking.`, {
        subject: options.providerId,
        details: { received: typeof value.ranking }
      });
    }
    for (let index = 0; index < value.ranking.length; index += 1) {
      const entry = value.ranking[index];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const id = entry.id;
      if (typeof id !== "string" || !byId.has(id) || seen.has(id)) continue;
      seen.add(id);
      const score = entry.score;
      ranking.push(
        typeof score === "number" && Number.isFinite(score) ? { id, score } : { id }
      );
    }
  }
  let resolvedSelected = selected;
  if (resolvedSelected === void 0 && ranking.length > 0) resolvedSelected = ranking[0]?.id;
  if (ranking.length === 0) {
    if (resolvedSelected === void 0) {
      throw new DecisionError("invalid_decision", `Provider "${options.providerId}" returned neither a selection nor a ranking.`, {
        subject: options.providerId
      });
    }
    ranking.push({ id: resolvedSelected });
  }
  if (resolvedSelected === void 0) {
    throw new DecisionError("invalid_decision", `Provider "${options.providerId}" produced no usable selection.`, {
      subject: options.providerId
    });
  }
  const confidence = readConfidence(value.confidence, value.confidenceKind, options.providerId);
  if (!confidence.ok) {
    throw new DecisionError("invalid_decision", confidence.message, { subject: options.providerId });
  }
  const debug = options.includeDebug === true ? value.debug : void 0;
  const reportedProvider = typeof value.provider === "string" && value.provider.trim() !== "" ? value.provider : options.providerId;
  return createDecisionResult({
    provider: reportedProvider,
    mode: options.mode,
    selected: resolvedSelected,
    ranking,
    latencyMs: options.latencyMs,
    ...sanitizeUsage(value.usage) === void 0 ? {} : { usage: sanitizeUsage(value.usage) },
    ...confidence.confidence === void 0 ? {} : { confidence: confidence.confidence },
    ...confidence.confidenceKind === void 0 ? {} : { confidenceKind: confidence.confidenceKind },
    ...debug === void 0 ? {} : { debug }
  });
}
function rankByScore(entries) {
  return entries.map((entry, index) => ({ id: entry.id, score: entry.score, index })).sort(byScoreDescending).map((entry) => entry.score === void 0 ? { id: entry.id } : { id: entry.id, score: entry.score });
}

// src/core/decision-engine.ts
var DEFAULT_CONFIDENCE_THRESHOLD = 0.55;
function defaultClock() {
  return performance.now();
}
var DecisionEngine = class {
  #registry;
  #router;
  #config;
  #telemetry;
  #now;
  constructor(config = {}, registry = new DecisionProviderRegistry()) {
    this.#registry = registry;
    this.#router = new DecisionRouter(registry, {
      ...config.defaultProviderId === void 0 ? {} : { defaultProviderId: config.defaultProviderId },
      ...config.allowCapabilityFallback === void 0 ? {} : { allowCapabilityFallback: config.allowCapabilityFallback }
    });
    this.#config = {
      confidenceThreshold: config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
      timeoutMs: config.timeoutMs ?? 3e4,
      allowCapabilityFallback: config.allowCapabilityFallback ?? true
    };
    this.#telemetry = config.telemetry;
    this.#now = config.now ?? defaultClock;
  }
  /** The provider registry, so a composition root can register providers. */
  get registry() {
    return this.#registry;
  }
  /** The routing policy, exposed read-only for diagnostics. */
  get router() {
    return this.#router;
  }
  /** The configured confidence floor. */
  get confidenceThreshold() {
    return this.#config.confidenceThreshold;
  }
  /** Per-decision ceiling, also honored inside a longer task. */
  get timeoutMs() {
    return this.#config.timeoutMs;
  }
  /**
   * Apply a configuration change to the live engine.
   *
   * The engine holds no per-call state, so this is safe to call at any time —
   * a decision already in flight keeps the values it started with. The default
   * provider is re-pointed through the registry, which validates it.
   */
  reconfigure(config) {
    if (config.confidenceThreshold !== void 0) this.#config.confidenceThreshold = config.confidenceThreshold;
    if (config.timeoutMs !== void 0) this.#config.timeoutMs = config.timeoutMs;
    if (config.allowCapabilityFallback !== void 0) this.#config.allowCapabilityFallback = config.allowCapabilityFallback;
    if (config.defaultProviderId !== void 0) this.#router.setDefaultProvider(config.defaultProviderId);
    if (config.telemetry !== void 0) this.#setTelemetry(config.telemetry);
  }
  /**
   * Answer one decision request.
   *
   * @param request - objective, state, finite candidates, optional mode/provider.
   * @param options - transport concerns: cancellation, budget, debug, environment.
   * @returns the normalized decision result.
   * @throws DecisionError for every refusal; never a bare Error.
   */
  async decide(request, options = {}) {
    const started = this.#now();
    let candidateCount;
    let providerId;
    let mode;
    try {
      const validated = validateRequest(request);
      mode = validated.mode;
      candidateCount = validated.request.candidates.length;
      const explicitProvider = options.provider ?? request.provider;
      const route = this.#router.route(
        explicitProvider === void 0 ? request : { ...request, provider: explicitProvider },
        validated.mode
      );
      providerId = route.providerId;
      const provider = this.#registry.require(providerId);
      this.#registry.assertCapability(providerId, validated.mode);
      const budgetMs = options.timeoutMs ?? this.#config.timeoutMs;
      const callStarted = this.#now();
      const raw = await this.#callProvider(provider, request, validated.mode, budgetMs, options);
      const latencyMs = this.#now() - callStarted;
      const result = normalizeDecisionResult(raw, {
        providerId,
        mode: validated.mode,
        validated,
        latencyMs,
        includeDebug: options.debug === true
      });
      const threshold = options.confidenceThreshold ?? this.#config.confidenceThreshold;
      const gateable = result.confidenceKind === "normalized" && result.confidence !== void 0;
      if (threshold > 0 && gateable && (result.confidence ?? 0) < threshold && (validated.mode === "choice" || validated.mode === "classification")) {
        throw new DecisionError("low_confidence", `Provider "${providerId}" returned normalized confidence ${(result.confidence ?? 0).toFixed(3)}, below the ${threshold} floor.`, {
          subject: providerId,
          details: {
            confidence: result.confidence,
            confidenceKind: result.confidenceKind,
            threshold,
            selected: result.selected
          }
        });
      }
      this.#emit({
        kind: options.step === void 0 ? "decision" : "step",
        provider: providerId,
        mode: validated.mode,
        candidateCount,
        ...result.selected === void 0 ? {} : { selected: result.selected },
        ...result.confidence === void 0 ? {} : { confidence: result.confidence },
        ...result.confidenceKind === void 0 ? {} : { confidenceKind: result.confidenceKind },
        ...result.usage?.inputTokens === void 0 ? {} : { inputTokens: result.usage.inputTokens },
        ...options.environment === void 0 ? {} : { environment: options.environment },
        ...options.step === void 0 ? {} : { step: options.step },
        timings: {
          ...options.sourceTimings ?? {},
          decisionMs: result.latencyMs,
          totalMs: this.#now() - started
        }
      });
      return result;
    } catch (error) {
      const failure = toDecisionFailure(error);
      this.#emit({
        kind: options.step === void 0 ? "decision" : "step",
        ...providerId === void 0 ? {} : { provider: providerId },
        ...mode === void 0 ? {} : { mode },
        ...candidateCount === void 0 ? {} : { candidateCount },
        ...options.environment === void 0 ? {} : { environment: options.environment },
        ...options.step === void 0 ? {} : { step: options.step },
        escalationReason: failure.code,
        timings: { ...options.sourceTimings ?? {}, totalMs: this.#now() - started }
      });
      throw error instanceof DecisionError ? error : new DecisionError(failure.code, failure.message, {
        ...failure.details === void 0 ? {} : { details: failure.details },
        cause: error
      });
    }
  }
  /** Health of every registered provider. */
  async health() {
    return this.#registry.health();
  }
  /** Dispose every provider and clear the registry. */
  async dispose() {
    await this.#registry.disposeAll();
  }
  /**
   * Invoke one provider under a deadline.
   *
   * The deadline is enforced by racing the provider's promise, not by trusting
   * the provider to honor the signal: a model runtime that ignores abort would
   * otherwise hold the step forever. The signal is still passed through so a
   * cooperative provider can stop its own work.
   */
  async #callProvider(provider, request, _mode, budgetMs, options) {
    const providerLabel = provider.id ?? "unknown";
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal !== void 0) {
      if (options.signal.aborted) controller.abort(options.signal.reason);
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    let timer;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("decision timeout"));
        reject(new DecisionError("provider_timeout", `Decision provider "${providerLabel}" exceeded its ${budgetMs}ms budget.`, {
          subject: providerLabel,
          details: { timeoutMs: budgetMs }
        }));
      }, budgetMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    const context = {
      signal: controller.signal,
      timeoutMs: budgetMs,
      ...options.debug === void 0 ? {} : { debug: options.debug },
      ...options.environment === void 0 ? {} : { environment: options.environment }
    };
    try {
      const decision = Promise.resolve(provider.decide(request, context)).catch((error) => {
        if (controller.signal.aborted && !(error instanceof DecisionError)) {
          throw new DecisionError("aborted", "The decision provider was aborted before it settled.", { cause: error });
        }
        throw error;
      });
      return await Promise.race([decision, timeoutPromise]);
    } catch (error) {
      if (error instanceof DecisionError) throw error;
      const failure = toDecisionFailure(error, "provider_failed");
      throw new DecisionError(failure.code, failure.message, {
        ...failure.details === void 0 ? {} : { details: failure.details },
        cause: error
      });
    } finally {
      if (timer !== void 0) clearTimeout(timer);
      if (options.signal !== void 0) options.signal.removeEventListener("abort", onAbort);
    }
  }
  /** Swap the telemetry sink, keeping the failure-containment wrapper. */
  #setTelemetry(sink) {
    this.#telemetry = sink;
  }
  #emit(record) {
    if (this.#telemetry === void 0) return;
    try {
      this.#telemetry(record);
    } catch {
    }
  }
};

// src/core/telemetry.ts
function createRingBufferSink(limit = 200) {
  const records = [];
  return {
    records,
    sink: (record) => {
      records.push(record);
      if (records.length > limit) records.splice(0, records.length - limit);
    }
  };
}

// src/environments/registry.ts
var EnvironmentRegistry = class {
  #adapters = /* @__PURE__ */ new Map();
  /**
   * Register an adapter.
   *
   * @param adapter - the adapter. Its `id` becomes the registry key.
   * @param options - `replace: true` overrides an existing id.
   * @returns the disposer that unregisters it.
   */
  register(adapter, options = {}) {
    const id = adapter?.id;
    if (typeof id !== "string" || id.trim() === "") {
      throw new DecisionError("invalid_request", "An environment adapter must declare a non-empty string id.");
    }
    for (const method of ["observe", "buildDecisionRequest", "mapDecision", "execute"]) {
      if (typeof adapter[method] !== "function") {
        throw new DecisionError("invalid_request", `Environment adapter "${id}" must implement ${method}().`, { subject: id });
      }
    }
    if (this.#adapters.has(id) && options.replace !== true) {
      throw new DecisionError("invalid_request", `Environment adapter "${id}" is already registered.`, {
        subject: id,
        details: { hint: "Pass replace: true to override a registered environment id." }
      });
    }
    this.#adapters.set(id, adapter);
    return () => {
      this.#adapters.delete(id);
    };
  }
  /** Remove an adapter by id. Returns whether anything was removed. */
  unregister(id) {
    return this.#adapters.delete(id);
  }
  /** Whether an id is registered. */
  has(id) {
    return this.#adapters.has(id);
  }
  /** Look up an adapter, or undefined. */
  get(id) {
    return this.#adapters.get(id);
  }
  /**
   * Look up an adapter that must exist.
   *
   * @throws DecisionError with `environment_unknown`.
   */
  require(id) {
    const adapter = this.#adapters.get(id);
    if (adapter === void 0) {
      throw new DecisionError("environment_unknown", `No environment adapter is registered as "${id}".`, {
        subject: id,
        details: { registered: [...this.#adapters.keys()] }
      });
    }
    return adapter;
  }
  /** Every registered environment id, in registration order. */
  ids() {
    return [...this.#adapters.keys()];
  }
  /** Descriptors for every registered adapter. */
  list() {
    return [...this.#adapters.entries()].map(([id, adapter]) => ({
      id,
      source: adapter.source,
      capabilities: [...adapter.capabilities ?? []],
      hasIsDone: typeof adapter.isDone === "function"
    }));
  }
  /** Dispose every registered adapter that owns resources. */
  async disposeAll() {
    for (const [, adapter] of this.#adapters) {
      try {
        await adapter.dispose?.();
      } catch {
      }
    }
    this.#adapters.clear();
  }
};

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
var BrowserEnvironmentAdapter = class _BrowserEnvironmentAdapter {
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
    if (config.includeNonSemantic !== void 0 && typeof config.includeNonSemantic !== "boolean") throw new DecisionError("invalid_request", "includeNonSemantic must be boolean.");
    if (config.candidateSelector !== void 0 && (typeof config.candidateSelector !== "string" || config.candidateSelector.trim() === "")) throw new DecisionError("invalid_request", "candidateSelector must be a non-empty CSS selector.");
    if (config.maxCandidates !== void 0 && (!Number.isInteger(config.maxCandidates) || config.maxCandidates < 1 || config.maxCandidates > 64)) throw new DecisionError("invalid_request", "maxCandidates must be an integer between 1 and 64.");
    this.#config = {
      strategy: config.strategy ?? "form",
      ...config.candidates === void 0 ? {} : { candidates: config.candidates },
      maxCandidates: config.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
      includeNonSemantic: config.includeNonSemantic ?? false,
      ...config.candidateSelector === void 0 ? {} : { candidateSelector: config.candidateSelector },
      maxStateChars: config.maxStateChars ?? DEFAULT_MAX_STATE_CHARS,
      maxObjectiveChars: config.maxObjectiveChars ?? DEFAULT_MAX_OBJECTIVE_CHARS,
      observeTimeoutMs: config.observeTimeoutMs ?? 9e4,
      executeTimeoutMs: config.executeTimeoutMs ?? 9e4
    };
  }
  /** Task-local configuration; never mutates the registered adapter. */
  withConfig(config) {
    return new _BrowserEnvironmentAdapter({ id: this.id, dispatcher: this.#dispatcher, config: { ...this.#config, ...config } });
  }
  /**
   * What counts as progress: the page's meaning, not its addressing.
   *
   * The runtime fingerprints this to notice a stalled run. Element indices are
   * addressing — the bridge numbers an element once and never reuses a number —
   * so a page that rebuilds its controls returns new numbers for an unchanged
   * situation. Fingerprinting the whole state then reports "changed" on every
   * step and the stall guard never fires. Measured on a quiz page that
   * re-created its answer options on every answer: 161 steps, two recorded
   * answers, no `no_progress`.
   */
  progressKey(state) {
    if (state === null || typeof state !== "object") return state;
    const snapshot = state;
    const strip = (entry) => {
      const { index: _index, ...rest } = entry;
      return rest;
    };
    return {
      url: snapshot.url,
      title: snapshot.title,
      status: snapshot.status,
      main: snapshot.main,
      interactive: (snapshot.items ?? []).map(strip),
      forms: (snapshot.forms ?? []).map(strip)
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
      arguments: {
        ...this.#config.includeNonSemantic ? { includeNonSemantic: true } : {},
        ...this.#config.candidateSelector === void 0 ? {} : { candidateSelector: this.#config.candidateSelector }
      },
      ...input?.signal === void 0 ? {} : { signal: input.signal }
    });
    if (!result.ok) {
      const message = result.error ?? "browser_snapshot failed.";
      return failedObservation("browser", "unsupported", message, {
        metadata: { tool: BROWSER_TOOLS.snapshot, hint: "Authorize the browser capability for this session (/browser) and retry." }
      });
    }
    const snapshot = parseBrowserSnapshot(result.text);
    if ((this.#config.includeNonSemantic || this.#config.candidateSelector !== void 0) && (snapshot.inventoryScope?.includeNonSemantic !== this.#config.includeNonSemantic || snapshot.inventoryScope?.candidateSelector !== this.#config.candidateSelector)) {
      return failedObservation("browser", "insufficient", "The browser extension did not acknowledge the requested inventory scope. Upgrade the bridge/extension and retry; no unscoped action will be offered.");
    }
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
        ...item.selected === void 0 ? {} : { selected: item.selected },
        ...item.pressed === void 0 ? {} : { pressed: item.pressed },
        ...item.domClasses === void 0 ? {} : { domClassesUntrusted: item.domClasses },
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
    const fileIndexes = /* @__PURE__ */ new Set();
    for (const field of snapshot.forms) if (field.kind === "file") fileIndexes.add(field.index);
    for (const item of snapshot.items) {
      if (item.role === "file") fileIndexes.add(item.index);
      if (item.role === "input" && item.name.trim().toLowerCase() === "file") fileIndexes.add(item.index);
    }
    const candidates = [];
    const roles = this.#config.includeNonSemantic ? [...PRIMARY_ROLES, "clickable"] : PRIMARY_ROLES;
    const seen = /* @__PURE__ */ new Set();
    const push = (candidate) => {
      if (candidates.length >= this.#config.maxCandidates) return;
      if (seen.has(candidate.id)) return;
      seen.add(candidate.id);
      candidates.push(candidate);
    };
    const items = [...snapshot.items].sort((left, right) => {
      const leftPrimary = roles.includes(left.role) ? 0 : 1;
      const rightPrimary = roles.includes(right.role) ? 0 : 1;
      if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;
      if (left.disabled !== right.disabled) return left.disabled ? 1 : -1;
      return 0;
    });
    for (const item of items) {
      if (item.disabled) continue;
      const role = item.role.toLowerCase();
      if (!roles.includes(role)) continue;
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
      if (fileIndexes.has(field.index)) continue;
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
var DEFAULT_MAX_CANDIDATES2 = 12;
var DEFAULT_MAX_STATE_CHARS2 = 8e3;
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
      maxCandidates: config.maxCandidates ?? DEFAULT_MAX_CANDIDATES2,
      maxStateChars: config.maxStateChars ?? DEFAULT_MAX_STATE_CHARS2,
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
        treeTextUntrusted: truncate2(state.text, this.#config.maxStateChars)
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
    return result.ok ? { ok: true, ...firstLine2(result.text) === void 0 ? {} : { message: firstLine2(result.text) } } : { ok: false, message: result.error ?? `${toolName} failed` };
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
          id: `set-${slug2(label)}-${node.index}`,
          description: `Set the value of "${label}" (${node.role})`,
          action: { kind: "set_value", elementIndex: node.index, value: "" },
          metadata: { role: node.role, index: node.index, settable: true }
        });
        continue;
      }
      if (isAddressable(node)) {
        const actions = node.secondaryActions.length === 0 ? "" : ` \u2014 supports ${node.secondaryActions.join(", ")}`;
        push({
          id: `click-${slug2(label)}-${node.index}`,
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
function truncate2(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit)}\u2026[truncated]`;
}
function slug2(value) {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "item" : cleaned.slice(0, 32);
}
function firstLine2(value) {
  const line = value.split("\n").map((part) => part.trim()).find((part) => part !== "");
  return line === void 0 ? void 0 : line.slice(0, 200);
}

// src/runtime/runner.ts
import { randomUUID } from "node:crypto";
var DEFAULT_RUNTIME_CONFIG = {
  maxSteps: 10,
  maxDurationMs: 12e4,
  confidenceThreshold: 0.55,
  noProgressLimit: 3,
  repeatedDecisionLimit: 3,
  observeTimeoutMs: 9e4,
  executeTimeoutMs: 9e4,
  stepDelayMs: 0,
  stateFingerprintChars: 2e3
};
var DEFAULT_TASK_CONFIG = {
  maxSteps: 1e3,
  maxDurationMs: 6e5,
  repeatedDecisionLimit: 0
};
var DecisionRuntime = class {
  #engine;
  #baseConfig;
  #now;
  #environments;
  #busy = /* @__PURE__ */ new Set();
  constructor(engine, options = {}) {
    this.#engine = engine;
    this.#baseConfig = { ...DEFAULT_RUNTIME_CONFIG, ...options.config };
    void options.telemetry;
    this.#now = options.now ?? (() => performance.now());
    this.#environments = options.environments;
  }
  /** The effective config for a run, given per-run overrides. */
  resolveConfig(overrides) {
    return { ...this.#baseConfig, ...overrides };
  }
  /**
   * Replace the base budgets for subsequent runs.
   *
   * Environments are not rebuilt: their adapters hold per-observation state
   * (a browser index inventory, an accessibility merge base) that a live swap
   * would silently invalidate. Environment toggles therefore take effect on the
   * next start, which is what the settings panel reports.
   */
  reconfigure(overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === void 0 || !(key in this.#baseConfig)) continue;
      this.#baseConfig[key] = value;
    }
  }
  /**
   * Run the loop.
   *
   * @param options - environment, objective, promotion mode, budgets.
   * @returns an outcome whose `status` is one of `decided`, `executed`, `done`, `needs_escalation`.
   *          Infrastructure failures (unknown environment, invalid request) throw a
   *          {@link DecisionError}; runtime *decisions to stop* return `needs_escalation`.
   */
  async runTask(options) {
    const adapter = this.#resolveAdapter(options.environment);
    if ((adapter.source === "browser" || adapter.source === "computer") && adapter.isDone === void 0 && options.objective.completion === void 0 && !options.plan?.length) {
      throw new DecisionError("invalid_request", "A whole browser/desktop task needs a completion rule or an adapter with isDone().");
    }
    const taskId = randomUUID();
    const started = this.#now();
    const outcome2 = await this.run({
      ...options,
      mode: "bounded-loop",
      config: { ...DEFAULT_TASK_CONFIG, ...options.config }
    });
    return { ...outcome2, taskId, durationMs: this.#now() - started };
  }
  async run(options) {
    const config = this.resolveConfig(options.config);
    validateRuntimeConfig(config);
    validateCompletion(options.objective.completion);
    validatePlan(options.plan);
    const adapter = this.#resolveAdapter(options.environment);
    if (this.#busy.has(adapter.id)) {
      throw new DecisionError("environment_unavailable", `Environment "${adapter.id}" already has an active or draining run.`);
    }
    this.#busy.add(adapter.id);
    const pending = /* @__PURE__ */ new Set();
    try {
      return await this.#drive(options, config, adapter, pending);
    } finally {
      if (pending.size === 0) this.#busy.delete(adapter.id);
      else void Promise.allSettled([...pending]).then(() => this.#busy.delete(adapter.id));
    }
  }
  async #drive(options, config, adapter, pending) {
    const startedAt = this.#now();
    const mode = options.mode ?? "decision-only";
    if (!["decision-only", "single-step", "bounded-loop"].includes(mode)) throw new DecisionError("invalid_request", "Unknown execution mode.");
    const objective = options.objective;
    const plan = options.plan;
    let planIndex = 0;
    let planStartedAtStep = 0;
    let steps = 0;
    let lastObservation;
    let lastDecision;
    let lastAction;
    let lastExecution;
    let unchangedStreak = 0;
    let repeatedStreak = 0;
    let lastSelected;
    let previousMapMs;
    let previousExecuteMs;
    const check = () => {
      if (options.signal?.aborted) throw new DecisionError("aborted", "The run was aborted by the caller.");
      const remaining = config.maxDurationMs - (this.#now() - startedAt);
      if (remaining <= 0) throw new DecisionError("budget_exhausted", "The task duration budget was exhausted.");
      return remaining;
    };
    const phase = async (name, limit, work) => {
      const ms = Math.min(limit, check());
      const controller = new AbortController();
      let rejectStop = () => void 0;
      const stopped = new Promise((_resolve, reject) => {
        rejectStop = reject;
      });
      const stop = (error) => {
        rejectStop(error);
        controller.abort(error);
      };
      const phaseDetails = { phase: name, ...name === "execute" ? { actionMayHaveExecuted: true } : {} };
      const onAbort = () => stop(new DecisionError("aborted", `Cancelled during ${name}.`, { details: phaseDetails }));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => stop(new DecisionError("budget_exhausted", `${name} exceeded its ${ms}ms budget.`, { details: phaseDetails })), ms);
      const active = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return work(controller.signal, ms);
      });
      pending.add(active);
      void active.then(() => pending.delete(active), () => pending.delete(active));
      try {
        const value = await Promise.race([active, stopped]);
        check();
        return value;
      } catch (error) {
        if (error instanceof DecisionError) throw error;
        const fallback = name === "execute" ? "action_execution_failed" : name === "map action" ? "action_mapping_failed" : "internal";
        const failure = toDecisionFailure(error, fallback);
        throw new DecisionError(failure.code, failure.message, { cause: error, details: phaseDetails });
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      }
    };
    let activeAdapter = adapter;
    let appliedStage;
    const applyStageScope = (stage) => {
      const key = stage?.id ?? "";
      if (key === appliedStage) return;
      appliedStage = key;
      activeAdapter = stage?.scope === void 0 || typeof adapter.withConfig !== "function" ? adapter : adapter.withConfig(stage.scope);
    };
    applyStageScope(plan?.[planIndex]);
    const observe = () => phase(
      "observe",
      config.observeTimeoutMs,
      (signal, timeoutMs) => activeAdapter.observe({ signal, timeoutMs, objective })
    );
    const assertObservation = (observation) => {
      if (observation.status === "ok") return;
      throw new DecisionError(
        observation.status === "insufficient" ? "insufficient_observation" : observation.status === "unsupported" ? "environment_unsupported" : "environment_unavailable",
        observation.reason ?? `Environment "${adapter.id}" returned ${observation.status}.`
      );
    };
    const progressKey = (state) => typeof activeAdapter.progressKey === "function" ? activeAdapter.progressKey(state) : state;
    const isDone = (observation) => phase("completion check", config.observeTimeoutMs, async () => observation.done === true || completionMatches(observation.state, objective.completion) || await activeAdapter.isDone?.(observation, objective) === true);
    const checkCompletion = async (observation) => {
      if (plan !== void 0) {
        while (planIndex < plan.length && completionMatches(observation.state, plan[planIndex].completion)) {
          planIndex++;
          planStartedAtStep = steps;
        }
        applyStageScope(plan[planIndex]);
        if (planIndex === plan.length) return true;
      }
      return isDone(observation);
    };
    const outcome2 = (status, stopReason) => ({
      status,
      environment: adapter.id,
      steps,
      stopReason,
      ...steps === 0 ? {} : { stepIndex: steps - 1 },
      ...lastDecision === void 0 ? {} : { decision: lastDecision },
      ...lastAction === void 0 ? {} : { action: lastAction },
      ...lastExecution === void 0 ? {} : { execution: lastExecution },
      ...lastObservation?.state === void 0 ? {} : { finalState: lastObservation.state },
      ...(lastObservation?.result ?? lastExecution?.result) === void 0 ? {} : { result: lastObservation?.result ?? lastExecution?.result },
      ...plan === void 0 ? {} : {
        completedPlanSteps: plan.slice(0, planIndex).map((stage) => stage.id),
        ...plan[planIndex] === void 0 ? {} : { activePlanStep: plan[planIndex].id }
      }
    });
    try {
      const observeStarted = this.#now();
      lastObservation = await observe();
      let observeMs = this.#now() - observeStarted;
      assertObservation(lastObservation);
      const maxSteps = mode === "bounded-loop" ? config.maxSteps : 1;
      for (let step = 0; step < maxSteps; step += 1) {
        check();
        if (await checkCompletion(lastObservation)) return outcome2("done", "The environment is terminal or the configured completion conditions are met.");
        const stage = plan?.[planIndex];
        if (stage?.maxSteps !== void 0 && steps - planStartedAtStep >= stage.maxSteps) {
          throw new DecisionError("budget_exhausted", `Plan step "${stage.id}" reached its ${stage.maxSteps}-action budget.`);
        }
        const stepObjective = stage === void 0 ? objective : {
          ...objective,
          description: `Current plan step (${stage.id}): ${stage.objective}
Overall task: ${objective.description}`
        };
        let request = await phase("build request", config.observeTimeoutMs, () => activeAdapter.buildDecisionRequest(lastObservation, stepObjective));
        if (options.candidates !== void 0) request = { ...request, candidates: options.candidates };
        if (options.provider !== void 0) request = { ...request, provider: options.provider };
        if (options.decisionMode !== void 0) request = { ...request, mode: options.decisionMode };
        request = { ...request, metadata: { ...request.metadata, environment: adapter.id, step } };
        lastDecision = await phase("decide", check(), (signal, timeoutMs) => this.#engine.decide(request, {
          signal,
          timeoutMs: Math.min(timeoutMs, this.#engine.timeoutMs),
          debug: options.debug === true,
          environment: adapter.id,
          step,
          confidenceThreshold: config.confidenceThreshold,
          sourceTimings: {
            observeMs,
            ...previousMapMs === void 0 ? {} : { mapMs: previousMapMs },
            ...previousExecuteMs === void 0 ? {} : { executeMs: previousExecuteMs }
          }
        }));
        const mapStarted = this.#now();
        lastAction = await phase("map action", config.executeTimeoutMs, () => activeAdapter.mapDecision(lastDecision, lastObservation));
        previousMapMs = this.#now() - mapStarted;
        if (mode === "decision-only") return { ...outcome2("decided", "Decision-only mode: nothing was executed."), steps: 1, stepIndex: 0 };
        if (lastAction.risky && options.allowRisky !== true) throw new DecisionError("high_risk_action", `Action "${lastAction.candidateId}" requires confirmation.`);
        const before = fingerprintState(progressKey(lastObservation.state), config.stateFingerprintChars);
        const executeStarted = this.#now();
        check();
        lastExecution = await phase("execute", config.executeTimeoutMs, (signal, timeoutMs) => activeAdapter.execute(lastAction, {
          signal,
          timeoutMs,
          allowRisky: options.allowRisky === true
        }));
        steps += 1;
        previousExecuteMs = this.#now() - executeStarted;
        if (!lastExecution.ok) throw new DecisionError("action_execution_failed", lastExecution.message ?? "The environment refused the action.");
        if (lastExecution.observation !== void 0) lastObservation = lastExecution.observation;
        else if (lastExecution.done === true) lastObservation = {
          status: "ok",
          source: adapter.source,
          done: true,
          ...lastExecution.state === void 0 ? {} : { state: lastExecution.state },
          ...lastExecution.result === void 0 ? {} : { result: lastExecution.result }
        };
        if (mode === "single-step") return outcome2("executed", "Single-step mode: exactly one action was executed.");
        if (lastExecution.done === true) {
          assertObservation(lastObservation);
          await checkCompletion(lastObservation);
          return outcome2("done", "The environment reports a terminal result.");
        }
        if (config.stepDelayMs > 0) await phase("settle", check(), (signal) => abortableSleep(config.stepDelayMs, signal));
        const verifyStarted = this.#now();
        if (lastExecution.observation === void 0) lastObservation = await observe();
        observeMs = this.#now() - verifyStarted;
        assertObservation(lastObservation);
        if (await checkCompletion(lastObservation)) return outcome2("done", "The environment is terminal or the configured completion conditions are met.");
        const after = fingerprintState(progressKey(lastObservation.state), config.stateFingerprintChars);
        unchangedStreak = after !== void 0 && after === before ? unchangedStreak + 1 : 0;
        if (config.noProgressLimit > 0 && unchangedStreak >= config.noProgressLimit) throw new DecisionError("no_progress", `The state did not change for ${unchangedStreak} actions.`);
        repeatedStreak = lastDecision.selected === lastSelected ? repeatedStreak + 1 : 0;
        lastSelected = lastDecision.selected;
        if (config.repeatedDecisionLimit > 0 && repeatedStreak >= config.repeatedDecisionLimit) throw new DecisionError("repeated_decision", `The same candidate was chosen ${repeatedStreak + 1} times.`);
      }
      throw new DecisionError("budget_exhausted", `The run reached its ${maxSteps}-step budget without completing.`);
    } catch (error) {
      const failure = toDecisionFailure(error, "internal");
      return {
        ...outcome2("needs_escalation", failure.message),
        escalation: toEscalation(failure, {
          environment: adapter.id,
          ...lastDecision === void 0 ? {} : { provider: lastDecision.provider, lastDecision: {
            ...lastDecision.selected === void 0 ? {} : { selected: lastDecision.selected },
            ...lastDecision.confidence === void 0 ? {} : { confidence: lastDecision.confidence },
            ...lastDecision.confidenceKind === void 0 ? {} : { confidenceKind: lastDecision.confidenceKind },
            step: steps
          } },
          details: { ...failure.details, message: failure.message, steps }
        })
      };
    }
  }
  #resolveAdapter(environment) {
    if (typeof environment !== "string") return environment;
    if (this.#environments === void 0) {
      throw new DecisionError("environment_unknown", `Environment "${environment}" cannot be resolved: this runtime has no environment registry.`, {
        subject: environment
      });
    }
    return this.#environments.require(environment);
  }
};
function fingerprintState(state, limit) {
  if (state === void 0 || state === null) return void 0;
  if (typeof state === "string") return state.length > limit ? state.slice(0, limit) : state;
  try {
    const json = JSON.stringify(state);
    if (json === void 0) return void 0;
    return json.length > limit ? json.slice(0, limit) : json;
  } catch {
    return void 0;
  }
}
function abortableSleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function validateRuntimeConfig(config) {
  for (const key of ["maxSteps", "maxDurationMs", "observeTimeoutMs", "executeTimeoutMs", "stateFingerprintChars"]) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) throw new DecisionError("invalid_request", `${key} must be finite and positive.`);
  }
  for (const key of ["noProgressLimit", "repeatedDecisionLimit", "stepDelayMs"]) {
    if (!Number.isFinite(config[key]) || config[key] < 0) throw new DecisionError("invalid_request", `${key} must be finite and non-negative.`);
  }
  if (!Number.isInteger(config.maxSteps)) throw new DecisionError("invalid_request", "maxSteps must be an integer.");
  if (!Number.isFinite(config.confidenceThreshold) || config.confidenceThreshold < 0 || config.confidenceThreshold > 1) throw new DecisionError("invalid_request", "confidenceThreshold must be between 0 and 1.");
}
function validateCompletion(rule) {
  if (rule === void 0) return;
  if (rule === null || typeof rule !== "object" || typeof rule.path !== "string" || rule.path.trim() === "" || rule.equals === void 0 === (rule.includes === void 0) || rule.includes !== void 0 && (typeof rule.includes !== "string" || rule.includes === "") || rule.equals !== void 0 && !["string", "number", "boolean"].includes(typeof rule.equals)) {
    throw new DecisionError("invalid_request", "completion needs a path and exactly one of equals/includes.");
  }
}
function validatePlan(plan) {
  if (plan === void 0) return;
  if (!Array.isArray(plan) || plan.length === 0 || plan.length > 64) throw new DecisionError("invalid_request", "A plan must contain between 1 and 64 stages.");
  const ids = /* @__PURE__ */ new Set();
  for (const stage of plan) {
    if (stage === null || typeof stage !== "object" || typeof stage.id !== "string" || stage.id.trim() === "" || ids.has(stage.id) || typeof stage.objective !== "string" || stage.objective.trim() === "" || stage.completion === void 0 || stage.maxSteps !== void 0 && (!Number.isInteger(stage.maxSteps) || stage.maxSteps <= 0) || stage.scope !== void 0 && (stage.scope === null || typeof stage.scope !== "object" || Array.isArray(stage.scope))) {
      throw new DecisionError("invalid_request", "Each plan stage needs a unique id, an objective, a completion rule, and an optional positive integer maxSteps; scope, when present, must be an object.");
    }
    ids.add(stage.id);
    validateCompletion(stage.completion);
  }
}
function completionMatches(state, rule) {
  if (rule === void 0) return false;
  let value = state;
  for (const key of rule.path.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return false;
    value = value[key];
  }
  return rule.includes === void 0 ? value === rule.equals : typeof value === "string" && value.includes(rule.includes);
}

// src/providers/laya/config.ts
var DEFAULT_SCORE_LEVELS = [
  "a very poor choice",
  "a poor choice",
  "an acceptable choice",
  "a good choice",
  "a very good choice"
];
var DEFAULT_CHOICE_INSTRUCTIONS = [
  "You are choosing the single best next action for an agent.",
  "Objective: {{objective}}",
  "There are exactly {{count}} options, listed in criteria.",
  "Choose the one option that best advances the objective given the state."
].join("\n");
var DEFAULT_SCORE_INSTRUCTIONS = [
  "Rate how good each option is as the next action for an agent.",
  "Objective: {{objective}}",
  "Score the option named in the question using the criteria scale.",
  "Higher is better."
].join("\n");
var DEFAULT_NOUL_INSTRUCTIONS = [
  "Answer whether the first option should be chosen over the second.",
  "Objective: {{objective}}",
  'Question: is "{{first}}" the better next action than "{{second}}"?'
].join("\n");
function resolveLayaConfig(config = {}, env = process.env) {
  const modelDir = config.modelDir ?? env.LAYA_MODEL_DIR;
  const device = config.device ?? env.LAYA_EP;
  const threads = config.threads ?? numberFromEnv(env.LAYA_THREADS);
  const executionProviders = device === void 0 || device.trim() === "" ? ["cpu"] : device.split(",").map((part) => part.trim()).filter((part) => part !== "");
  return {
    autoLoad: config.autoLoad ?? false,
    idleTtlMs: Math.max(0, config.idleTtlMs ?? 0),
    modelDir: modelDir === void 0 || modelDir.trim() === "" ? void 0 : modelDir,
    executionProviders,
    threads: threads ?? 0,
    required: config.required ?? false,
    strictCandidates: config.strictCandidates ?? true,
    classificationBinaryMode: config.classificationBinaryMode ?? "choice",
    scoringMode: config.scoringMode ?? "per-candidate",
    scoreLevels: config.scoreLevels !== void 0 && config.scoreLevels.length >= 2 ? [...config.scoreLevels] : [...DEFAULT_SCORE_LEVELS],
    scoreInstructions: config.scoreInstructions ?? DEFAULT_SCORE_INSTRUCTIONS,
    choiceInstructions: config.choiceInstructions ?? DEFAULT_CHOICE_INSTRUCTIONS,
    noulInstructions: config.noulInstructions ?? DEFAULT_NOUL_INSTRUCTIONS,
    timeoutMs: config.timeoutMs ?? 3e4,
    maxStateChars: config.maxStateChars ?? 2e4,
    maxCandidateMetadataChars: config.maxCandidateMetadataChars ?? 500
  };
}
function numberFromEnv(value) {
  if (value === void 0 || value.trim() === "") return void 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function fillTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = values[key];
    return value === void 0 ? "" : String(value);
  });
}

// src/providers/laya/shared.ts
function serializeState(state, limit) {
  if (typeof state === "string") return truncate3(state, limit);
  try {
    const json = JSON.stringify(state, null, 2);
    if (json === void 0) return String(state);
    return truncate3(json, limit);
  } catch (error) {
    throw new DecisionError("invalid_request", `The decision state could not be serialized: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function renderCandidate(candidate, metadataLimit) {
  const metadata = candidate.metadata === void 0 ? "" : ` ${truncate3(JSON.stringify(candidate.metadata) ?? "{}", metadataLimit)}`;
  return `${candidate.id}: ${candidate.description}${metadata}`;
}
function choiceCriteria(candidates) {
  const criteria = {};
  for (const candidate of candidates) criteria[candidate.id] = candidate.description;
  return criteria;
}
function renderCandidateList(candidates, metadataLimit) {
  return candidates.map((candidate) => renderCandidate(candidate, metadataLimit)).join("\n");
}
function argmax(probabilities) {
  if (probabilities === void 0) return void 0;
  let best;
  for (const [id, value] of Object.entries(probabilities)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (best === void 0 || value > best.value) best = { id, value };
  }
  return best?.id;
}
function clampRawConfidence(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
  return clamp01(value);
}
function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
function truncate3(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit)}\u2026[truncated]`;
}

// src/providers/laya/modes.ts
var QUESTION_KEYS = {
  select: "select",
  binary: "binary",
  ratePrefix: "rate::"
};
function objectiveLine(objective) {
  return objective === void 0 || objective.trim() === "" ? "(not specified)" : objective;
}
function planQuestions(mode, validated, config) {
  const { request, byId } = validated;
  const candidates = request.candidates;
  const state = serializeState(request.state, config.maxStateChars);
  const constraints = request.constraints === void 0 || request.constraints.length === 0 ? "" : `
Constraints:
${request.constraints.map((item) => `- ${item}`).join("\n")}`;
  const objective = objectiveLine(request.objective);
  if (mode === "choice") {
    return {
      state,
      questions: [{
        key: QUESTION_KEYS.select,
        question: {
          type: "choice",
          instructions: `${fillTemplate(config.choiceInstructions, { objective, count: candidates.length })}

State:
${state}${constraints}

Options:
${renderCandidateList(candidates, config.maxCandidateMetadataChars)}`,
          criteria: choiceCriteria(candidates)
        }
      }]
    };
  }
  if (mode === "classification") {
    if (candidates.length === 2 && config.classificationBinaryMode === "noul") {
      const first = candidates[0];
      const second = candidates[1];
      if (first === void 0 || second === void 0) {
        throw new DecisionError("invalid_decision", "Binary classification requires exactly two candidates.");
      }
      void byId;
      return {
        state,
        questions: [{
          key: QUESTION_KEYS.binary,
          question: {
            type: "noul",
            instructions: `${fillTemplate(config.noulInstructions, { objective, first: first.id, second: second.id })}

State:
${state}${constraints}

Option 1 (${first.id}): ${first.description}
Option 2 (${second.id}): ${second.description}`,
            criteria: { true: first.description, false: second.description }
          }
        }]
      };
    }
    return {
      state,
      questions: [{
        key: QUESTION_KEYS.select,
        question: {
          type: "choice",
          instructions: `Classify the state into exactly one option.
Objective: ${objective}

State:
${state}${constraints}

Options:
${renderCandidateList(candidates, config.maxCandidateMetadataChars)}`,
          criteria: choiceCriteria(candidates)
        }
      }]
    };
  }
  const questions = candidates.map((candidate) => ({
    key: `${QUESTION_KEYS.ratePrefix}${candidate.id}`,
    candidateId: candidate.id,
    question: {
      type: "score",
      instructions: `${fillTemplate(config.scoreInstructions, { objective, count: candidates.length })}

State:
${state}${constraints}

The option to rate is "${candidate.id}": ${candidate.description}`,
      criteria: [...config.scoreLevels]
    }
  }));
  return { state, questions };
}
function translateAnswers(mode, plan, result, config, candidateIds) {
  const notes = [];
  const candidates = new Set(candidateIds);
  if (mode === "choice" || mode === "classification" && plan.questions[0]?.question.type === "choice") {
    const answer = result.answers[QUESTION_KEYS.select];
    if (answer === void 0) {
      throw new DecisionError("invalid_decision", "Laya returned no answer for the choice question.", { subject: "laya" });
    }
    const probabilities = sanitizeProbabilities(answer.probabilities, candidates);
    let selected2 = typeof answer.choice === "string" && candidates.has(answer.choice) ? answer.choice : void 0;
    if (selected2 === void 0) {
      const fallback = argmax(probabilities) ?? candidateIds[0];
      if (fallback !== void 0 && candidates.has(fallback)) {
        selected2 = fallback;
        notes.push(answer.probabilities === void 0 ? "The model returned no usable option; used the first candidate." : `The model's choice ${JSON.stringify(answer.choice ?? null)} was not a listed option; used the highest-probability option instead.`);
      }
    }
    if (selected2 === void 0) {
      throw new DecisionError("invalid_decision", "Laya produced no usable option for the choice question.", { subject: "laya" });
    }
    const ranking2 = rankingFromProbabilities(probabilities, candidateIds, selected2);
    return {
      selected: selected2,
      ranking: ranking2,
      // Verbatim SDK confidence. Labelled `provider_raw` by `toResult`, so the
      // engine reports it and never gates on it.
      confidence: clampRawConfidence(answer.confidence),
      score: scoreOf(ranking2, selected2),
      raw: { [QUESTION_KEYS.select]: answer },
      notes
    };
  }
  if (mode === "classification" && plan.questions[0]?.question.type === "noul") {
    const answer = result.answers[QUESTION_KEYS.binary];
    if (answer === void 0 || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
      throw new DecisionError("invalid_decision", "Laya returned no numeric noul answer for the binary classification.", { subject: "laya" });
    }
    const pTrue = clampRawConfidence(answer.noul) ?? 0;
    const first = candidateIds[0];
    const second = candidateIds[1];
    if (first === void 0 || second === void 0) {
      throw new DecisionError("invalid_decision", "Binary classification requires exactly two candidates.", { subject: "laya" });
    }
    const selected2 = pTrue >= 0.5 ? first : second;
    notes.push(`noul ${pTrue.toFixed(4)} mapped to the generic classification result (threshold 0.5).`);
    const dominance = pTrue >= 0.5 ? pTrue : 1 - pTrue;
    return {
      selected: selected2,
      ranking: [
        { id: selected2, score: dominance },
        { id: selected2 === first ? second : first, score: 1 - dominance }
      ],
      // `noul` has no separate confidence field; the winning side's probability
      // is the model's own number, reported as provider_raw like the rest.
      confidence: clampRawConfidence(dominance),
      score: dominance,
      raw: { [QUESTION_KEYS.binary]: answer },
      notes
    };
  }
  const maxLevel = Math.max(1, config.scoreLevels.length - 1);
  const entries = [];
  const confidences = [];
  const raw = {};
  for (const planned of plan.questions) {
    const candidateId = planned.candidateId;
    if (candidateId === void 0) continue;
    const answer = result.answers[planned.key];
    raw[planned.key] = answer;
    const level = answer?.score;
    if (typeof level !== "number" || !Number.isFinite(level)) {
      notes.push(`The model returned no score for "${candidateId}".`);
      continue;
    }
    const clamped = Math.min(maxLevel, Math.max(0, level));
    if (clamped !== level) notes.push(`Score ${level} for "${candidateId}" was clamped to the ${config.scoreLevels.length}-level scale.`);
    entries.push({ id: candidateId, score: clamped / maxLevel });
    if (typeof answer?.confidence === "number" && Number.isFinite(answer.confidence)) confidences.push(answer.confidence);
  }
  if (entries.length === 0) {
    throw new DecisionError("invalid_decision", "Laya returned no usable score for any candidate.", { subject: "laya" });
  }
  const ranking = rankByScore(entries);
  const selected = ranking[0]?.id;
  if (selected === void 0) {
    throw new DecisionError("invalid_decision", "Laya produced no ranked candidate.", { subject: "laya" });
  }
  const meanConfidence = confidences.length === 0 ? void 0 : confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
  return {
    selected,
    ranking,
    confidence: meanConfidence === void 0 ? void 0 : clampRawConfidence(meanConfidence),
    score: scoreOf(ranking, selected),
    raw,
    notes
  };
}
function sanitizeProbabilities(probabilities, candidates) {
  if (probabilities === void 0) return void 0;
  const cleaned = {};
  for (const [id, value] of Object.entries(probabilities)) {
    if (!candidates.has(id)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    cleaned[id] = value;
  }
  return Object.keys(cleaned).length === 0 ? void 0 : cleaned;
}
function rankingFromProbabilities(probabilities, candidateIds, selected) {
  const entries = candidateIds.map((id) => {
    const probability = probabilities?.[id];
    return typeof probability === "number" && Number.isFinite(probability) ? { id, score: probability } : { id };
  });
  const ranked = rankByScore(entries);
  if (ranked[0]?.id !== selected) {
    const without = ranked.filter((entry) => entry.id !== selected);
    return [{ id: selected, ...probabilities?.[selected] === void 0 ? {} : { score: probabilities[selected] } }, ...without];
  }
  return ranked;
}
function scoreOf(ranking, selected) {
  return ranking.find((entry) => entry.id === selected)?.score;
}
function toResult(translated, options) {
  const debug = {
    ...options.includeDebug ? { raw: translated.raw } : {},
    ...translated.confidence === void 0 ? {} : { rawConfidence: translated.confidence },
    ...translated.notes.length === 0 ? {} : { notes: translated.notes }
  };
  const hasDebug = options.includeDebug || translated.confidence !== void 0 || translated.notes.length > 0;
  const confidenceKind = translated.confidence === void 0 ? "unavailable" : "provider_raw";
  return {
    provider: options.providerId,
    mode: options.mode,
    ...translated.selected === void 0 ? {} : { selected: translated.selected },
    ranking: translated.ranking,
    ...translated.confidence === void 0 ? {} : { confidence: translated.confidence },
    confidenceKind,
    latencyMs: options.latencyMs,
    // Token accounting belongs to the protocol, not to provider-private stats:
    // without it an integrator reaches into `runtime.stats` to count tokens,
    // which couples it to this provider's internals.
    ...options.inputTokens === void 0 ? {} : { usage: { inputTokens: options.inputTokens } },
    ...hasDebug ? { debug } : {}
  };
}

// src/providers/laya/runtime.ts
var defaultLayaModuleLoader = async () => {
  try {
    return await import("@receptron/laya");
  } catch (error) {
    const failure = new DecisionError("provider_unavailable", `The Laya SDK (@receptron/laya) is not installed or could not be imported: ${error instanceof Error ? error.message : String(error)}`, {
      subject: "laya",
      details: { hint: "Install @receptron/laya in the profile, or point providers.laya.modelDir at a local bundle." },
      cause: error
    });
    throw failure;
  }
};
var LayaRuntime = class {
  #config;
  #loadModule;
  #instance;
  #loadPromise;
  #status = "idle";
  #error;
  #loadMs = 0;
  #queue = Promise.resolve();
  #stats = { calls: 0, failures: 0, lastLatencyMs: 0, totalLatencyMs: 0, inputTokens: 0 };
  #idleTtlMs;
  #idleCheckIntervalMs;
  #now;
  #idleTimer;
  #lastUsedAt = 0;
  #unloads = 0;
  constructor(options = {}) {
    this.#config = resolveLayaConfig(options.config);
    this.#loadModule = options.loadModule ?? defaultLayaModuleLoader;
    this.#now = options.now ?? (() => Date.now());
    this.#idleTtlMs = Math.max(0, options.idleTtlMs ?? this.#config.idleTtlMs);
    this.#idleCheckIntervalMs = Math.max(5, options.idleCheckIntervalMs ?? Math.min(this.#idleTtlMs || 3e4, 3e4));
    if (options.instance !== void 0) {
      this.#instance = options.instance;
      this.#status = "ready";
      this.#loadPromise = Promise.resolve(options.instance);
      this.#lastUsedAt = this.#now();
      this.#armIdleTimer();
    } else if (options.autoLoad === true) {
      void this.load().catch(() => void 0);
    }
  }
  /** How many times an idle session has been released. */
  get unloads() {
    return this.#unloads;
  }
  /** The configured idle TTL in milliseconds; `0` means "stay resident". */
  get idleTtlMs() {
    return this.#idleTtlMs;
  }
  /** The resolved, environment-applied configuration. */
  get config() {
    return this.#config;
  }
  /** Current runtime status. */
  get status() {
    return this.#status;
  }
  /** Last load or call error, when any. */
  get error() {
    return this.#error;
  }
  /** Milliseconds the last successful load took. */
  get loadMs() {
    return this.#loadMs;
  }
  /** A copy of the call statistics. */
  get stats() {
    return { ...this.#stats };
  }
  /** The loaded instance, when ready. */
  get instance() {
    return this.#instance;
  }
  /**
   * Load the SDK and open the ONNX session. Idempotent and concurrent-safe: a
   * second caller awaits the first load.
   *
   * A missing module lands as `offline` (the SDK is not installed); any other
   * failure lands as `failed`. The distinction matters: `offline` is a
   * deployment choice, `failed` is a broken deployment.
   */
  async load() {
    if (this.#instance !== void 0 && this.#status === "ready") return this.#instance;
    if (this.#loadPromise !== void 0 && this.#status === "loading") return this.#loadPromise;
    this.#status = "loading";
    this.#error = void 0;
    const started = Date.now();
    const attempt = (async () => {
      try {
        const module = await this.#loadModule();
        const options = {};
        if (this.#config.modelDir !== void 0) options.modelDir = this.#config.modelDir;
        if (this.#config.executionProviders.length > 0) options.executionProviders = this.#config.executionProviders;
        if (this.#config.threads > 0) options.sessionOptions = { intraOpNumThreads: this.#config.threads };
        const instance = await module.Laya.load(options);
        this.#instance = instance;
        this.#loadMs = this.#now() - started;
        this.#status = "ready";
        this.#lastUsedAt = this.#now();
        this.#armIdleTimer();
        return instance;
      } catch (error) {
        const decisionError = error instanceof DecisionError ? error : new DecisionError("provider_unavailable", `Laya failed to load: ${error instanceof Error ? error.message : String(error)}`, {
          subject: "laya",
          details: { modelDir: this.#config.modelDir },
          cause: error
        });
        this.#status = decisionError.code === "provider_unavailable" && /not installed|not be imported/i.test(decisionError.message) ? "offline" : "failed";
        this.#error = decisionError.message;
        this.#loadPromise = void 0;
        throw decisionError;
      }
    })();
    this.#loadPromise = attempt;
    return attempt;
  }
  /**
   * Ask the model every question about one state, in one forward pass.
   *
   * Calls are serialized: `engine.ask` chains onto the queue regardless of how
   * many callers arrive at once.
   *
   * @throws DecisionError with `provider_unavailable` when the model is not ready.
   */
  async systemOne(state, questions, signal) {
    const run = async () => {
      const instance = this.#instance ?? await this.load();
      if (this.#status !== "ready") {
        throw new DecisionError("provider_unavailable", `Laya is not ready (status=${this.#status}${this.#error === void 0 ? "" : `: ${this.#error}`}).`, {
          subject: "laya",
          details: { status: this.#status }
        });
      }
      if (signal?.aborted === true) {
        throw new DecisionError("aborted", "The Laya call was aborted before it started.", { subject: "laya" });
      }
      const started = Date.now();
      try {
        const result = await instance.systemOne(state, questions);
        this.#stats.calls += 1;
        this.#stats.lastLatencyMs = Date.now() - started;
        this.#stats.totalLatencyMs += this.#stats.lastLatencyMs;
        this.#stats.inputTokens += result.usage?.input_tokens ?? 0;
        this.#lastUsedAt = this.#now();
        this.#armIdleTimer();
        return result;
      } catch (error) {
        this.#stats.failures += 1;
        if (error instanceof DecisionError) throw error;
        throw new DecisionError("provider_failed", `Laya inference failed: ${error instanceof Error ? error.message : String(error)}`, {
          subject: "laya",
          cause: error
        });
      }
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.then(() => void 0, () => void 0);
    return next;
  }
  /**
   * Release the ONNX session, freeing its weights. The next call loads again.
   *
   * @returns whether a session was actually open.
   */
  async unload() {
    this.#clearIdleTimer();
    const instance = this.#instance;
    this.#instance = void 0;
    this.#loadPromise = void 0;
    if (instance === void 0) {
      if (this.#status !== "failed" && this.#status !== "offline") this.#status = "idle";
      return false;
    }
    this.#status = "idle";
    this.#unloads += 1;
    try {
      await instance.close();
    } catch {
    }
    return true;
  }
  /** Release the session for good. A later call reloads, unlike {@link unload}'s idle case. */
  async close() {
    await this.unload();
    this.#status = "closed";
  }
  /** Arm (or re-arm) the idle-release timer. No-op when the TTL is 0. */
  #armIdleTimer() {
    if (this.#idleTtlMs <= 0 || this.#instance === void 0) return;
    this.#clearIdleTimer();
    const timer = setInterval(() => {
      if (this.#instance === void 0) {
        this.#clearIdleTimer();
        return;
      }
      if (this.#now() - this.#lastUsedAt < this.#idleTtlMs) return;
      void this.unload().catch(() => void 0);
    }, this.#idleCheckIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
    this.#idleTimer = timer;
  }
  #clearIdleTimer() {
    if (this.#idleTimer === void 0) return;
    clearInterval(this.#idleTimer);
    this.#idleTimer = void 0;
  }
};

// src/providers/laya/provider.ts
var LayaDecisionProvider = class {
  id;
  capabilities = ["choice", "ranking", "score", "classification"];
  #runtime;
  constructor(options = {}) {
    this.id = options.id ?? "laya";
    this.#runtime = options.runtime ?? new LayaRuntime({
      ...options.config === void 0 ? {} : { config: options.config },
      ...options.loadModule === void 0 ? {} : { loadModule: options.loadModule },
      ...options.instance === void 0 ? {} : { instance: options.instance },
      // Both defaults come from the resolved config, so `providers.laya.autoLoad`
      // and `providers.laya.idleTtlMs` work without a code change.
      autoLoad: options.autoLoad ?? resolveLayaConfig(options.config).autoLoad,
      ...options.idleTtlMs === void 0 ? {} : { idleTtlMs: options.idleTtlMs }
    });
  }
  /** The underlying runtime, for diagnostics. */
  get runtime() {
    return this.#runtime;
  }
  /**
   * Answer one decision request.
   *
   * @throws DecisionError with `provider_unavailable`, `provider_timeout`,
   *   `aborted`, `invalid_decision`, or `provider_failed`.
   */
  async decide(request, context) {
    const validated = validateRequest(request);
    const config = this.#runtime.config;
    const started = Date.now();
    const plan = planQuestions(validated.mode, validated, config);
    if (plan.questions.length === 0) {
      throw new DecisionError("invalid_decision", `No question could be planned for mode "${validated.mode}".`, { subject: this.id });
    }
    const questions = {};
    for (const planned of plan.questions) {
      questions[planned.key] = {
        type: planned.question.type,
        instructions: planned.question.instructions,
        ...planned.question.criteria === void 0 ? {} : { criteria: planned.question.criteria }
      };
    }
    const result = await this.#runtime.systemOne(plan.state, questions, context?.signal);
    const latencyMs = Date.now() - started;
    const translated = translateAnswers(validated.mode, plan, result, config, validated.request.candidates.map((candidate) => candidate.id));
    if (config.strictCandidates && translated.selected !== void 0 && !validated.byId.has(translated.selected)) {
      throw new DecisionError("unknown_candidate", `Laya selected "${translated.selected}", which is not in the candidate set.`, {
        subject: this.id,
        details: { selected: translated.selected, candidates: [...validated.byId.keys()] }
      });
    }
    return toResult(translated, {
      providerId: this.id,
      mode: validated.mode,
      latencyMs,
      includeDebug: context?.debug === true,
      ...result.usage?.input_tokens === void 0 ? {} : { inputTokens: result.usage.input_tokens }
    });
  }
  /**
   * Report runtime health.
   *
   * `offline` (the SDK is not installed) is `degraded`, not `unavailable`: the
   * provider is not usable for decisions but the deployment is intentional.
   * The distinction lets a caller choose a fallback provider without treating
   * the whole layer as broken.
   */
  async healthCheck() {
    const status = this.#runtime.status;
    const details = {
      runtimeStatus: status,
      modelDir: this.#runtime.config.modelDir ?? null,
      loadMs: this.#runtime.loadMs,
      idleTtlMs: this.#runtime.idleTtlMs,
      unloads: this.#runtime.unloads,
      required: this.#runtime.config.required,
      stats: this.#runtime.stats
    };
    if (status === "ready") {
      return {
        status: "ok",
        details: { ...details, maxLen: this.#runtime.instance?.config?.max_len ?? null }
      };
    }
    if (status === "offline" || status === "idle") {
      return {
        status: "degraded",
        reason: this.#runtime.error ?? "The Laya model has not been loaded yet.",
        details
      };
    }
    if (status === "loading") {
      return { status: "degraded", reason: "The Laya model is still loading.", details };
    }
    return { status: "unavailable", reason: this.#runtime.error ?? `Laya runtime is ${status}.`, details };
  }
  /** Release the ONNX session. */
  async dispose() {
    await this.#runtime.close();
  }
};

// src/composition.ts
var Config = z.object({
  enabled: z.boolean().default(true).description(
    "Whether the decision layer is active at all. Turning this off removes the tool and stops answering decisions."
  ),
  defaultProvider: z.string().description(
    'Provider id used when a request does not name one (for example "laya"). Leave empty to use the first enabled provider.'
  ),
  providers: z.object({
    // A named sub-object rather than a dict on purpose: a dict renders as an
    // opaque `{}` in the settings panel, which would hide every provider knob
    // (model path, residency, device) behind a hand-edited YAML file. A second
    // provider family adds a sibling key here — provider-private settings still
    // live under `providers.<id>`, never as top-level fields.
    laya: z.object({
      enabled: z.boolean().default(true).description("Whether the Laya provider is registered. Turn off to run the layer without a model."),
      modelDir: z.string().description(
        "Directory holding laya.onnx, laya.onnx.data, laya_config.json and tokenizer/. Setting it skips the SDK freshness check and its download entirely, which is required on a machine whose cache is not writable."
      ),
      device: z.string().default("cpu").description("ONNX execution provider: cpu, coreml, cuda, dml or wasm \u2014 or a comma-separated list."),
      threads: z.number().description("intraOpNumThreads override. 0 leaves the runtime default."),
      autoLoad: z.boolean().default(false).description(
        "Load the model at startup instead of on the first decision. Off by default: a session pins the weights (about 1.6 GB) for as long as it is open."
      ),
      idleTtlMs: z.number().default(0).description(
        "Release the model after this many milliseconds without a decision; the next decision reloads it. 0 keeps it resident for the process lifetime."
      ),
      required: z.boolean().default(false).description("Treat an unavailable model as a hard failure instead of reporting the provider as degraded."),
      strictCandidates: z.boolean().default(true).description("Refuse a model answer that names an option which was not on the ballot."),
      // Deliberately a plain string, not the provider's own union: naming its
      // literals here would put provider vocabulary in the neutral composition
      // root, which is exactly the coupling this project exists to avoid.
      // `resolveLayaConfig` validates the value; this schema only renders it.
      classificationBinaryMode: z.string().default("choice").description(
        "How a two-option classification is asked when the provider supports a binary head; see the provider documentation for the accepted values."
      ),
      scoreLevels: z.array(z.string()).description("Rating scale for ranking and score modes, lowest first."),
      scoringMode: z.string().default("per-candidate").description('Ratings strategy: "per-candidate" rates every option.'),
      timeoutMs: z.number().default(3e4).description("Per-call budget hint in milliseconds."),
      maxStateChars: z.number().default(2e4).description("Maximum characters of serialized state sent to the model.")
    }).description("Laya: the first Decision Provider. Everything here is Laya-private.")
  }).description("Per-provider settings, keyed by provider id. Provider-private fields live here, never as top-level keys."),
  runtime: z.object({
    maxSteps: z.number().default(10).description(
      "Hard step limit for one bounded loop. The run escalates instead of exceeding it."
    ),
    maxDurationMs: z.number().default(12e4).description(
      "Hard wall-clock limit for one bounded loop, in milliseconds."
    ),
    confidenceThreshold: z.number().default(0.55).description(
      'Confidence floor, applied ONLY to decisions whose provider declares confidenceKind "normalized". A provider reporting its own scale (provider_raw) or none (unavailable) is never compared with it.'
    ),
    noProgressLimit: z.number().default(3).description(
      "Stop a loop after this many consecutive steps in which the environment state did not change."
    ),
    repeatedDecisionLimit: z.number().default(3).description(
      "Stop a loop after the same candidate is chosen this many times in a row."
    ),
    observeTimeoutMs: z.number().default(9e4).description(
      "Budget for one observation, and the default provider budget for a single decision, in milliseconds."
    ),
    executeTimeoutMs: z.number().default(9e4).description(
      "Budget for executing one environment action, in milliseconds."
    ),
    stepDelayMs: z.number().default(0).description(
      "Pause between loop steps, in milliseconds, so a page or app can settle."
    ),
    stateFingerprintChars: z.number().default(2e3).description(
      'How many characters of environment state are compared to detect "no progress".'
    )
  }).description("Budgets and stop conditions shared by every environment."),
  browser: z.object({
    includeNonSemantic: z.boolean().default(false).description("Opt in to inferred clickable elements. Requires browser workspace v0.1.10 or newer."),
    candidateSelector: z.string().description("CSS selector limiting inventory candidates before size caps. Prefer task-local overrides for site-specific selectors."),
    enabled: z.boolean().default(true).description("Whether the browser environment is available to the decision layer."),
    environmentId: z.string().description('Environment id to register it under. Defaults to "browser".'),
    maxCandidates: z.number().description("Maximum number of page controls offered to the decider. Defaults to 12."),
    maxStateChars: z.number().description("How much page text is placed into the decision state. Defaults to 6000."),
    candidates: z.array(z.any()).description(
      "Fixed candidate set. When set, the adapter offers exactly these instead of deriving them from the page."
    )
  }).description("Observes pages through the registered browser_* tools. Plain text only: never reads a screenshot."),
  computer: z.object({
    enabled: z.boolean().default(true).description("Whether the desktop (accessibility) environment is available."),
    environmentId: z.string().description('Environment id to register it under. Defaults to "computer".'),
    app: z.string().description(
      "Target app: bundle id, display name, or path. Take it from computer_use_list_apps. A display name often fails where the bundle id works."
    ),
    maxCandidates: z.number().description("Maximum number of accessibility elements offered to the decider. Defaults to 12."),
    maxStateChars: z.number().description("How much accessibility-tree text is placed into the decision state. Defaults to 8000."),
    maxTreeNodes: z.number().description("Maximum accessibility nodes captured per observation. Defaults to 1200."),
    captureTimeoutMs: z.number().description(
      "How long to wait for one accessibility capture before reporting it as unusable. Defaults to 30000. A capture can block on a permission prompt, and a loop must not wait forever."
    )
  }).description("Drives apps through the accessibility tree. Never reads a screenshot and never infers coordinates from pixels."),
  telemetryLimit: z.number().default(200).description(
    "How many recent telemetry records are kept in memory for diagnostics. Records hold counts, ids and timings \u2014 never page text or tree content."
  )
});
function createDecisionEngineComposition(options) {
  const config = options.config ?? {};
  const { sink, records } = createRingBufferSink(config.telemetryLimit ?? 200);
  const telemetry = sink;
  const providers = new DecisionProviderRegistry();
  const layaConfig = config.providers?.laya ?? {};
  const layaEnabled = layaConfig.enabled ?? true;
  const disposers = [];
  if (layaEnabled) {
    disposers.push(providers.register(new LayaDecisionProvider({ config: layaConfig }), {
      enabled: true,
      config: { ...layaConfig }
    }));
  }
  for (const extra of options.extraProviders ?? []) {
    disposers.push(providers.register(extra.provider, {
      ...extra.enabled === void 0 ? {} : { enabled: extra.enabled },
      ...extra.config === void 0 ? {} : { config: extra.config }
    }));
  }
  const configuredDefault = config.defaultProvider;
  if (configuredDefault !== void 0 && providers.has(configuredDefault)) {
    const entry = providers.entry(configuredDefault);
    if (entry?.enabled === true) providers.setDefault(configuredDefault);
  } else if (configuredDefault !== void 0) {
    throw new DecisionError("provider_unknown", `defaultProvider "${configuredDefault}" is not a registered provider.`, {
      subject: configuredDefault,
      details: { registered: providers.ids() }
    });
  }
  const requestedDefault = configuredDefault;
  const engine = new DecisionEngine({
    ...configuredDefault === void 0 ? {} : { defaultProviderId: configuredDefault },
    ...config.runtime?.confidenceThreshold === void 0 ? {} : { confidenceThreshold: config.runtime.confidenceThreshold },
    ...config.runtime?.observeTimeoutMs === void 0 ? {} : { timeoutMs: config.runtime.observeTimeoutMs },
    telemetry
  }, providers);
  const environments = new EnvironmentRegistry();
  if (config.browser?.enabled ?? true) {
    const browserCandidates = config.browser?.candidates;
    disposers.push(environments.register(new BrowserEnvironmentAdapter({
      ...config.browser?.environmentId === void 0 ? {} : { id: config.browser.environmentId },
      dispatcher: options.dispatcher,
      config: {
        strategy: browserCandidates === void 0 ? "form" : "patch",
        ...config.browser?.includeNonSemantic === void 0 ? {} : { includeNonSemantic: config.browser.includeNonSemantic },
        ...config.browser?.candidateSelector === void 0 ? {} : { candidateSelector: config.browser.candidateSelector },
        ...browserCandidates === void 0 ? {} : { candidates: browserCandidates },
        ...config.browser?.maxCandidates === void 0 ? {} : { maxCandidates: config.browser.maxCandidates },
        ...config.browser?.maxStateChars === void 0 ? {} : { maxStateChars: config.browser.maxStateChars }
      }
    })));
  }
  if (config.computer?.enabled ?? true) {
    const computerConfig = {
      ...config.computer?.app === void 0 ? {} : { app: config.computer.app },
      ...config.computer?.maxCandidates === void 0 ? {} : { maxCandidates: config.computer.maxCandidates },
      ...config.computer?.maxStateChars === void 0 ? {} : { maxStateChars: config.computer.maxStateChars },
      ...config.computer?.maxTreeNodes === void 0 ? {} : { maxTreeNodes: config.computer.maxTreeNodes },
      ...config.computer?.captureTimeoutMs === void 0 ? {} : { captureTimeoutMs: config.computer.captureTimeoutMs }
    };
    disposers.push(environments.register(new ComputerEnvironmentAdapter({
      ...config.computer?.environmentId === void 0 ? {} : { id: config.computer.environmentId },
      ...options.computerSeam === void 0 ? {} : { seam: options.computerSeam },
      dispatcher: options.dispatcher,
      config: computerConfig
    })));
  }
  const runtime = new DecisionRuntime(engine, {
    ...config.runtime === void 0 ? {} : { config: config.runtime },
    telemetry,
    environments
  });
  const service = {
    engine,
    providers,
    environments,
    runtime,
    // Getters, so a settings change is visible immediately instead of leaving a
    // stale snapshot behind (the engine and runtime are reconfigured live).
    get confidenceThreshold() {
      return engine.confidenceThreshold;
    },
    get runtimeConfig() {
      return runtime.resolveConfig();
    },
    decide: (request, decideOptions) => engine.decide(request, decideOptions),
    run: (runOptions) => runtime.run(runOptions),
    runTask: (taskOptions) => runtime.runTask(taskOptions),
    isCapabilityUnlocked: (capability) => options.readCapabilityGate?.(capability),
    health: async () => {
      const providerHealth = await providers.health();
      const statuses = Object.values(providerHealth).map((entry) => entry.status);
      const status = statuses.length === 0 || statuses.every((entry) => entry === "unavailable") ? "unavailable" : statuses.every((entry) => entry === "ok") ? "ok" : "degraded";
      const defaultProvider = providers.getDefaultId();
      return {
        status,
        ...defaultProvider === void 0 ? {} : { defaultProvider },
        ...requestedDefault === void 0 || requestedDefault === defaultProvider ? {} : { requestedDefaultProvider: requestedDefault },
        providers: providerHealth,
        environments: environments.ids(),
        telemetryRecords: records.length
      };
    },
    telemetry: () => records,
    dispose: async () => {
      await environments.disposeAll();
      await providers.disposeAll();
    }
  };
  return {
    service,
    engine,
    providers,
    environments,
    runtime,
    telemetryRecords: records,
    dispose: async () => {
      await service.dispose();
      for (const dispose of disposers.reverse()) dispose();
    }
  };
}
export {
  Config,
  createDecisionEngineComposition
};
