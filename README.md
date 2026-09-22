# dsh-decision-engine

A general-purpose, model-agnostic **decision layer** for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): a
low-latency System-1 runtime that sits between an environment and the actions
taken in it.

```text
Environment  →  Environment Adapter  →  Decision Request  →  Decision Engine
                                                                   ↓
                                                          Decision Router
                                                                   ↓
                                                          Decision Provider
                                                                   ↓
Environment  ←  Action Mapper  ←  Decision Result  ←────────────────┘
```

Laya is the first provider, not the architecture. Swapping it for a rule engine,
an ONNX classifier, an RL policy, or another model is a registry change; the
browser, computer, and custom-environment adapters are untouched.

## The boundary this project enforces

| Layer | Responsibility | Never does |
| --- | --- | --- |
| **Environment** | observe structured state; execute real actions | decide |
| **Environment Adapter** | observation → decision request; decision → concrete action | know which model answered |
| **Decision Engine** | validate, route, enforce capability and deadlines, normalize | know a tool name or a model |
| **Decision Provider** | answer a finite candidate set | emit a tool call, invent an action |
| **Action Mapper** (in the adapter) | candidate id → `browser_click(index=17)` | interpret model output |

Three invariants are enforced by tests, not by convention
(`tests/unit/architecture.test.ts`):

1. `core/`, `runtime/`, `environments/`, and `tools/` never import a provider.
   Deleting `src/providers/laya/` leaves all of them compiling.
2. No file outside `providers/laya/` mentions the Laya SDK, ONNX, or the
   `choice`/`score`/`noul` question vocabulary.
3. No decision provider ever learns a tool name (`browser_click`,
   `computer_use_*`, …). Providers see candidate ids and descriptions.

## Install

```bash
# from a pinned Git tag (the workspace's standard source form)
dsh plugin --profile web-candidate add github:LiuRJ99/dsh-decision-engine#v0.1.0

# or from a local checkout / release tarball
dsh plugin --profile web-candidate add /path/to/dsh-decision-engine

dsh --profile web-candidate --dump-config      # verify, then promote
```

The package declares `dsh.bundle.patch` → `cordis.patch.yml`, which inserts one
host-plane row. The single `decision_decide` tool and the `decision-control`
skill are registered by that row.

`lib/` is **committed**, matching the other DSH plugins in this workspace: a
git-hosted install receives a runnable entry without a build step, because
pnpm ≥ 10 refuses to run a dependency's build script. `npm run build`
regenerates it from `src/` byte-for-byte, so the committed artifacts can be
checked against the sources.

`@receptron/laya` is an **optional** peer: it is imported dynamically. Without
it the plugin still loads and the provider reports `degraded`; decisions fail
with `provider_unavailable` instead of the host failing to start.

## Use

### As a tool

```jsonc
// decide only — nothing is executed
{
  "objective": "Advance the flow to Success.",
  "state": { "step": "review", "fieldsFilled": true },
  "candidates": [
    { "id": "submit", "description": "Submit the form" },
    { "id": "edit", "description": "Keep editing" },
    { "id": "wait", "description": "Wait for the page" }
  ]
}
```

```jsonc
// observe a browser/desktop environment, execute one mapped action
{ "environment": "browser", "objective": "Advance the flow to Success.", "execute": true }
```

```jsonc
// bounded loop: observe → decide → map → execute → verify, until done or stopped
{
  "environment": "snake",
  "objective": "Eat as much food as possible without dying.",
  "execute": "loop",
  "maxSteps": 24
}
```

### As a host service

```ts
const decision = await ctx.decisionEngine.decide({
  objective: 'Choose the next step',
  state,
  candidates,
})
decision.selected       // 'submit'
decision.ranking        // [{ id: 'submit', score: 0.8 }, …]
decision.confidence     // 0.84
decision.confidenceKind // 'normalized' — what that number IS
decision.latencyMs      // provider latency only
```

### Confidence: one number, one declared scale

Confidence values are **not comparable across providers**: a softmax head, a
classifier posterior, a rule margin, and an RL value estimate all live on
different scales. The protocol therefore requires every confidence number to
travel with a `confidenceKind`:

