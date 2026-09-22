// src/environments/http/adapter.ts
import { randomUUID } from "node:crypto";

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

// src/environments/http/adapter.ts
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
      actionId: randomUUID(),
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
export {
  ENVIRONMENT_PROTOCOL,
  HttpEnvironmentAdapter
};
