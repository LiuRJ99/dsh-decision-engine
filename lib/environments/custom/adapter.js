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
    this.#offered.push(new Map(available.map((candidate) => [candidate.id, candidate])));
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
    const candidate = this.#findCandidate(selected);
    if (candidate === void 0) {
      throw new DecisionError("unknown_candidate", `Decision "${selected}" does not map to an action of environment "${this.id}".`, {
        subject: this.id,
        details: { selected, offered: [...this.#offered.at(-1)?.keys() ?? []] }
      });
    }
    void observation;
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