| Kind | Meaning | Gated by `confidenceThreshold`? |
| --- | --- | --- |
| `normalized` | the provider mapped its own number onto a comparable 0..1 scale | **yes** |
| `provider_raw` | the provider's own number, on its own scale | no |
| `unavailable` | this provider/mode cannot produce a comparable number | no |

A confidence with no kind is rejected at validation, so a provider cannot
silently ship an unlabelled number into a threshold comparison.

The Laya provider reports `provider_raw`. That is a measurement, not caution: on
the real bundle its entropy-derived confidence does not track decision quality
(a state with no relevant information scores 0.039, a clear decision 0.15), and
the option-dominance alternative ranks a torn decision above a clear one. See
`examples/laya-head-calibration.mjs`. A calibrated head later changes one label
in `providers/laya/modes.ts` and the global floor starts applying to it.

`ctx.decisionEngine` also exposes `providers`, `environments`, `runtime`,
`health()`, `telemetry()`, and `run()`.

## Configuration

```yaml
decisionEngine:
  enabled: true
  defaultProvider: laya

  providers:            # provider-private settings live here, never at the top level
    laya:
      enabled: true
      modelDir: /path/to/exported/bundle
      device: cpu       # or coreml / cuda / dml / wasm, or a comma-separated list
      threads: 0

  runtime:
    confidenceThreshold: 0.55   # NORMALIZED confidence only; see above
    maxSteps: 10
    maxDurationMs: 120000
    noProgressLimit: 3
    repeatedDecisionLimit: 3

  browser:
    enabled: true
  computer:
    enabled: true
    # app: com.apple.TextEdit      # target app; omit until one is chosen
    # captureTimeoutMs: 30000      # a capture that blocks on a permission prompt still settles
```

Environment variables the Laya provider honours (read only inside
`providers/laya/config.ts`): `LAYA_MODEL_DIR`, `LAYA_EP`, `LAYA_THREADS`,
`LAYA_CACHE`, `LAYA_REVISION`, `LAYA_SUBFOLDER`.

## Adding a provider

Three steps, and none of them touches an environment:

```ts
// 1. implement the interface
class JevDecisionProvider implements DecisionProvider {
  readonly id = 'jev'
  readonly capabilities = ['choice', 'ranking', 'score', 'classification'] as const
  async decide(request: DecisionRequest, context?: DecisionContext): Promise<DecisionResult> { … }
  async healthCheck(): Promise<ProviderHealth> { … }
}

// 2. register it (config, or the composition's extraProviders)
registry.register(new JevDecisionProvider(), { enabled: true })

// 3. point the default at it
//    defaultProvider: jev
```

`tests/integration/game-adapter.test.ts` executes exactly this claim: the same
adapter, two different providers, identical mapped actions.

## Environments

| Id | Transport | Reads | Refuses to guess when |
| --- | --- | --- | --- |
| `browser` | registered `browser_*` tools | structured snapshot text: title, url, numbered interactive inventory, form fields | canvas/WebGL-only pages, no interactive elements, unparseable snapshot |
| `computer` | `ctx.computer` seam, or `computer_use_*` tools | the daemon's accessibility tree text and element indexes | anonymous-group-only trees, a diff with no full capture to merge onto, no addressable nodes |
| custom | the environment's own callbacks | whatever structured state it exposes | it exposes none |

All three are **text-only**. No screenshot is requested, read, or analyzed
anywhere in this package.

### A custom environment in full

```ts
const snake = new CustomEnvironmentAdapter<SnakeState>({
  id: 'snake',
  observe: () => game.snapshot(),                        // { head, food, availableActions, … }
  candidates: state => state.availableActions.map(a => ({ id: a, description: `Move ${a}` })),
  execute: candidate => game.apply(candidate.id),
  isDone: state => state.alive === false || state.score >= 5,
})
registry.register(snake)
```

## Permission boundaries

The decision layer **does not own** browser or computer permission and cannot
widen it:

- Environment actions are dispatched through the host's registered tools
  (`ctx.tools.execute`), so they pass the same pre-execute policy, the same
  session capability gate, the same approval seam, and the same timeout
  wrappers as a model call.
