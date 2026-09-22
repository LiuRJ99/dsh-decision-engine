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
function byScoreDescending(left, right) {
  const leftScore = left.score ?? Number.NEGATIVE_INFINITY;
  const rightScore = right.score ?? Number.NEGATIVE_INFINITY;
  if (rightScore !== leftScore) return rightScore - leftScore;
  return left.index - right.index;
}
function rankByScore(entries) {
  return entries.map((entry, index) => ({ id: entry.id, score: entry.score, index })).sort(byScoreDescending).map((entry) => entry.score === void 0 ? { id: entry.id } : { id: entry.id, score: entry.score });
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
export {
  DEFAULT_SCORE_LEVELS,
  LayaDecisionProvider,
  LayaRuntime,
  QUESTION_KEYS,
  defaultLayaModuleLoader,
  fillTemplate,
  planQuestions,
  resolveLayaConfig,
  toResult,
  translateAnswers
};
