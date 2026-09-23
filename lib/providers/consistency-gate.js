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

// src/providers/consistency-gate.ts
var CAPABILITY_ORDER = ["choice", "ranking", "score", "classification"];
var ConsistencyGatedProvider = class {
  id;
  capabilities;
  #primary;
  #fallback;
  #rotation;
  #stats = {
    probes: 0,
    agreements: 0,
    disagreements: 0,
    fallbacks: 0,
    primaryFailures: 0,
    bothFailed: 0
  };
  constructor(options) {
    const { primary, fallback } = options;
    if (primary === void 0 || fallback === void 0) {
      throw new DecisionError("invalid_request", "A consistency gate needs both a primary and a fallback arm.", { subject: "consistency-gate" });
    }
    if (primary === fallback) {
      throw new DecisionError("invalid_request", "The primary and fallback arms must be different providers.", { subject: "consistency-gate" });
    }
    this.id = options.id ?? `${primary.id}-consistency-gated`;
    this.#primary = primary;
    this.#fallback = fallback;
    this.#rotation = options.rotation ?? 1;
    this.capabilities = CAPABILITY_ORDER.filter(
      (capability) => primary.capabilities.includes(capability) && fallback.capabilities.includes(capability)
    );
  }
  async decide(request, context) {
    const startedAt = Date.now();
    const arm = (result, providerId, notes) => {
      const out = { ...result, provider: providerId, latencyMs: Date.now() - startedAt };
      if (notes !== void 0 && context?.debug === true) {
        out.debug = { ...result.debug, notes: [...result.debug?.notes ?? [], notes] };
      }
      return out;
    };
    let first;
    try {
      first = await this.#primary.decide(request, context);
    } catch (error) {
      this.#stats.primaryFailures += 1;
      return await this.#recover(error, request, context, arm);
    }
    if (first.selected === void 0 || request.candidates.length < 2) {
      return arm(first, this.#primary.id, "gate: not applicable (no selection to re-check)");
    }
    const rotated = rotate(request.candidates, this.#rotation);
    const second = await this.#primary.decide({ ...request, candidates: rotated }, context);
    this.#stats.probes += 1;
    if (second.selected === first.selected) {
      this.#stats.agreements += 1;
      return arm(first, this.#primary.id, `gate: order-invariant (same id under rotation ${this.#effectiveRotation(request.candidates.length)})`);
    }
    this.#stats.disagreements += 1;
    const note = `gate: rejected "${this.#primary.id}" \u2014 it answered "${first.selected}" in the given order and "${second.selected}" after rotating the candidates by ${this.#effectiveRotation(request.candidates.length)}; the answer tracks position, not the candidates.`;
    try {
      const recovered = await this.#fallback.decide(request, context);
      this.#stats.fallbacks += 1;
      return arm(recovered, this.#fallback.id, note);
    } catch (error) {
      this.#stats.bothFailed += 1;
      throw new DecisionError(
        "provider_failed",
        `${note} The fallback arm "${this.#fallback.id}" also failed: ${messageOf(error)}`,
        { subject: this.id, details: { primary: this.#primary.id, fallback: this.#fallback.id, primarySelected: first.selected, primarySelectedRotated: second.selected } }
      );
    }
  }
  /** The primary threw: try the fallback, and only surface a failure if it fails too. */
  async #recover(error, request, context, arm) {
    const note = `gate: "${this.#primary.id}" failed (${messageOf(error)}); answered by the fallback arm.`;
    try {
      const recovered = await this.#fallback.decide(request, context);
      this.#stats.fallbacks += 1;
      return arm(recovered, this.#fallback.id, note);
    } catch (fallbackError) {
      this.#stats.bothFailed += 1;
      throw new DecisionError(
        "provider_failed",
        `Both arms failed. "${this.#primary.id}": ${messageOf(error)}. "${this.#fallback.id}": ${messageOf(fallbackError)}`,
        { subject: this.id, details: { primary: this.#primary.id, fallback: this.#fallback.id } }
      );
    }
  }
  /** Snapshot of the gate's bookkeeping. */
  stats() {
    return { ...this.#stats };
  }
  /**
   * `unavailable` when an arm cannot serve at all, `degraded` when only the fallback
   * is usable — in that case every decision is answered by a non-primary arm, which
   * callers should see rather than discover.
   */
  async healthCheck() {
    const [primary, fallback] = await Promise.all([
      checkArm(this.#primary),
      checkArm(this.#fallback)
    ]);
    const details = { primary, fallback, stats: this.stats() };
    if (primary.status === "unavailable" && fallback.status === "unavailable") {
      return { status: "unavailable", reason: "Both arms are unavailable.", details };
    }
    if (primary.status !== "ok") {
      const why = primary.reason === void 0 ? "" : ` (${primary.reason})`;
      return { status: "degraded", reason: `Primary arm "${this.#primary.id}" is ${primary.status}${why}; decisions fall back to "${this.#fallback.id}".`, details };
    }
    if (fallback.status !== "ok") {
      const why = fallback.reason === void 0 ? "" : ` (${fallback.reason})`;
      return { status: "degraded", reason: `Fallback arm "${this.#fallback.id}" is ${fallback.status}${why}; a rejected answer cannot be recovered.`, details };
    }
    return { status: "ok", details };
  }
  async dispose() {
    await Promise.allSettled([
      Promise.resolve(this.#primary.dispose?.()),
      Promise.resolve(this.#fallback.dispose?.())
    ]);
  }
  /** Non-zero rotation, modulo the candidate count. */
  #effectiveRotation(count) {
    const normalized = (Math.trunc(this.#rotation) % count + count) % count;
    return normalized === 0 ? 1 : normalized;
  }
};
function rotate(items, by) {
  const n = items.length;
  if (n < 2) return [...items];
  const normalized = (Math.trunc(by) % n + n) % n;
  const k = normalized === 0 ? 1 : normalized;
  return [...items.slice(k), ...items.slice(0, k)];
}
async function checkArm(provider) {
  if (provider.healthCheck === void 0) return { status: "ok" };
  try {
    return await provider.healthCheck();
  } catch (error) {
    return { status: "unavailable", reason: `healthCheck threw: ${messageOf(error)}` };
  }
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
export {
  ConsistencyGatedProvider
};
