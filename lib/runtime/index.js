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
  stateFingerprintChars: 2e3,
  singleCandidateSteps: "ask"
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
   * would silently invalidate. Explicit environment configuration therefore
   * takes effect on the next start.
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
      let current = observation;
      if (plan !== void 0) {
        while (planIndex < plan.length && completionMatches(current.state, plan[planIndex].completion)) {
          planIndex++;
          planStartedAtStep = steps;
          applyStageScope(plan[planIndex]);
          if (planIndex === plan.length) return true;
          current = await observe();
          assertObservation(current);
          lastObservation = current;
        }
      }
      return isDone(current);
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
        let request = await phase("build request", config.observeTimeoutMs, () => activeAdapter.buildDecisionRequest(lastObservation, stepObjective));
        if (options.candidates !== void 0) request = { ...request, candidates: options.candidates };
        if (options.provider !== void 0) request = { ...request, provider: options.provider };
        if (options.decisionMode !== void 0) request = { ...request, mode: options.decisionMode };
        request = { ...request, metadata: { ...request.metadata, environment: adapter.id, step } };
        const offered = request.candidates ?? [];
        lastDecision = config.singleCandidateSteps === "execute" && offered.length === 1 ? { provider: "single-candidate", mode: request.mode ?? "choice", selected: offered[0].id, latencyMs: 0 } : await phase("decide", check(), (signal, timeoutMs) => this.#engine.decide(request, {
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
        if (mode === "decision-only") return { ...outcome("decided", "Decision-only mode: nothing was executed."), steps: 1, stepIndex: 0 };
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
  if (config.singleCandidateSteps !== "ask" && config.singleCandidateSteps !== "execute") {
    throw new DecisionError("invalid_request", 'singleCandidateSteps must be "ask" or "execute".');
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
  if (rule.includes === void 0) return value === rule.equals;
  const seen = /* @__PURE__ */ new WeakSet();
  const contains = (item) => {
    if (typeof item === "string") return item.includes(rule.includes);
    if (item !== null && typeof item === "object") {
      if (seen.has(item)) return false;
      seen.add(item);
      return (Array.isArray(item) ? item : Object.values(item)).some(contains);
    }
    return false;
  };
  return contains(value);
}
export {
  DEFAULT_RUNTIME_CONFIG,
  DEFAULT_TASK_CONFIG,
  DecisionRuntime,
  abortableSleep,
  fingerprintState,
  validateCompletion,
  validateRuntimeConfig
};
