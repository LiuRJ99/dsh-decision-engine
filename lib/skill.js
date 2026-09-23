// src/skill.ts
var DECISION_CONTROL_SKILL_NAME = "decision-control";
var DECISION_CONTROL_SKILL = {
  name: DECISION_CONTROL_SKILL_NAME,
  description: "Plan with the main agent, execute with a decision model: individual choices, single steps, or complete browser, desktop and API tasks.",
  whenToUse: "Invoke /decision-control when a task is a repeated choice among a known finite set of options, or when a browser/app/game flow should be driven step by step by a small decision model instead of by planning on every turn.",
  content: `# Decision Control

Use the decision layer when the next step is a *choice among known options*, not an open-ended plan. The layer is
fast, deterministic in shape, and bounded: it selects, ranks, or scores the candidates you give it, and it never
invents an action.

## Whole-task delegation

The main agent plans; the small model executes the plan; the main agent verifies the final result.
For a whole task, call \`decision_run\` ONCE with \`objective\`, \`environment\` or \`endpoint\`, and an ordered
\`plan\`. Each plan stage has \`id\`, \`objective\`, and a \`completion\` rule over observed state. A rule uses
\`path\` plus exactly one of \`equals\` or \`includes\`. For browser page text use \`path: "main"\`.

The executor reads state directly, selects actions with the decision model, dispatches them, and advances
the plan when the observed completion condition matches. It owns all intermediate clicks, submissions,
and next-question operations. Do not relay questions, click next yourself, or invoke it once per move.
Verify the returned result after completion; intervene only after an escalation.

An API environment can report its own terminal state and score. In that case \`plan\` is optional.
For an unplanned browser/desktop task, supply an explicit \`completion\` rule.
For non-semantic browser controls, inspect the page first, then pass task-local
\`browser: { includeNonSemantic: true, candidateSelector: ".option-item, #next-btn" }\`
to either tool. Choose the selector from that page; include required navigation.
This requires browser workspace v0.1.10+. An unacknowledged scope stops the run.
Raw DOM classes are evidence, not guaranteed checked state. Verify recorded task
results in the completion rule; leaving the task page is not success.
Defaults are 1000 actions and 10 minutes; \`maxSteps\` and \`maxDurationMs\` can override them (DSH maximum 30 minutes).
The result includes \`status\`, \`result\`, \`finalState\`, and \`completedPlanSteps\`; an early failure also identifies
the \`activePlanStep\`. \`done\` means the environment ended or a supplied completion condition matched;
check the result to distinguish success from a terminal failure.

## Individual decisions and steps

\`decision_decide\` covers all three levels:

| Level | Call | What happens |
| --- | --- | --- |
| Decision only | \`decision_decide { objective, state, candidates }\` | Chooses a candidate and returns a preview of the action it maps to. Nothing is executed. |
| Single step | \`... { environment, execute: true }\` | Observes the environment, decides, maps the decision to one concrete action, executes it, returns the result. |
| Bounded loop | \`... { environment, execute: "loop", maxSteps }\` | Repeats observe \u2192 decide \u2192 map \u2192 execute \u2192 verify until the objective is met or a stop condition fires. |

## When to use it

- A form or wizard page where the only question is "which control advances this flow".
- A desktop dialog where the accessibility tree names the buttons.
- A game or simulator that exposes structured state and a finite action list.
- Any repeated decision where re-planning on every turn is wasteful.

## When not to use it

- The environment has no structured state: canvas-only pages, WebGL, video, empty DOMs, anonymous accessibility
  groups. The layer returns \`needs_escalation\` with reason \`insufficient_observation\` or
  \`environment_unsupported\` \u2014 take the step over yourself. Do not retry hoping for a different answer.
- The task needs vision, OCR, or screenshot reading. This layer is text-only by design.
- The next action cannot be written down as a finite candidate set. Keep planning in the main agent and
  delegate execution only after the plan and observable completion conditions are clear.

## Reading the result

- \`status: decided\` \u2014 a decision was made; \`action\` previews what it maps to. Pass \`execute: true\` to run it.
- \`status: executed\` / \`done\` \u2014 an action ran; \`executionMessage\` carries the environment's own report.
- \`status: needs_escalation\` \u2014 the layer refused to continue. Trust it: read \`guidance\`, and handle the step
  yourself or ask the user. The \`debug\` field names the machine-readable reason.

## Boundaries worth remembering

- The layer does not own browser or computer permission. If a capability is not authorized in this session, the
  environment call is refused exactly as a direct tool call would be; invoke the capability's own skill first
  (\`/browser\`, \`/computer-use\`).
- Candidates are supplied by the caller or derived from the environment's structured state. The decision model
  never emits a tool call, and the layer never maps a decision to a tool by asking the model what to do.
- Risky actions are refused unless the caller passes \`allowRisky: true\`.
`,
  source: "dsh-decision-engine",
  invocation: {
    modelInvocable: false,
    userInvocable: true
  },
  metadata: {
    "dsh:gate": {
      toolPrefixes: ["decision_"],
      promptSections: ["tool:decision"]
    }
  }
};
export {
  DECISION_CONTROL_SKILL,
  DECISION_CONTROL_SKILL_NAME
};
