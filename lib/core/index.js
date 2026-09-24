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
function normalizeConfidenceFromDistribution(entries) {
  const usable = entries.filter((entry) => Number.isFinite(entry.probability) && entry.probability > 0);
  if (usable.length < 2) return void 0;
  const sorted = [...usable].sort((left, right) => right.probability - left.probability);
  const top = sorted[0];
  const second = sorted[1];
  if (top === void 0 || second === void 0) return void 0;
  const total = usable.reduce((sum, entry) => sum + entry.probability, 0);
  if (total <= 0) return void 0;
  return clampUnit((top.probability - second.probability) / total);
}
function clampUnit(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

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
function isDecisionErrorCode(error, code) {
  return isDecisionError(error) && error.code === code;
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
  #allowCapabilityFallback;
  /**
   * @param registry - provider membership.
   * @param options - routing config.
   */
  constructor(registry, options = {}) {
    this.#registry = registry;
    if (options.defaultProviderId !== void 0) this.#registry.setDefault(options.defaultProviderId);
    this.#allowCapabilityFallback = options.allowCapabilityFallback ?? true;
  }
  /** The configured default provider id, if any. */
  get defaultProviderId() {
    return this.#registry.getDefaultId();
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
    const next = id ?? this.#registry.enabledIds()[0];
    if (next !== void 0) this.#registry.setDefault(next);
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
    const preferred = this.#registry.getDefaultId();
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
      timeoutMs: config.timeoutMs ?? 3e4
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
    if (config.allowCapabilityFallback !== void 0) this.#router.setAllowCapabilityFallback(config.allowCapabilityFallback);
    if (config.defaultProviderId !== void 0) {
      this.#router.setDefaultProvider(config.defaultProviderId);
    }
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
export {
  DECISION_CAPABILITIES,
  DECISION_CONFIDENCE_KINDS,
  DECISION_ERROR_BRAND,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DecisionEngine,
  DecisionError,
  DecisionProviderRegistry,
  DecisionRouter,
  MAX_CANDIDATES,
  MAX_OBJECTIVE_CHARS,
  MAX_STATE_CHARS,
  clampUnit,
  createDecisionResult,
  createRingBufferSink,
  isDecisionCapability,
  isDecisionConfidenceKind,
  isDecisionError,
  isDecisionErrorCode,
  normalizeConfidenceFromDistribution,
  normalizeDecisionResult,
  rankByScore,
  toDecisionFailure,
  toEscalation,
  validateRequest
};
