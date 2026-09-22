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
  #pending = /* @__PURE__ */ new Map();
  #lastState;
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
    this.#pending = new Map(available.map((candidate) => [candidate.id, candidate]));
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
    const candidate = this.#pending.get(selected);
    if (candidate === void 0) {
      throw new DecisionError("unknown_candidate", `Decision "${selected}" does not map to an action of environment "${this.id}".`, {
        subject: this.id,
        details: { selected, offered: [...this.#pending.keys()] }
      });
    }
    void observation;
    return {
      kind: "custom",
      candidateId: candidate.id,
      description: candidate.description,
      ...candidate.action === void 0 ? {} : { payload: candidate.action },
      ...candidate.risky === true ? { risky: true } : {}
    };
  }
  /** Execute a mapped custom action. */
  async execute(action, input) {
    const candidate = this.#pending.get(action.candidateId);
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
  async dispose() {
    await this.#spec.dispose?.();
  }
};
function toDecisionState(value) {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  if (Array.isArray(value)) return { items: value };
  return { value };
}
export {
  CustomEnvironmentAdapter,
  toDecisionState
};
