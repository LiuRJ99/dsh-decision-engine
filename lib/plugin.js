// src/core/errors.ts
var DecisionError = class extends Error {
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
function toDecisionFailure(error, fallback = "internal") {
  if (error instanceof DecisionError) return error.toJSON();
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
  return error instanceof DecisionError && error.code === code;
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

// src/environments/dispatch.ts
function toolFailure(name2, message) {
  return { ok: false, text: "", error: `${name2}: ${message}` };
}
function requireDispatcher(dispatcher, environmentId) {
  if (dispatcher === void 0) {
    throw new DecisionError("environment_unavailable", `Environment "${environmentId}" has no tool dispatcher wired in this deployment.`, {
      subject: environmentId,
      details: { hint: "The decision-engine plugin wires it automatically; a hand-built adapter needs one passed in." }
    });
  }
  return dispatcher;
}

// src/composition.ts
import z from "@deepseek-ai/schemastery";

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
  return createDecisionResult({
    provider: options.providerId,
    mode: options.mode,
    selected: resolvedSelected,
    ranking,
    latencyMs: options.latencyMs,
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
  "Removed elements",
  "Title",
  "URL",
  "Status"
];
var SECTION_RE = new RegExp(`^(${SECTION_LABELS.join("|")}):(?:\\s+(.*))?$`);
var PAGE_CHANGE_RE = /^Page change[^:]*?(?:\((.*)\))?\s*$/;
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
      if (label === "Title") {
        if (rest !== "") snapshot.title = rest;
        section = "header";
        continue;
      }
      if (label === "URL") {
        if (rest !== "") snapshot.url = rest;
        section = "header";
        continue;
      }
      if (label === "Status") {
        if (rest !== "") snapshot.status = rest;
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
  return snapshot.mainChars < 40;
}
function parseItem(line) {
  const match = ITEM_RE.exec(line);
  if (match === null) return void 0;
  const index = Number(match[1]);
  if (!Number.isInteger(index)) return void 0;
  const role = match[2] ?? "";
  const name2 = unescapeName(match[3] ?? "");
  const state = match[4] ?? "";
  const href = match[5];
  const item = {
    index,
    role,
    name: name2,
    disabled: state.includes("disabled"),
    outsideViewport: state.includes("outside viewport")
  };
  if (state.includes("checked")) item.checked = true;
  else if (state.includes("unchecked")) item.checked = false;
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
var BrowserEnvironmentAdapter = class {
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
    this.#config = {
      strategy: config.strategy ?? "form",
      candidates: config.candidates,
      maxCandidates: config.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
      maxStateChars: config.maxStateChars ?? DEFAULT_MAX_STATE_CHARS,
      maxObjectiveChars: config.maxObjectiveChars ?? DEFAULT_MAX_OBJECTIVE_CHARS,
      observeTimeoutMs: config.observeTimeoutMs ?? 9e4,
      executeTimeoutMs: config.executeTimeoutMs ?? 9e4
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
      arguments: {},
      ...input?.signal === void 0 ? {} : { signal: input.signal }
    });
    if (!result.ok) {
      const message = result.error ?? "browser_snapshot failed.";
      return failedObservation("browser", "unsupported", message, {
        metadata: { tool: BROWSER_TOOLS.snapshot, hint: "Authorize the browser capability for this session (/browser) and retry." }
      });
    }
    const snapshot = parseBrowserSnapshot(result.text);
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
    if (addressable === 0) {
      return failedObservation("browser", "insufficient", "The snapshot listed no interactive elements, so no finite candidate set can be derived from the page.", {
        metadata: { url: snapshot.url, textChars, mainChars: snapshot.mainChars }
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
    const candidates = [];
    const seen = /* @__PURE__ */ new Set();
    const push = (candidate) => {
      if (candidates.length >= this.#config.maxCandidates) return;
      if (seen.has(candidate.id)) return;
      seen.add(candidate.id);
      candidates.push(candidate);
    };
    const items = [...snapshot.items].sort((left, right) => {
      const leftPrimary = PRIMARY_ROLES.includes(left.role) ? 0 : 1;
      const rightPrimary = PRIMARY_ROLES.includes(right.role) ? 0 : 1;
      if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;
      if (left.disabled !== right.disabled) return left.disabled ? 1 : -1;
      return left.index - right.index;
    });
    for (const item of items) {
      if (item.disabled) continue;
      const role = item.role.toLowerCase();
      if (!PRIMARY_ROLES.includes(role)) continue;
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
    if (snapshot.items.length > 0 || snapshot.forms.length > 0) {
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
  async execute(action, _input) {
    const app = this.#pendingApp ?? this.#config.app;
    if (app === void 0) {
      throw new DecisionError("action_mapping_failed", "No target app is known; observe before executing an action.", { subject: this.id });
    }
    const elementIndex = typeof action.target === "number" ? action.target : void 0;
    const payload = action.payload ?? {};
    switch (action.kind) {
      case "click":
        return this.#invoke("click", { app, ...elementIndex === void 0 ? {} : { elementIndex } });
      case "set_value": {
        if (elementIndex === void 0) {
          throw new DecisionError("action_mapping_failed", "set_value requires an element index.", { subject: this.id });
        }
        return this.#invoke("setValue", { app, elementIndex, value: String(payload.value ?? "") });
      }
      case "press_key":
        return this.#invoke("pressKey", { app, key: String(payload.key ?? "Return") });
      case "scroll": {
        if (elementIndex === void 0) {
          throw new DecisionError("action_mapping_failed", "scroll requires an element index.", { subject: this.id });
        }
        return this.#invoke("scroll", { app, elementIndex, direction: String(payload.direction ?? "down") });
      }
      case "type_text":
        return this.#invoke("typeText", { app, text: String(payload.text ?? "") });
      case "select_text": {
        if (elementIndex === void 0) {
          throw new DecisionError("action_mapping_failed", "select_text requires an element index.", { subject: this.id });
        }
        return this.#invoke("selectText", { app, elementIndex, text: String(payload.find ?? "") });
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
      arguments: { app, maxTreeNodes: this.#config.maxTreeNodes },
      ...signal === void 0 ? {} : { signal }
    });
    if (!result.ok) return { ok: false, error: result.error ?? "computer_use_get_app_state failed." };
    return { ok: true, app, text: result.text, truncated: /truncated/i.test(result.text) };
  }
  async #invoke(operation, args) {
    if (this.#seam !== void 0) {
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
    const result = await dispatcher.call({ name: toolName, arguments: args });
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
var DecisionRuntime = class {
  #engine;
  #baseConfig;
  #now;
  #environments;
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
   * Run the loop.
   *
   * @param options - environment, objective, promotion mode, budgets.
   * @returns an outcome whose `status` is one of `decided`, `executed`, `done`, `needs_escalation`.
   *          Infrastructure failures (unknown environment, invalid request) throw a
   *          {@link DecisionError}; runtime *decisions to stop* return `needs_escalation`.
   */
  async run(options) {
    const config = this.resolveConfig(options.config);
    const adapter = this.#resolveAdapter(options.environment);
    const mode = options.mode ?? "decision-only";
    const startedAt = this.#now();
    const objective = options.objective;
    const history = [];
    let stateFingerprint;
    let unchangedStreak = 0;
    let repeatedStreak = 0;
    let lastSelected;
    let lastDecision;
    let lastProviderId;
    let previousMapMs;
    let previousExecuteMs;
    const escalate = (reason, details, guidance) => {
      const failure = { code: reason, message: typeof details?.message === "string" ? details.message : reason };
      const escalation = toEscalation(failure, {
        environment: adapter.id,
        ...lastProviderId === void 0 ? {} : { provider: lastProviderId },
        ...lastDecision === void 0 ? {} : {
          lastDecision: {
            ...lastDecision.selected === void 0 ? {} : { selected: lastDecision.selected },
            ...lastDecision.confidence === void 0 ? {} : { confidence: lastDecision.confidence },
            ...lastDecision.confidenceKind === void 0 ? {} : { confidenceKind: lastDecision.confidenceKind },
            step: history.length
          }
        },
        ...guidance === void 0 ? {} : { guidance },
        ...details === void 0 ? {} : { details: { ...details, steps: history.length } }
      });
      return { status: "needs_escalation", environment: adapter.id, steps: history.length, escalation };
    };
    const maxSteps = mode === "decision-only" ? 1 : mode === "single-step" ? Math.min(1, config.maxSteps) : config.maxSteps;
    for (let step = 0; step < maxSteps; step += 1) {
      if (options.signal?.aborted === true) return escalate("aborted", { message: "The run was aborted by the caller." });
      if (this.#now() - startedAt > config.maxDurationMs) {
        return escalate("budget_exhausted", { maxDurationMs: config.maxDurationMs });
      }
      const observeStarted = this.#now();
      let observation;
      try {
        observation = await adapter.observe({
          ...options.signal === void 0 ? {} : { signal: options.signal },
          timeoutMs: config.observeTimeoutMs,
          objective
        });
      } catch (error) {
        const failure = toDecisionFailure(error, "internal");
        return escalate(failure.code === "internal" ? "internal" : failure.code, { message: failure.message });
      }
      const observeMs = this.#now() - observeStarted;
      if (observation.status !== "ok") {
        const reason = observation.status === "insufficient" ? "insufficient_observation" : observation.status === "unsupported" ? "environment_unsupported" : "environment_unavailable";
        return escalate(reason, {
          message: observation.reason ?? `Environment "${adapter.id}" reported ${observation.status}.`,
          observationStatus: observation.status,
          ...observation.metadata === void 0 ? {} : { observation: observation.metadata }
        }, observation.status === "insufficient" ? "The environment cannot express this task with structured state; use the main agent instead of guessing." : void 0);
      }
      let request;
      try {
        request = await adapter.buildDecisionRequest(observation, objective);
      } catch (error) {
        const failure = toDecisionFailure(error, "internal");
        return escalate(failure.code, { message: failure.message });
      }
      if (options.candidates !== void 0) request = { ...request, candidates: options.candidates };
      if (options.provider !== void 0) request = { ...request, provider: options.provider };
      if (options.decisionMode !== void 0) request = { ...request, mode: options.decisionMode };
      request = {
        ...request,
        metadata: { ...request.metadata, environment: adapter.id, step }
      };
      let decision;
      try {
        decision = await this.#engine.decide(request, {
          ...options.provider === void 0 ? {} : { provider: options.provider },
          ...options.signal === void 0 ? {} : { signal: options.signal },
          debug: options.debug === true,
          environment: adapter.id,
          step,
          // Layers the runtime already measured, so the emitted record carries
          // the environment's cost and the model's cost separately.
          sourceTimings: {
            observeMs,
            ...previousMapMs === void 0 ? {} : { mapMs: previousMapMs },
            ...previousExecuteMs === void 0 ? {} : { executeMs: previousExecuteMs }
          },
          confidenceThreshold: config.confidenceThreshold
        });
      } catch (error) {
        const failure = toDecisionFailure(error);
        const reason = failure.code === "unknown_candidate" ? "unknown_candidate" : failure.code;
        return escalate(reason, {
          message: failure.message,
          ...failure.details === void 0 ? {} : { decision: failure.details },
          candidateCount: request.candidates.length
        });
      }
      lastDecision = decision;
      lastProviderId = decision.provider;
      if (typeof adapter.isDone === "function") {
        let done;
        try {
          done = await adapter.isDone(observation, objective);
        } catch {
          done = false;
        }
        if (done) {
          return {
            status: "done",
            environment: adapter.id,
            steps: step + 1,
            stepIndex: step,
            decision,
            stopReason: "The environment reports the objective is already met."
          };
        }
      }
      const mapStarted = this.#now();
      let action;
      try {
        action = await adapter.mapDecision(decision, observation);
      } catch (error) {
        const failure = toDecisionFailure(error, "action_mapping_failed");
        return escalate(failure.code, { message: failure.message, selected: decision.selected });
      }
      const mapMs = this.#now() - mapStarted;
      const timings = {
        observeMs,
        decisionMs: decision.latencyMs,
        mapMs,
        totalMs: this.#now() - startedAt
      };
      if (mode === "decision-only") {
        return {
          status: "decided",
          environment: adapter.id,
          steps: 1,
          stepIndex: 0,
          decision,
          action,
          stopReason: "Decision-only mode: nothing was executed."
        };
      }
      if (action.risky === true && options.allowRisky !== true) {
        return escalate("high_risk_action", {
          message: `Action "${action.candidateId}" is marked risky; refusing to execute it without confirmation.`,
          action: { kind: action.kind, candidateId: action.candidateId, description: action.description }
        });
      }
      const executeStarted = this.#now();
      let execution;
      try {
        const executeInput = {
          ...options.signal === void 0 ? {} : { signal: options.signal },
          timeoutMs: config.executeTimeoutMs,
          allowRisky: options.allowRisky === true
        };
        execution = await adapter.execute(action, executeInput);
      } catch (error) {
        const failure = toDecisionFailure(error, "action_execution_failed");
        return escalate(failure.code, { message: failure.message, action: { kind: action.kind, candidateId: action.candidateId } });
      }
      const executeMs = this.#now() - executeStarted;
      timings.executeMs = executeMs;
      timings.totalMs = this.#now() - startedAt;
      previousMapMs = mapMs;
      previousExecuteMs = executeMs;
      const record = {
        index: step,
        decision,
        action,
        execution,
        executed: true,
        timings
      };
      history.push(record);
      if (execution.ok !== true) {
        return escalate("action_execution_failed", {
          message: execution.message ?? `Action "${action.candidateId}" reported failure.`,
          action: { kind: action.kind, candidateId: action.candidateId }
        });
      }
      if (mode === "single-step") {
        return {
          status: "executed",
          environment: adapter.id,
          steps: 1,
          stepIndex: 0,
          decision,
          action,
          execution,
          stopReason: "Single-step mode: exactly one action was executed."
        };
      }
      const nextObservation = await this.#safeObserve(adapter, options.signal, config.observeTimeoutMs, objective);
      if (nextObservation.status !== "ok") {
        return escalate("insufficient_observation", {
          message: nextObservation.reason ?? "The environment stopped producing usable structured state.",
          afterStep: step
        });
      }
      if (typeof adapter.isDone === "function") {
        let done;
        try {
          done = await adapter.isDone(nextObservation, objective);
        } catch {
          done = false;
        }
        if (done || execution.done === true) {
          return {
            status: "done",
            environment: adapter.id,
            steps: step + 1,
            stepIndex: step,
            decision,
            action,
            execution,
            stopReason: "The environment reports the objective is met."
          };
        }
      } else if (execution.done === true) {
        return {
          status: "done",
          environment: adapter.id,
          steps: step + 1,
          stepIndex: step,
          decision,
          action,
          execution,
          stopReason: "The environment reports the objective is met."
        };
      }
      const fingerprint = fingerprintState(nextObservation.state, config.stateFingerprintChars);
      if (fingerprint !== void 0 && fingerprint === stateFingerprint) {
        unchangedStreak += 1;
        if (unchangedStreak >= config.noProgressLimit) {
          return escalate("no_progress", {
            message: `The environment state did not change for ${unchangedStreak} consecutive steps.`,
            noProgressLimit: config.noProgressLimit
          });
        }
      } else {
        unchangedStreak = 0;
      }
      if (fingerprint !== void 0) stateFingerprint = fingerprint;
      const selected = decision.selected;
      if (selected !== void 0 && selected === lastSelected) {
        repeatedStreak += 1;
        if (repeatedStreak >= config.repeatedDecisionLimit) {
          return escalate("repeated_decision", {
            message: `The same candidate "${selected}" was chosen ${repeatedStreak + 1} times in a row.`,
            repeatedDecisionLimit: config.repeatedDecisionLimit,
            selected
          });
        }
      } else {
        repeatedStreak = 0;
      }
      lastSelected = selected;
      if (config.stepDelayMs > 0) await abortableSleep(config.stepDelayMs, options.signal);
    }
    return escalate("budget_exhausted", {
      message: `The run reached its ${maxSteps}-step budget without meeting the objective.`,
      maxSteps
    });
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
  async #safeObserve(adapter, signal, timeoutMs, objective) {
    try {
      return await adapter.observe({
        ...signal === void 0 ? {} : { signal },
        timeoutMs,
        objective
      });
    } catch (error) {
      const failure = toDecisionFailure(error, "internal");
      return { status: "error", source: adapter.source, reason: failure.message };
    }
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
  constructor(options = {}) {
    this.#config = resolveLayaConfig(options.config);
    this.#loadModule = options.loadModule ?? defaultLayaModuleLoader;
    if (options.instance !== void 0) {
      this.#instance = options.instance;
      this.#status = "ready";
      this.#loadPromise = Promise.resolve(options.instance);
    } else if (options.autoLoad === true) {
      void this.load().catch(() => void 0);
    }
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
        this.#loadMs = Date.now() - started;
        this.#status = "ready";
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
  /** Release the ONNX session. */
  async close() {
    const instance = this.#instance;
    this.#instance = void 0;
    this.#loadPromise = void 0;
    this.#status = "closed";
    if (instance !== void 0) {
      try {
        await instance.close();
      } catch {
      }
    }
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
      autoLoad: options.autoLoad ?? false
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
      includeDebug: context?.debug === true
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
  enabled: z.boolean().default(true),
  defaultProvider: z.string(),
  providers: z.dict(z.object({})),
  runtime: z.object({
    maxSteps: z.number().default(10),
    maxDurationMs: z.number().default(12e4),
    confidenceThreshold: z.number().default(0.55),
    noProgressLimit: z.number().default(3),
    repeatedDecisionLimit: z.number().default(3),
    observeTimeoutMs: z.number().default(9e4),
    executeTimeoutMs: z.number().default(9e4),
    stepDelayMs: z.number().default(0),
    stateFingerprintChars: z.number().default(2e3)
  }),
  browser: z.object({
    enabled: z.boolean().default(true),
    environmentId: z.string(),
    maxCandidates: z.number(),
    maxStateChars: z.number(),
    candidates: z.array(z.any())
  }),
  computer: z.object({
    enabled: z.boolean().default(true),
    environmentId: z.string(),
    app: z.string(),
    maxCandidates: z.number(),
    maxStateChars: z.number(),
    maxTreeNodes: z.number(),
    captureTimeoutMs: z.number()
  }),
  telemetryLimit: z.number().default(200)
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
    confidenceThreshold: engine.confidenceThreshold,
    runtimeConfig: runtime.resolveConfig(),
    decide: (request, decideOptions) => engine.decide(request, decideOptions),
    run: (runOptions) => runtime.run(runOptions),
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
      for (const dispose of disposers.reverse()) dispose();
      await service.dispose();
    }
  };
}

// src/tools/decision-decide.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

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

// src/tools/decide-logic.ts
function toJsonObject(value) {
  try {
    const json = JSON.parse(JSON.stringify(value ?? {}));
    return typeof json === "object" && json !== null && !Array.isArray(json) ? json : { value: json };
  } catch {
    return { unserializable: true };
  }
}
function executionModeOf(execute) {
  if (execute === "loop") return "bounded-loop";
  if (execute === true) return "single-step";
  return "decision-only";
}
function objectiveOf(input) {
  const objective = { description: input.objective ?? "" };
  if (input.constraints !== void 0) objective.constraints = input.constraints;
  return objective;
}
function preflightDecideInput(input, service) {
  const hasEnvironment = typeof input.environment === "string" && input.environment !== "";
  if (!hasEnvironment) {
    if (input.state === void 0) {
      return "decision_decide: pass state, or pass environment to observe one.";
    }
    if (input.candidates === void 0 || input.candidates.length === 0) {
      return "decision_decide: pass a non-empty candidates array, or pass environment to derive one.";
    }
    try {
      validateRequest({
        state: input.state,
        candidates: input.candidates.map((candidate) => ({ id: candidate.id, description: candidate.description })),
        ...input.mode === void 0 ? {} : { mode: input.mode },
        ...input.provider === void 0 ? {} : { provider: input.provider }
      });
    } catch (error) {
      const failure = toDecisionFailure(error);
      return `decision_decide: ${failure.message}`;
    }
    return void 0;
  }
  const environmentId = input.environment ?? "";
  if (!service.environments.has(environmentId)) {
    return `decision_decide: no environment adapter is registered as "${environmentId}" (registered: ${service.environments.ids().join(", ") || "none"}).`;
  }
  if (executionModeOf(input.execute) === "decision-only") {
    return void 0;
  }
  const capability = environmentId === "browser" ? "browser" : environmentId === "computer" ? "computer" : void 0;
  if (capability !== void 0 && service.isCapabilityUnlocked(capability) === false) {
    return `decision_decide: the ${capability} capability is not authorized in this session. The user must invoke /${GATE_SKILL_NAMES[capability]} first; this tool cannot unlock it.`;
  }
  if (input.allowRisky === true) {
    return void 0;
  }
  return void 0;
}
var PARAMETERS = {
  objective: {
    type: "string",
    description: "What the caller is trying to achieve. Prefer naming the concrete next outcome."
  },
  state: {
    // Both forms are accepted, because both are real: a workflow passes
    // structured state, while a caller reading a page or a log has a string.
    oneOf: [
      { type: "object", additionalProperties: true },
      { type: "string" }
    ],
    description: "Environment state to decide about: a structured object, or a string when that is what the caller has. Omit when environment is given and the adapter should observe."
  },
  candidates: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", required: true, description: "Stable option id the decider may return." },
        description: { type: "string", required: true, description: "What choosing this option does." },
        metadata: { type: "object", additionalProperties: true, description: "Optional structured attributes of the option." }
      }
    },
    description: "The finite option set. Required unless environment derives one."
  },
  mode: {
    type: "string",
    enum: ["choice", "ranking", "score", "classification"],
    description: "Required capability. Defaults to choice."
  },
  provider: {
    type: "string",
    description: "Explicit provider id. Omit to use the configured default provider."
  },
  constraints: {
    type: "array",
    items: { type: "string" },
    description: "Hard constraints the decision must respect."
  },
  environment: {
    type: "string",
    description: "Environment id to observe and act in (browser, computer, or a registered custom environment)."
  },
  execute: {
    oneOf: [
      { type: "boolean" },
      { type: "string", enum: ["loop"] }
    ],
    description: 'Execution level: omitted/false = preview only (default), true = execute exactly one action, "loop" = bounded loop.'
  },
  maxSteps: {
    type: "number",
    description: "Step budget override for a loop run."
  },
  allowRisky: {
    type: "boolean",
    description: "Allow externally visible or hard-to-undo actions. Defaults to false."
  },
  debug: {
    type: "boolean",
    description: "Keep provider-private debug detail on the result."
  }
};
function projectAction(action) {
  if (action === void 0) return void 0;
  return {
    kind: action.kind,
    candidateId: action.candidateId,
    description: action.description,
    ...typeof action.target === "string" || typeof action.target === "number" ? { target: action.target } : {},
    ...action.risky === true ? { risky: true } : {}
  };
}
function projectOutcome(outcome2) {
  if (outcome2.status === "needs_escalation" && outcome2.escalation !== void 0) {
    const escalation = outcome2.escalation;
    return {
      status: "needs_escalation",
      steps: outcome2.steps,
      guidance: escalation.guidance,
      ...escalation.provider === void 0 ? {} : { provider: escalation.provider },
      ...escalation.lastDecision?.selected === void 0 ? {} : { selected: escalation.lastDecision.selected },
      ...escalation.lastDecision?.confidence === void 0 ? {} : { confidence: escalation.lastDecision.confidence },
      ...escalation.lastDecision?.confidenceKind === void 0 ? {} : { confidenceKind: escalation.lastDecision.confidenceKind },
      ...escalation.details === void 0 ? {} : { debug: toJsonObject(escalation.details) }
    };
  }
  const action = projectAction(outcome2.action);
  return {
    status: outcome2.status,
    steps: outcome2.steps,
    ...outcome2.decision === void 0 ? {} : {
      provider: outcome2.decision.provider,
      mode: outcome2.decision.mode,
      latencyMs: outcome2.decision.latencyMs,
      ...outcome2.decision.selected === void 0 ? {} : { selected: outcome2.decision.selected },
      ...outcome2.decision.confidence === void 0 ? {} : { confidence: outcome2.decision.confidence },
      ...outcome2.decision.confidenceKind === void 0 ? {} : { confidenceKind: outcome2.decision.confidenceKind },
      ...outcome2.decision.debug?.rawConfidence === void 0 ? {} : { rawConfidence: outcome2.decision.debug.rawConfidence },
      ...outcome2.decision.debug === void 0 ? {} : { debug: toJsonObject(outcome2.decision.debug) }
    },
    ...action === void 0 ? {} : { action },
    ...outcome2.execution === void 0 ? {} : {
      executed: outcome2.execution.ok,
      ...outcome2.execution.message === void 0 ? {} : { executionMessage: outcome2.execution.message }
    },
    ...outcome2.stopReason === void 0 ? {} : { stopReason: outcome2.stopReason }
  };
}
function renderDecideOutput(output) {
  const lines = [];
  if (output.status === "needs_escalation") {
    lines.push("Escalation: this step needs the main agent.");
    if (output.provider !== void 0) lines.push(`Provider: ${output.provider}`);
    if (output.guidance !== void 0) lines.push(`Guidance: ${output.guidance}`);
    if (output.steps !== void 0) lines.push(`Steps taken: ${output.steps}`);
    if (output.debug !== void 0) lines.push(`Detail: ${JSON.stringify(output.debug)}`);
    return lines.join("\n");
  }
  lines.push(`Status: ${output.status}`);
  if (output.provider !== void 0) lines.push(`Provider: ${output.provider}`);
  if (output.mode !== void 0) lines.push(`Mode: ${output.mode}`);
  if (output.selected !== void 0) lines.push(`Decision: ${output.selected}`);
  if (output.confidence !== void 0) {
    const kind = output.confidenceKind === void 0 ? "" : ` (${output.confidenceKind})`;
    lines.push(`Confidence: ${output.confidence.toFixed(3)}${kind}`);
  } else if (output.confidenceKind !== void 0) {
    lines.push(`Confidence: unavailable (${output.confidenceKind})`);
  }
  if (output.rawConfidence !== void 0 && output.rawConfidence !== output.confidence) {
    lines.push(`Provider raw confidence (own scale, not gated): ${output.rawConfidence.toFixed(3)}`);
  }
  if (output.latencyMs !== void 0) lines.push(`Provider latency: ${output.latencyMs}ms`);
  if (output.candidates !== void 0 && output.candidates.length > 0) lines.push(`Ranked candidates: ${output.candidates.join(" > ")}`);
  if (output.action !== void 0) {
    const target = output.action.target === void 0 ? "" : ` target=${String(output.action.target)}`;
    lines.push(`Mapped action: ${output.action.kind}${target} \u2014 ${output.action.description}${output.action.risky === true ? " [risky]" : ""}`);
  }
  if (output.executed !== void 0) lines.push(`Executed: ${output.executed ? "yes" : "no"}`);
  if (output.executionMessage !== void 0) lines.push(`Environment: ${output.executionMessage}`);
  if (output.steps !== void 0) lines.push(`Steps: ${output.steps}`);
  if (output.stopReason !== void 0) lines.push(`Note: ${output.stopReason}`);
  if (output.debug !== void 0) lines.push(`Debug: ${JSON.stringify(output.debug)}`);
  return lines.join("\n");
}
async function executeDecide(input, context, signal) {
  const { service } = context;
  const mode = executionModeOf(input.execute);
  const debug = input.debug === true;
  const environmentId = typeof input.environment === "string" && input.environment !== "" ? input.environment : void 0;
  if (environmentId !== void 0) {
    const outcome2 = await service.run({
      environment: environmentId,
      objective: objectiveOf(input),
      mode,
      ...input.provider === void 0 ? {} : { provider: input.provider },
      ...input.candidates === void 0 ? {} : { candidates: input.candidates },
      ...input.mode === void 0 ? {} : { decisionMode: input.mode },
      ...input.maxSteps === void 0 ? {} : { config: { maxSteps: input.maxSteps } },
      ...input.allowRisky === void 0 ? {} : { allowRisky: input.allowRisky },
      ...signal === void 0 ? {} : { signal },
      debug
    });
    return projectOutcome(outcome2);
  }
  if (input.state === void 0) {
    throw new DecisionError("invalid_request", "decision_decide needs state or environment.");
  }
  if (input.candidates === void 0 || input.candidates.length === 0) {
    throw new DecisionError("no_candidates", "decision_decide needs a non-empty candidates array when no environment is given.");
  }
  const result = await service.decide({
    ...input.objective === void 0 ? {} : { objective: input.objective },
    state: input.state,
    candidates: input.candidates.map((candidate) => ({
      id: candidate.id,
      description: candidate.description,
      ...candidate.metadata === void 0 ? {} : { metadata: candidate.metadata }
    })),
    ...input.mode === void 0 ? {} : { mode: input.mode },
    ...input.provider === void 0 ? {} : { provider: input.provider },
    ...input.constraints === void 0 ? {} : { constraints: input.constraints }
  }, {
    ...input.provider === void 0 ? {} : { provider: input.provider },
    ...signal === void 0 ? {} : { signal },
    debug
  });
  const ranked = (result.ranking ?? []).map((entry) => entry.id);
  return {
    status: "decided",
    provider: result.provider,
    mode: result.mode,
    ...result.selected === void 0 ? {} : { selected: result.selected },
    candidates: ranked.length > 0 ? ranked : input.candidates.map((candidate) => candidate.id),
    ...result.confidence === void 0 ? {} : { confidence: result.confidence },
    ...result.confidenceKind === void 0 ? {} : { confidenceKind: result.confidenceKind },
    ...result.debug?.rawConfidence === void 0 ? {} : { rawConfidence: result.debug.rawConfidence },
    latencyMs: result.latencyMs,
    ...result.debug === void 0 ? {} : { debug: toJsonObject(result.debug) },
    stopReason: "Decision only: nothing was executed."
  };
}

// src/tools/decision-decide.ts
function defineDecideTool(context) {
  const { service } = context;
  return defineTool({
    name: "decision_decide",
    description: 'Ask the decision layer to choose among a finite candidate set, or to observe a browser/computer environment and choose the next action there. Returns the selected candidate, the ranked alternatives, a provider id, and \u2014 with an environment \u2014 the concrete action the choice maps to. Decision only by default; pass execute to run one action, or execute "loop" for a bounded loop. Information the environment cannot express as structured state comes back as status "needs_escalation", never as a guess.',
    parameters: PARAMETERS,
    timeoutMs: 18e4,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", required: true, enum: ["decided", "executed", "done", "needs_escalation"] },
          provider: { type: "string" },
          mode: { type: "string", enum: ["choice", "ranking", "score", "classification"] },
          selected: { type: "string" },
          candidates: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
          confidenceKind: { type: "string", enum: ["normalized", "provider_raw", "unavailable"] },
          rawConfidence: { type: "number" },
          latencyMs: { type: "number" },
          action: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", required: true },
              candidateId: { type: "string", required: true },
              description: { type: "string", required: true },
              target: {
                oneOf: [
                  { type: "string" },
                  { type: "number" }
                ]
              },
              risky: { type: "boolean" }
            }
          },
          executed: { type: "boolean" },
          executionMessage: { type: "string" },
          steps: { type: "number" },
          debug: { type: "object", additionalProperties: true },
          guidance: { type: "string" },
          stopReason: { type: "string" }
        }
      },
      render: (_args, value) => {
        const output = value;
        return [{ type: "text", text: renderDecideOutput(output) }];
      }
    },
    execute: async (args, exec) => {
      const input = args;
      const violation = preflightDecideInput(input, service);
      if (violation !== void 0) {
        throw new DecisionError("invalid_request", violation);
      }
      return executeDecide(input, { service, ...exec.agent === void 0 ? {} : { agent: exec.agent } }, exec.signal);
    }
  });
}

// src/skill.ts
var DECISION_CONTROL_SKILL_NAME = "decision-control";
var DECISION_CONTROL_SKILL = {
  name: DECISION_CONTROL_SKILL_NAME,
  description: "Use the decision layer: fast, low-latency choices over a finite candidate set, and single-step or bounded-loop control of a browser, desktop, or custom environment.",
  whenToUse: "Invoke /decision-control when a task is a repeated choice among a known finite set of options, or when a browser/app/game flow should be driven step by step by a small decision model instead of by planning on every turn.",
  content: `# Decision Control

Use the decision layer when the next step is a *choice among known options*, not an open-ended plan. The layer is
fast, deterministic in shape, and bounded: it selects, ranks, or scores the candidates you give it, and it never
invents an action.

## The one tool

\`decision_decide\` covers all three levels:

| Level | Call | What happens |
| --- | --- | --- |
| Decision only | \`decision_decide { objective, state, candidates }\` | Chooses a candidate and returns a preview of the action it maps to. Nothing is executed. |
| Single step | \`... { environment, execute: true }\` | Observes the environment, decides, maps the decision to one concrete action, executes it, returns the result. |
| Bounded loop | \`... { environment, execute: "loop", maxSteps }\` | Repeats observe \u2192 decide \u2192 map \u2192 execute \u2192 verify until the objective is met or a stop condition fires. |

## When to use it

- A form or wizard page where the only question is "which control advances this flow".
- A desktop dialog where the accessibility tree names the buttons.
- A game or simulator that exposes structured state and a finite action list.
- Any repeated decision where re-planning on every turn is wasteful.

## When not to use it

- The environment has no structured state: canvas-only pages, WebGL, video, empty DOMs, anonymous accessibility
  groups. The layer returns \`needs_escalation\` with reason \`insufficient_observation\` or
  \`environment_unsupported\` \u2014 take the step over yourself. Do not retry hoping for a different answer.
- The task needs vision, OCR, or screenshot reading. This layer is text-only by design.
- The task needs real planning, or the next action cannot be written down as a finite candidate set.

## Reading the result

- \`status: decided\` \u2014 a decision was made; \`action\` previews what it maps to. Pass \`execute: true\` to run it.
- \`status: executed\` / \`done\` \u2014 an action ran; \`executionMessage\` carries the environment's own report.
- \`status: needs_escalation\` \u2014 the layer refused to continue. Trust it: read \`guidance\`, and handle the step
  yourself or ask the user. The \`debug\` field names the machine-readable reason.

## Boundaries worth remembering

- The layer does not own browser or computer permission. If a capability is not authorized in this session, the
  environment call is refused exactly as a direct tool call would be; invoke the capability's own skill first
  (\`/browser\`, \`/computer-use\`).
- Candidates are supplied by the caller or derived from the environment's structured state. The decision model
  never emits a tool call, and the layer never maps a decision to a tool by asking the model what to do.
- Risky actions are refused unless the caller passes \`allowRisky: true\`.
`,
  source: "dsh-decision-engine",
  invocation: {
    modelInvocable: false,
    userInvocable: true
  },
  metadata: {
    "dsh:gate": {
      toolPrefixes: ["decision_"],
      promptSections: ["tool:decision"]
    }
  }
};

// src/plugin.ts
var name = "decision-engine";
var inject = ["tools"];
var HostToolDispatcher = class {
  #ctx;
  #callCounter = 0;
  constructor(ctx) {
    this.#ctx = ctx;
  }
  availableTools() {
    try {
      return this.#ctx.tools.schemas().map((schema) => schema.name);
    } catch {
      return [];
    }
  }
  async call(request) {
    const tools = this.#ctx.get("tools");
    if (tools === void 0) {
      return toolFailure(request.name, "the host tool registry is not mounted");
    }
    const agent = requestAgent(this.#ctx);
    this.#callCounter += 1;
    const callId = `decision-engine:${this.#callCounter}`;
    try {
      const result = await tools.execute({
        callId,
        name: request.name,
        arguments: request.arguments,
        ...agent === void 0 ? {} : { agent },
        signal: request.signal ?? new AbortController().signal
      });
      const text = result.content.map((block) => block.type === "text" ? block.text : "").filter((part) => part !== "").join("\n");
      if (result.isError) {
        const message = typeof result.error === "object" && result.error !== null && "message" in result.error ? String(result.error.message) : text;
        return { ok: false, text, error: `${request.name}: ${message === "" ? "the tool call failed" : message}` };
      }
      return { ok: true, text };
    } catch (error) {
      const failure = toDecisionFailure(error);
      return toolFailure(request.name, failure.message);
    }
  }
};
function requestAgent(ctx) {
  const candidate = ctx.agent;
  return candidate === void 0 || candidate === null ? void 0 : candidate;
}
function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const dispatcher = new HostToolDispatcher(ctx);
  const gate = () => ctx.get(TOOL_LAZY_GATE_SERVICE);
  const computerSeam = ctx.get("computer");
  const composition = createDecisionEngineComposition({
    config,
    dispatcher,
    ...computerSeam === void 0 ? {} : { computerSeam },
    readCapabilityGate: (capability) => {
      const agent = requestAgent(ctx);
      return queryCapabilityUnlocked(gate(), agent, capability);
    }
  });
  ctx.provide("decisionEngine", composition.service);
  ctx.effect(() => () => {
    void composition.dispose();
  }, "decision-engine composition");
  ctx.tools.register(defineDecideTool({ service: composition.service }));
  const skills = ctx.get("skills");
  if (skills !== void 0) {
    ctx.effect(() => skills.register(DECISION_CONTROL_SKILL), "decision-control skill");
  }
  ctx.systemPrompt.section({
    name: "tool:decision",
    order: 106,
    text: 'The decision layer answers with a finite candidate set, never free-form actions: call `decision_decide` with an objective, the environment state (or an environment id), and the candidates. It decides by default; pass execute: true to run one mapped action, or execute: "loop" for a bounded loop. When the environment cannot express the task as structured state it returns status "needs_escalation" \u2014 take the step over yourself instead of retrying.'
  });
}
export {
  DECISION_CAPABILITIES,
  DECISION_CONFIDENCE_KINDS,
  DECISION_CONTROL_SKILL,
  DECISION_CONTROL_SKILL_NAME,
  DEFAULT_RUNTIME_CONFIG,
  DecisionError,
  DecisionRuntime,
  GATE_SKILL_NAMES,
  HostToolDispatcher,
  LayaDecisionProvider,
  LayaRuntime,
  TOOL_LAZY_GATE_SERVICE,
  abortableSleep,
  apply,
  clampUnit,
  createDecisionEngineComposition,
  createDecisionResult,
  createRingBufferSink,
  executeDecide,
  failedObservation,
  fingerprintState,
  inject,
  isDecisionCapability,
  isDecisionConfidenceKind,
  isDecisionErrorCode,
  name,
  normalizeConfidenceFromDistribution,
  okObservation,
  queryCapabilityUnlocked,
  renderDecideOutput,
  toDecisionFailure,
  toEscalation
};
