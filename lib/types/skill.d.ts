/**
 * The `decision-control` skill: the user-facing entry point of the decision
 * layer.
 *
 * It is deliberately model-neutral. There is no `/laya` skill: a skill named
 * after one decision model would make the workflow the property of that model,
 * and swapping models would mean renaming a skill the user types. This one
 * controls the *layer*, and the layer decides which provider answers.
 *
 * The skill is registered with `modelInvocable: false` and `userInvocable:
 * true`, matching how the browser and computer capabilities are authorized:
 * only an explicit user invocation surfaces it. That is also how the
 * session-lazy capability gate learns the user wants this family available.
 *
 * @module dsh-decision-engine/skill
 */
/** Skill name the user types (`/decision-control`). */
export declare const DECISION_CONTROL_SKILL_NAME = "decision-control";
/** The shipped skill body. Kept as a literal so no file read is needed at load time. */
export declare const DECISION_CONTROL_SKILL: {
    readonly name: "decision-control";
    readonly description: "Plan with the main agent, execute with a decision model: individual choices, single steps, or complete browser, desktop and API tasks.";
    readonly whenToUse: string;
    readonly content: "# Decision Control\n\nUse the decision layer when the next step is a *choice among known options*, not an open-ended plan. The layer is\nfast, deterministic in shape, and bounded: it selects, ranks, or scores the candidates you give it, and it never\ninvents an action.\n\n## Whole-task delegation\n\nThe main agent plans; the small model executes the plan; the main agent verifies the final result.\nFor a whole task, call `decision_run` ONCE with `objective`, `environment` or `endpoint`, and an ordered\n`plan`. Each plan stage has `id`, `objective`, and a `completion` rule over observed state. A rule uses\n`path` plus exactly one of `equals` or `includes`. For browser page text use `path: \"main\"`.\n\nThe executor reads state directly, selects actions with the decision model, dispatches them, and advances\nthe plan when the observed completion condition matches. It owns all intermediate clicks, submissions,\nand next-question operations. Do not relay questions, click next yourself, or invoke it once per move.\nVerify the returned result after completion; intervene only after an escalation.\n\nAn API environment can report its own terminal state and score. In that case `plan` is optional.\nFor an unplanned browser/desktop task, supply an explicit `completion` rule.\nDefaults are 1000 actions and 10 minutes; `maxSteps` and `maxDurationMs` can override them (DSH maximum 30 minutes).\nThe result includes `status`, `result`, `finalState`, and `completedPlanSteps`; an early failure also identifies\nthe `activePlanStep`. `done` means the environment ended or a supplied completion condition matched;\ncheck the result to distinguish success from a terminal failure.\n\n## Individual decisions and steps\n\n`decision_decide` covers all three levels:\n\n| Level | Call | What happens |\n| --- | --- | --- |\n| Decision only | `decision_decide { objective, state, candidates }` | Chooses a candidate and returns a preview of the action it maps to. Nothing is executed. |\n| Single step | `... { environment, execute: true }` | Observes the environment, decides, maps the decision to one concrete action, executes it, returns the result. |\n| Bounded loop | `... { environment, execute: \"loop\", maxSteps }` | Repeats observe → decide → map → execute → verify until the objective is met or a stop condition fires. |\n\n## When to use it\n\n- A form or wizard page where the only question is \"which control advances this flow\".\n- A desktop dialog where the accessibility tree names the buttons.\n- A game or simulator that exposes structured state and a finite action list.\n- Any repeated decision where re-planning on every turn is wasteful.\n\n## When not to use it\n\n- The environment has no structured state: canvas-only pages, WebGL, video, empty DOMs, anonymous accessibility\n  groups. The layer returns `needs_escalation` with reason `insufficient_observation` or\n  `environment_unsupported` — take the step over yourself. Do not retry hoping for a different answer.\n- The task needs vision, OCR, or screenshot reading. This layer is text-only by design.\n- The next action cannot be written down as a finite candidate set. Keep planning in the main agent and\n  delegate execution only after the plan and observable completion conditions are clear.\n\n## Reading the result\n\n- `status: decided` — a decision was made; `action` previews what it maps to. Pass `execute: true` to run it.\n- `status: executed` / `done` — an action ran; `executionMessage` carries the environment's own report.\n- `status: needs_escalation` — the layer refused to continue. Trust it: read `guidance`, and handle the step\n  yourself or ask the user. The `debug` field names the machine-readable reason.\n\n## Boundaries worth remembering\n\n- The layer does not own browser or computer permission. If a capability is not authorized in this session, the\n  environment call is refused exactly as a direct tool call would be; invoke the capability's own skill first\n  (`/browser`, `/computer-use`).\n- Candidates are supplied by the caller or derived from the environment's structured state. The decision model\n  never emits a tool call, and the layer never maps a decision to a tool by asking the model what to do.\n- Risky actions are refused unless the caller passes `allowRisky: true`.\n";
    readonly source: "dsh-decision-engine";
    readonly invocation: {
        readonly modelInvocable: false;
        readonly userInvocable: true;
    };
    readonly metadata: {
        readonly 'dsh:gate': {
            readonly toolPrefixes: readonly ["decision_"];
            readonly promptSections: readonly ["tool:decision"];
        };
    };
};
//# sourceMappingURL=skill.d.ts.map