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
export {
  DEFAULT_RUNTIME_CONFIG,
  DecisionRuntime,
  abortableSleep,
  fingerprintState
};