- The plugin *reads* the lazy gate (`ctx.toolLazyGate.isUnlocked`) only to
  refuse early with an accurate message. It never installs a guard, never
  grants a capability, and never reimplements the gate.
- If `/browser` or `/computer-use` was not invoked by the user, the
  environment call is refused exactly as a direct tool call would be, and the
  decision layer escalates.

## Escalation

Every refusal is a typed reason, and every refusal returns the same shape
(`status: 'needs_escalation'` plus `guidance`) so the main agent always learns
the same thing. The vocabulary lives in `src/core/errors.ts`:

```text
provider_unknown  provider_unavailable  provider_unsupported_capability
invalid_decision  unknown_candidate     low_confidence      provider_timeout
provider_failed   insufficient_observation  environment_unsupported
environment_unknown  environment_unavailable  no_candidates  invalid_request
action_mapping_failed  action_execution_failed  no_progress  repeated_decision
budget_exhausted  aborted  needs_vision  needs_planning  high_risk_action  internal
```

There is no `while (true)`: every loop is bounded by `maxSteps`, by
`maxDurationMs`, and by the caller's abort signal.

## Development

```bash
npm run typecheck     # tsc --noEmit, strict + exactOptionalPropertyTypes
npm test              # 187 tests, node:test, no build step
npm run build         # esbuild entries + tsc declarations into lib/
npm run bench         # per-layer latency table
```

### Verification scripts

```bash
# real ONNX provider, all four modes, latency + confidence-gate report
node examples/verify-real-laya.mjs --repeat 3

# a REAL accessibility tree through the whole loop (listApps → capture → adapter
# → DecisionRequest → Laya → mapped element-indexed action; nothing is clicked)
node examples/verify-real-ax-loop.mjs --list
node examples/verify-real-ax-loop.mjs --app com.apple.finder

# why the Laya confidence is reported as provider_raw rather than normalized
node examples/laya-head-calibration.mjs --repeat 4

# a game driven end to end, by the local heuristic and by the real model
node examples/demo-custom-game.mjs
node examples/demo-custom-game.mjs --provider laya

# one real desktop action through the decision layer (previews unless --yes)
node examples/verify-real-computer.mjs --app Finder

# the decision tool dispatched through a real ctx.tools registry
node examples/verify-host-integration.mjs

# the plugin booted against a real Cordis context (run from a profile root)
cd "$HOME/.dsh/profiles" && node <this repo>/examples/verify-plugin-boot.mjs

# the browser flow fixture used by the browser integration test
python3 -m http.server 8099 --directory tests/fixtures
```

## Layout

```text
src/
├── core/            the protocol: types, errors, validation, registry, router, engine, telemetry
├── runtime/         the bounded runner (observe → decide → map → execute → verify)
├── environments/    types, registry, dispatcher seam, browser/, computer/, custom/
├── providers/laya/  the first provider: SDK runtime, mode translation, config
├── tools/           decide-logic.ts (host-free) + decision-decide.ts (the tool)
├── composition.ts   build the layer without a host
├── plugin.ts        the Cordis entry (dispatcher, tool, skill, ctx.decisionEngine)
├── gate.ts          read-only lazy-gate awareness
└── skill.ts         the /decision-control skill
```

## Limits

- No vision, no OCR, no screenshot understanding, no canvas CV, no coordinate
  inference from pixels.
- Canvas/WebGL/video-only pages and anonymous accessibility trees are
  `environment_unsupported` / `insufficient_observation` — by design, not as a
  gap to be filled by guessing.
- The accessibility-tree parser is written against the daemon's current render
  format (`[role] [title] Description: … (traits) Value: … Help: … ID: …
  Secondary Actions: …`, tab-indented, depth-first index). That format is an
  undocumented contract: the parser matches roles against the daemon's own
  vocabulary and reports unrecognized lines instead of dropping them, and
  `tests/unit/environments.test.ts` pins the format with verbatim captures.
- Complex planning stays with the main agent: this layer chooses within a
  candidate set, it does not generate plans.
- No `while (true)`, no unbounded retry, no free-form action generation by a
  provider.

## License

MIT
