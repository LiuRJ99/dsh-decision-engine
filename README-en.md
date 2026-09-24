# dsh-decision-engine

**English** · [简体中文](README.md)

A general-purpose, model-agnostic **decision layer** for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): a
low-latency System-1 runtime that sits between an environment and the actions
taken in it.

Use `decision_decide` for an individual choice or action. For a complete task,
the main agent supplies its goal, ordered plan and completion conditions to
`decision_run` once. The small model executes the plan through browser tools,
desktop tools or an environment API, then returns the result for verification.
There is no main-agent relay between actions. See the [task takeover protocol](docs/任务接管协议.md)
for the flowchart, task schema, HTTP contract and runnable HTML example.

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
host-plane row. The `decision_decide` and `decision_run` tools and the `decision-control`
skill are registered by that row.

`lib/` is **committed**, matching the other DSH plugins in this workspace: a
git-hosted install receives a runnable entry without a build step, because
pnpm ≥ 10 refuses to run a dependency's build script. `npm run build`
regenerates it from `src/` byte-for-byte, so the committed artifacts can be
checked against the sources.

### Enabling the Laya provider

`@receptron/laya` is an **optional** peer, imported dynamically: without it the
plugin still loads, the provider reports `degraded`, and a decision fails with
`provider_unavailable` — the host never fails to start. Installing the plugin
alone therefore gives you the decision layer, the environments, and the tool;
answering decisions needs the model runtime as well.

```bash
# the model runtime (ONNX), in a directory the host process resolves from
pnpm add @receptron/laya
```

The bundle itself (≈1.6 GB of ONNX weights) is then resolved by the SDK. Point
at an existing export directory instead of downloading, either in config:

```yaml
providers:
  laya:
    modelDir: /path/to/exported/bundle   # holds laya.onnx, laya_config.json, tokenizer/
```

or through the environment, which the provider reads first:

| Variable | Meaning |
| --- | --- |
| `LAYA_MODEL_DIR` | bundle directory; skips the SDK's download entirely |
| `LAYA_EP` | execution providers, comma-separated (`cpu`, `coreml`, `cuda`, `dml`, `wasm`) |
| `LAYA_THREADS` | `intraOpNumThreads` override |
| `LAYA_CACHE`, `LAYA_REVISION`, `LAYA_SUBFOLDER` | where the SDK looks for a cached bundle |

Confirm it works before relying on it:

```bash
node examples/verify-real-laya.mjs --mode choice    # loads the bundle and reports latency
```

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

The first-level **Settings → Decision Engine** page selects the default Provider ID.
Only Laya ships built in; other decision models need their own registered IDs.
Each decision call can override the default with its `provider` argument.
Model paths, residency and execution budgets stay in deployment or task options.
Browser and computer actions use the Host's capability gate when a task selects
those environments; there is no environment switch in this page.

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
      # By default it loads on first use and releases after ten idle minutes.

  runtime:
    confidenceThreshold: 0.55   # NORMALIZED confidence only; see above
    maxSteps: 10
    maxDurationMs: 120000
    noProgressLimit: 3
    repeatedDecisionLimit: 3

```

Environment variables the Laya provider honours (read only inside
`providers/laya/config.ts`): `LAYA_MODEL_DIR`, `LAYA_EP`, `LAYA_THREADS`,
`LAYA_CACHE`, `LAYA_REVISION`, `LAYA_SUBFOLDER`.

### Stage-level candidate scope (v0.4.0)

Every stage of a plan may carry its own `scope`, applied while that stage is
active — in the existing `plan` parameter of `decision_run`, with no new tool
and no new argument. The keys belong to the adapter: the browser environment
understands `includeNonSemantic`, `candidateSelector` and `maxCandidates`.

It exists for flows where one item takes more than one decision — answering a
question, then moving on. Offer both kinds of control at once and the model has
to guess between them: it is pulled by the nouns in the objective and drifts
with the state (measured on one run: the same objective picked the navigation
control once and the submit control the next time). A stage scope removes the
wrong choice instead of hoping it is ignored:

```json
"plan": [
  { "id": "a-q1", "objective": "Choose the option you believe is correct",
    "scope": { "includeNonSemantic": true, "candidateSelector": ".option-item" },
    "completion": { "path": "main", "includes": "已答 1/49" }, "maxSteps": 3 },
  { "id": "n-q1", "objective": "Go to the next question",
    "scope": { "includeNonSemantic": true, "candidateSelector": "#next-btn" },
    "completion": { "path": "main", "includes": "第 2 题" }, "maxSteps": 3 }
]
```

A plan holds at most 64 stages; split longer work across calls. A stage without
a scope keeps the call-level configuration, and adapters without `withConfig`
ignore the field.
A step offering exactly one candidate never reaches the provider: there is
nothing to decide, and a small local head cannot answer it anyway (Laya's TopK
needs k=2 over one class and fails the step). The runtime executes it directly.

## Non-semantic browser controls

From v0.3.0, `decision_run` and `decision_decide` accept task-local `browser`
options: `includeNonSemantic`, `candidateSelector` and `maxCandidates` (1–64).
They require browser workspace v0.1.10 / bridge v0.0.10 or newer. For example,
`browser: { includeNonSemantic: true, candidateSelector: '.option-item, #next-btn' }`
offers inferred clickable controls only within that selector. Filters apply
before inventory caps, include form fields, and never fall back to the full page.
The extension must acknowledge the requested scope or observation stops.

Discovery uses named, visible inline-click controls and pointer boundaries,
not every div. Raw class tokens and explicit ARIA states let the provider see
selection changes; classes are untrusted evidence, not inferred checked states.
This adds addressable actions, not answer knowledge. Completion rules must
verify the intended business result. Global browser settings remain available;
task-local options do not mutate the registered adapter.

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

### Building this into a non-DSH host

External software (a game, a business system, a simulator) does not need DSH, a
tool registry, or any of its services. One call embeds the same layer:

```js
import { createDecisionLayer } from 'dsh-decision-engine/embed'

const decisions = createDecisionLayer({ laya: { modelDir: '/path/to/bundle' } })
decisions.environments.register(myGameAdapter)

const outcome = await decisions.runTask({
  environment: 'my-game',
  objective: 'Win this round.',
})
```

`runTask` and `decideEnvironment` return runtime escalations as a **value** (serializable, with
`guidance`) instead of throwing — the shape a bridge forwards. `decide` keeps
throwing for a caller that wants the `code`.

- [`docs/外部接入规范.md`](docs/外部接入规范.md) — the full external integration
  contract: both roles, the request/result types, the mandatory `confidenceKind`
  rule and its rejection cases, the escalation vocabulary, and an HTTP line
  format for out-of-process integration (including why an escalation is a 200).
- `examples/verify-embedding.mjs` — runs the whole embed path with **no DSH
  package present**.

## Environments

| Id | Transport | Reads | Refuses to guess when |
| --- | --- | --- | --- |
| `browser` | registered `browser_*` tools | structured snapshot text: title, url, numbered interactive inventory, form fields | canvas/WebGL-only pages, unparseable snapshots, unfinished pages without actions |
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

# every public entry resolved through the package's `exports` map, including the
# Cordis entry the bundle patch names (this is what caught a broken v0.1.0)
node examples/verify-exports.mjs

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
