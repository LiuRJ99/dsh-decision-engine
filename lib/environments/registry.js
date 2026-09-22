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
export {
  EnvironmentRegistry
};
