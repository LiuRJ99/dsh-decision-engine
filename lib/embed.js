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
    const outcome = await this.run({
      ...options,
      mode: "bounded-loop",
      config: { ...DEFAULT_TASK_CONFIG, ...options.config }
    });
    return { ...outcome, taskId, durationMs: this.#now() - started };
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
    const observe = () => phase(
      "observe",
      config.observeTimeoutMs,
      (signal, timeoutMs) => adapter.observe({ signal, timeoutMs, objective })
    );
    const assertObservation = (observation) => {
      if (observation.status === "ok") return;
      throw new DecisionError(
        observation.status === "insufficient" ? "insufficient_observation" : observation.status === "unsupported" ? "environment_unsupported" : "environment_unavailable",
        observation.reason ?? `Environment "${adapter.id}" returned ${observation.status}.`
      );
    };
    const isDone = (observation) => phase("completion check", config.observeTimeoutMs, async () => observation.done === true || completionMatches(observation.state, objective.completion) || await adapter.isDone?.(observation, objective) === true);
    const checkCompletion = async (observation) => {
      if (plan !== void 0) {
        while (planIndex < plan.length && completionMatches(observation.state, plan[planIndex].completion)) {
          planIndex++;
          planStartedAtStep = steps;
        }
        if (planIndex === plan.length) return true;
      }
      return isDone(observation);
    };
    const outcome = (status, stopReason) => ({
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
        if (await checkCompletion(lastObservation)) return outcome("done", "The environment is terminal or the configured completion conditions are met.");
        const stage = plan?.[planIndex];
        if (stage?.maxSteps !== void 0 && steps - planStartedAtStep >= stage.maxSteps) {
          throw new DecisionError("budget_exhausted", `Plan step "${stage.id}" reached its ${stage.maxSteps}-action budget.`);
        }
        const stepObjective = stage === void 0 ? objective : {
          ...objective,
          description: `Current plan step (${stage.id}): ${stage.objective}
Overall task: ${objective.description}`
        };
        let request = await phase("build request", config.observeTimeoutMs, () => adapter.buildDecisionRequest(lastObservation, stepObjective));
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
        lastAction = await phase("map action", config.executeTimeoutMs, () => adapter.mapDecision(lastDecision, lastObservation));
        previousMapMs = this.#now() - mapStarted;
        if (mode === "decision-only") return { ...outcome("decided", "Decision-only mode: nothing was executed."), steps: 1, stepIndex: 0 };
        if (lastAction.risky && options.allowRisky !== true) throw new DecisionError("high_risk_action", `Action "${lastAction.candidateId}" requires confirmation.`);
        const before = fingerprintState(lastObservation.state, config.stateFingerprintChars);
        const executeStarted = this.#now();
        check();
        lastExecution = await phase("execute", config.executeTimeoutMs, (signal, timeoutMs) => adapter.execute(lastAction, {
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
        if (mode === "single-step") return outcome("executed", "Single-step mode: exactly one action was executed.");
        if (lastExecution.done === true) {
          assertObservation(lastObservation);
          await checkCompletion(lastObservation);
          return outcome("done", "The environment reports a terminal result.");
        }
        if (config.stepDelayMs > 0) await phase("settle", check(), (signal) => abortableSleep(config.stepDelayMs, signal));
        const verifyStarted = this.#now();
        if (lastExecution.observation === void 0) lastObservation = await observe();
        observeMs = this.#now() - verifyStarted;
        assertObservation(lastObservation);
        if (await checkCompletion(lastObservation)) return outcome("done", "The environment is terminal or the configured completion conditions are met.");
        const after = fingerprintState(lastObservation.state, config.stateFingerprintChars);
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
        ...outcome("needs_escalation", failure.message),
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
    if (stage === null || typeof stage !== "object" || typeof stage.id !== "string" || stage.id.trim() === "" || ids.has(stage.id) || typeof stage.objective !== "string" || stage.objective.trim() === "" || stage.completion === void 0 || stage.maxSteps !== void 0 && (!Number.isInteger(stage.maxSteps) || stage.maxSteps <= 0)) {
      throw new DecisionError("invalid_request", "Each plan stage needs a unique id, an objective, a completion rule, and an optional positive integer maxSteps.");
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

// src/environments/types.ts
function okObservation(source, state, extra) {
  return { status: "ok", source, state, ...extra };
}
function failedObservation(source, status, reason, extra) {
  return { status, source, reason, ...extra };
}

// src/environments/custom/adapter.ts
var CustomEnvironmentAdapter = class {
  id;
  source = "custom";
  capabilities = ["observe", "buildDecisionRequest", "mapDecision", "execute"];
  #spec;
  /**
   * Candidate sets offered by recent `buildDecisionRequest` calls, newest last.
   *
   * Per-instance because it has to survive from `buildDecisionRequest` through
   * to `mapDecision` and `execute` — but an adapter driven by more than one
   * caller at a time keeps producing new candidate sets, and a decision built
   * from an earlier one must still map. A bounded history plus a per-action
   * snapshot (below) makes that work instead of failing a valid decision with
   * `unknown_candidate`.
   */
  #offered = [];
  #observationCandidates = /* @__PURE__ */ new WeakMap();
  /**
   * The candidate each action was mapped from.
   *
   * `execute` receives only the action, and the candidate holds the
   * environment-owned payload — so the association has to survive on something
   * the caller cannot forge. A `WeakMap` keyed by the action object does that
   * without putting adapter-private state into the protocol type, and without
   * keeping the action alive.
   */
  #actionCandidates = /* @__PURE__ */ new WeakMap();
  #lastState;
  /** Serializes {@link CustomEnvironmentAdapter.decision} on this instance. */
  #gate = Promise.resolve();
  constructor(spec) {
    if (typeof spec?.id !== "string" || spec.id.trim() === "") {
      throw new DecisionError("invalid_request", "A custom environment must declare a non-empty id.");
    }
    if (typeof spec.observe !== "function") {
      throw new DecisionError("invalid_request", `Custom environment "${spec.id}" must implement observe().`, { subject: spec.id });
    }
    if (typeof spec.execute !== "function") {
      throw new DecisionError("invalid_request", `Custom environment "${spec.id}" must implement execute().`, { subject: spec.id });
    }
    this.id = spec.id;
    this.#spec = spec;
  }
  /** Observe the environment. */
  async observe(input) {
    let state;
    try {
      state = await this.#spec.observe(input);
    } catch (error) {
      return failedObservation("custom", "error", error instanceof Error ? error.message : String(error), { metadata: { environment: this.id } });
    }
    if (state === void 0 || state === null) {
      return failedObservation("custom", "insufficient", `Environment "${this.id}" returned no structured state.`, {
        metadata: { environment: this.id, hint: "The environment must expose explicit structured state; this layer never guesses." }
      });
    }
    this.#lastState = state;
    return okObservation("custom", state, {
      ...this.#spec.result === void 0 ? {} : { result: this.#spec.result(state) },
      ...this.#spec.summarize === void 0 ? {} : { summary: this.#spec.summarize(state) },
      metadata: { environment: this.id }
    });
  }
  /** Build the decision request from a custom state. */
  buildDecisionRequest(observation, objective) {
    if (observation.status !== "ok") {
      throw new DecisionError("insufficient_observation", `Cannot build a decision request from a ${observation.status} observation.`, {
        subject: this.id,
        details: { reason: observation.reason }
      });
    }
    const state = observation.state;
    const offered = typeof this.#spec.candidates === "function" ? this.#spec.candidates(state) : this.#spec.candidates;
    const available = offered.filter((candidate) => candidate.available === void 0 || candidate.available(state));
    if (available.length === 0) {
      throw new DecisionError("no_candidates", `Environment "${this.id}" offers no available action for this state.`, {
        subject: this.id,
        details: { offered: offered.map((candidate) => candidate.id) }
      });
    }
    const byId = new Map(available.map((candidate) => [candidate.id, structuredCloneCandidate(candidate)]));
    this.#observationCandidates.set(observation, byId);
    this.#offered.push(byId);
    if (this.#offered.length > OFFERED_HISTORY) this.#offered.shift();
    const projected = this.#spec.projectState === void 0 ? state : this.#spec.projectState(state);
    const objectiveText = objective.description === "" ? this.#spec.defaultObjective : objective.description;
    return {
      ...objectiveText === void 0 ? {} : { objective: objectiveText },
      state: toDecisionState(projected),
      candidates: available.map((candidate) => ({
        id: candidate.id,
        description: candidate.description,
        ...candidate.metadata === void 0 ? {} : { metadata: candidate.metadata }
      })),
      ...objective.constraints === void 0 ? {} : { constraints: objective.constraints },
      mode: "choice",
      metadata: { environment: this.id }
    };
  }
  /** Map a chosen candidate id to a custom action. */
  mapDecision(result, observation) {
    const selected = result.selected;
    if (selected === void 0) {
      throw new DecisionError("invalid_decision", `Provider "${result.provider}" returned no selection.`, { subject: result.provider });
    }
    const candidate = this.#observationCandidates.get(observation)?.get(selected);
    if (candidate === void 0) {
      throw new DecisionError("unknown_candidate", `Decision "${selected}" does not map to an action of environment "${this.id}".`, {
        subject: this.id,
        details: { selected, offered: [...this.#offered.at(-1)?.keys() ?? []] }
      });
    }
    const action = {
      kind: "custom",
      candidateId: candidate.id,
      description: candidate.description,
      ...candidate.action === void 0 ? {} : { payload: candidate.action },
      ...candidate.risky === true ? { risky: true } : {}
    };
    this.#actionCandidates.set(action, candidate);
    return action;
  }
  /** Look up an offered candidate in the newest set first, then in history. */
  #findCandidate(id) {
    for (let index = this.#offered.length - 1; index >= 0; index -= 1) {
      const found = this.#offered[index]?.get(id);
      if (found !== void 0) return found;
    }
    return void 0;
  }
  /** Execute a mapped custom action. */
  async execute(action, input) {
    const candidate = this.#actionCandidates.get(action) ?? this.#findCandidate(action.candidateId);
    if (candidate === void 0) {
      throw new DecisionError("unknown_candidate", `Action "${action.candidateId}" was not offered by environment "${this.id}".`, { subject: this.id });
    }
    try {
      return await this.#spec.execute(candidate, input);
    } catch (error) {
      throw new DecisionError("action_execution_failed", error instanceof Error ? error.message : String(error), {
        subject: this.id,
        details: { candidateId: action.candidateId },
        cause: error
      });
    }
  }
  /** Whether the objective is met, when the environment can tell. */
  isDone(observation, objective) {
    if (this.#spec.isDone === void 0) return false;
    if (observation.status !== "ok") return false;
    return this.#spec.isDone(observation.state, objective);
  }
  /** The environment state seen by the last successful observation. */
  get lastState() {
    return this.#lastState;
  }
  /**
   * Run one whole decision against this environment, serialized.
   *
   * `buildDecisionRequest` records the offered candidates on the instance and
   * `mapDecision`/`execute` read them back, so two overlapping calls on ONE
   * adapter leave the earlier request unmappable — a valid decision then fails
   * with `unknown_candidate`, which reads like a bug rather than a concurrency
   * artifact. This method holds the four protocol steps together **and runs them
   * one at a time per instance**, so a caller that shares an adapter (a server
   * handling concurrent requests, say) cannot interleave them.
   *
   * The queue is per adapter instance, so two adapters still run in parallel.
   * A caller that wants concurrency should construct one adapter per concurrent
   * environment; this makes the shared case correct rather than merely
   * documented.
   *
   * @param decide - the decision function called with the built request.
   * @param objective - the caller's goal.
   * @param input - optional cancellation and per-call budget.
   * @returns the observation, the request, the result, and the mapped action.
   * @throws DecisionError when the environment cannot express the task, or when
   *   the decision cannot be mapped — the same errors the individual steps throw.
   */
  async decision(decide, objective, input) {
    const run = async () => {
      const observation = await this.observe(input);
      const request = this.buildDecisionRequest(observation, objective);
      const result = await decide(request);
      const action = this.mapDecision(result, observation);
      return { observation, request, result, action };
    };
    const next = this.#gate.then(run, run);
    this.#gate = next.then(() => void 0, () => void 0);
    return next;
  }
  async dispose() {
    await this.#spec.dispose?.();
  }
};
var OFFERED_HISTORY = 8;
function structuredCloneCandidate(candidate) {
  return {
    ...candidate,
    ...candidate.action === void 0 ? {} : { action: structuredClone(candidate.action) }
  };
}
function toDecisionState(value) {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  if (Array.isArray(value)) return { items: value };
  return { value };
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
  if (typeof state === "string") return truncate(state, limit);
  try {
    const json = JSON.stringify(state, null, 2);
    if (json === void 0) return String(state);
    return truncate(json, limit);
  } catch (error) {
    throw new DecisionError("invalid_request", `The decision state could not be serialized: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function renderCandidate(candidate, metadataLimit) {
  const metadata = candidate.metadata === void 0 ? "" : ` ${truncate(JSON.stringify(candidate.metadata) ?? "{}", metadataLimit)}`;
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
function truncate(value, limit) {
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

// src/environments/http/adapter.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var ENVIRONMENT_PROTOCOL = "dsh-environment/v1";
var HttpEnvironmentAdapter = class {
  id;
  source = "custom";
  capabilities = ["observe", "execute", "terminal-result"];
  #base;
  #headers;
  #fetch;
  #observations = /* @__PURE__ */ new WeakMap();
  #actions = /* @__PURE__ */ new WeakMap();
  #identity;
  constructor(options) {
    let base;
    try {
      base = new URL(options.endpoint);
    } catch {
      throw new DecisionError("invalid_request", "Environment endpoint must be an absolute HTTP(S) URL.");
    }
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new DecisionError("invalid_request", "Environment endpoint must use HTTP(S), without credentials, query, or fragment.");
    }
    base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
    this.#base = base;
    this.id = options.id ?? `http:${base.href}`;
    this.#headers = options.headers ?? {};
    this.#fetch = options.fetch ?? globalThis.fetch;
  }
  async observe(input) {
    return this.#observation(await this.#request("state", { method: "GET", ...input?.signal === void 0 ? {} : { signal: input.signal } }));
  }
  buildDecisionRequest(observation, objective) {
    const snapshot = this.#requireSnapshot(observation);
    return {
      objective: objective.description,
      state: snapshot.state,
      candidates: snapshot.candidates.map(({ id, description, metadata }) => ({ id, description, ...metadata === void 0 ? {} : { metadata } })),
      ...objective.constraints === void 0 ? {} : { constraints: objective.constraints },
      metadata: { environment: snapshot.environmentId, episodeId: snapshot.episodeId, revision: snapshot.revision }
    };
  }
  mapDecision(decision, observation) {
    const snapshot = this.#requireSnapshot(observation);
    const candidate = snapshot.candidates.find((entry) => entry.id === decision.selected);
    if (candidate === void 0) throw new DecisionError("unknown_candidate", "The selected action was not offered by this snapshot.");
    const action = {
      kind: "custom",
      candidateId: candidate.id,
      description: candidate.description,
      ...candidate.risky === true ? { risky: true } : {}
    };
    this.#actions.set(action, {
      protocol: ENVIRONMENT_PROTOCOL,
      actionId: randomUUID2(),
      environmentId: snapshot.environmentId,
      episodeId: snapshot.episodeId,
      revision: snapshot.revision,
      candidateId: candidate.id
    });
    return action;
  }
  async execute(action, input) {
    const request = this.#actions.get(action);
    if (request === void 0) throw new DecisionError("action_mapping_failed", "The action was not mapped by this environment.");
    if (action.risky && !input?.allowRisky) throw new DecisionError("high_risk_action", "This action requires confirmation.");
    if (input?.signal?.aborted) throw new DecisionError("aborted", "The environment action was cancelled.");
    const response = await this.#request("action", {
      method: "POST",
      body: JSON.stringify(request),
      ...input?.signal === void 0 ? {} : { signal: input.signal }
    });
    if (!isRecord(response) || typeof response.ok !== "boolean") throw new DecisionError("action_execution_failed", "Action response must contain ok and observation.");
    if (!response.ok) return { ok: false, message: typeof response.message === "string" ? response.message : "The environment rejected the action." };
    const observation = this.#observation(response.observation);
    return {
      ok: true,
      observation,
      done: observation.done === true,
      ...observation.result === void 0 ? {} : { result: observation.result },
      ...typeof response.message === "string" ? { message: response.message } : {}
    };
  }
  isDone(observation) {
    return observation.done === true;
  }
  #requireSnapshot(observation) {
    const snapshot = this.#observations.get(observation);
    if (snapshot === void 0) throw new DecisionError("insufficient_observation", "The observation does not belong to this environment.");
    return snapshot;
  }
  #observation(value) {
    if (!isRecord(value) || value.protocol !== ENVIRONMENT_PROTOCOL || typeof value.done !== "boolean" || !["environmentId", "episodeId", "revision"].every((key) => typeof value[key] === "string" && value[key] !== "") || !Array.isArray(value.candidates) || typeof value.state !== "string" && !isRecord(value.state) || value.result !== void 0 && !isRecord(value.result)) {
      throw new DecisionError("insufficient_observation", "Invalid dsh-environment/v1 snapshot.");
    }
    const snapshot = value;
    if (!snapshot.done || snapshot.candidates.length > 0) validateRequest({ state: snapshot.state, candidates: snapshot.candidates });
    if (this.#identity !== void 0 && (this.#identity.environmentId !== snapshot.environmentId || this.#identity.episodeId !== snapshot.episodeId)) {
      throw new DecisionError("environment_unavailable", "The environment or episode changed during the task; refusing to control a different game.");
    }
    this.#identity = { environmentId: snapshot.environmentId, episodeId: snapshot.episodeId };
    const observation = {
      status: "ok",
      source: this.source,
      state: snapshot.state,
      done: snapshot.done,
      ...snapshot.result === void 0 ? {} : { result: snapshot.result },
      metadata: { environmentId: snapshot.environmentId, episodeId: snapshot.episodeId, revision: snapshot.revision }
    };
    this.#observations.set(observation, snapshot);
    return observation;
  }
  async #request(path, init) {
    const response = await this.#fetch(new URL(path, this.#base), {
      ...init,
      redirect: "error",
      headers: { ...this.#headers, accept: "application/json", "content-type": "application/json" }
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DecisionError(
        path === "action" ? "action_execution_failed" : "environment_unavailable",
        `Environment ${path} returned HTTP ${response.status}; actions are not automatically retried.`
      );
    }
    return response.json();
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/embed.ts
function createDecisionLayer(options = {}) {
  const { sink, records } = createRingBufferSink(options.telemetryLimit ?? 200);
  const telemetry = options.telemetry === void 0 ? sink : (record) => {
    sink(record);
    try {
      options.telemetry?.(record);
    } catch {
    }
  };
  const providers = new DecisionProviderRegistry();
  const layaOption = options.laya ?? true;
  if (layaOption !== false) {
    const layaConfig = typeof layaOption === "object" ? layaOption : {};
    providers.register(new LayaDecisionProvider({ config: layaConfig }), { enabled: true, config: { ...layaConfig } });
  }
  for (const provider of options.providers ?? []) providers.register(provider, { enabled: true });
  if (options.defaultProvider !== void 0) {
    providers.setDefault(options.defaultProvider);
  } else if (providers.getDefaultId() === void 0 && providers.ids().length === 0) {
    throw new DecisionError("provider_unavailable", "createDecisionLayer was called with no providers.", {
      details: { hint: "Pass providers: [...] or leave laya enabled." }
    });
  }
  const engine = new DecisionEngine({
    ...options.defaultProvider === void 0 ? {} : { defaultProviderId: options.defaultProvider },
    ...options.confidenceThreshold === void 0 ? {} : { confidenceThreshold: options.confidenceThreshold },
    ...options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs },
    telemetry
  }, providers);
  const environments = new EnvironmentRegistry();
  const runtime = new DecisionRuntime(engine, {
    ...options.runtime === void 0 ? {} : { config: options.runtime },
    environments
  });
  return {
    engine,
    providers,
    environments,
    runtime,
    get runtimeConfig() {
      return runtime.resolveConfig();
    },
    decide: (request) => engine.decide(request),
    runTask: (options2) => runtime.runTask({ ...options2, objective: typeof options2.objective === "string" ? { description: options2.objective } : options2.objective }),
    decideEnvironment: ({ environment, objective, mode, allowRisky, signal }) => runtime.run({
      environment,
      objective: typeof objective === "string" ? { description: objective } : objective,
      ...mode === void 0 ? {} : { mode },
      ...allowRisky === void 0 ? {} : { allowRisky },
      ...signal === void 0 ? {} : { signal }
    }),
    telemetry: () => records,
    health: async () => {
      const providerHealth = await providers.health();
      const statuses = Object.values(providerHealth).map((entry) => entry.status);
      const status = statuses.length === 0 || statuses.every((entry) => entry === "unavailable") ? "unavailable" : statuses.every((entry) => entry === "ok") ? "ok" : "degraded";
      const defaultProvider = providers.getDefaultId();
      return {
        status,
        ...defaultProvider === void 0 ? {} : { defaultProvider },
        providers: providerHealth,
        environments: environments.ids(),
        telemetryRecords: records.length
      };
    },
    dispose: async () => {
      await environments.disposeAll();
      await providers.disposeAll();
    }
  };
}
export {
  CustomEnvironmentAdapter,
  ENVIRONMENT_PROTOCOL,
  HttpEnvironmentAdapter,
  createDecisionLayer
};
