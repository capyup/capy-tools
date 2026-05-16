# Design — Visual System Unification & Stronger Todo Prompting

Date: 2026-05-16
Scope: in-message group renderers (`basic-tool-grouping`, `thinking-steps`) and the `todo` extension's system-prompt injection.

## Problem

The grouped renderers — `Thinking N steps`, `Ran 12 commands`, `Tracked N todos` — share the same form (a header followed by a list of items) but use inconsistent colors. Concretely:

| Element | Today | Issue |
|---|---|---|
| `Thinking N steps` header (done) | `accent` | Loud; competes with `Ran N commands` (`muted`). |
| `Ran 12 commands` header (done) | `muted` | OK. |
| `• Ran git status` line (done) | `accent` | Loud; competes with thinking step content (`muted`). |
| `• <glyph> <step summary>` (done) | `muted` | OK. |
| Active thinking step | `accent + bold` | Different signal than active tool item (`warning`). |

The user reads the page and sees two different "rest" tones (some content `muted`, some `accent`) and two different "active" signals — there is no unified visual hierarchy.

Separately, the `todo` tool is used less frequently by Pi's agent than `TaskCreate` is by Claude Code, despite Pi already having a solid `promptGuidelines` list on the tool description. The missing piece is system-prompt-level reinforcement — Claude Code injects todo discipline into the system prompt itself, not just into the tool description.

## Goals

1. A single visual language across `basic-tool-grouping`, `thinking-steps`, and the `todo` in-stream renderer, derived from one principle (information priority), not three component-specific conventions.
2. Higher `todo` adoption by the agent, achieved by reinforcing usage discipline at the system-prompt layer (the same layer `work_checkpoint` already uses).

Non-goals: changing the persistent above-editor `TodoOverlay` widget's content color rules (it is a different surface with different ergonomics — see "Out of scope" below).

## Design

### Three-tier visual hierarchy

Every visible element belongs to exactly one tier:

| Tier | Purpose | Color | Applies to |
|---|---|---|---|
| **Tier 1 — Live** | The single thing happening right now, plus errors. | `warning` (running) / `error` (failed) | Running group header; running item marker; error markers and error item text. |
| **Tier 2 — Structure** | Skeleton that lets the eye locate a group. | `muted` | All done-state group headers; the `│` / `└` continuation connectors; non-active status glyphs. |
| **Tier 3 — Detail** | Content the user reads only when they choose to. | `muted` | Every item's text (command, step summary, todo subject) in every non-error state. |

Consequence: a finished page is almost entirely `muted`. When something is running, exactly one header (Tier 1) is `warning` and exactly one item marker (Tier 1) is `warning`. Errors are the only case where item text is allowed to leave the muted tier.

### Active-state signal: marker shape, not text color

Today, an active thinking step is `accent + bold` and an active tool call inherits the same headline color as its done sibling — neither approach is consistent and the bold/color combo is visually noisy. The new rule:

- **Done** item: marker is `•` in Tier 2 (`muted`).
- **Running** item: marker in Tier 1 (`warning`). Thinking uses its existing animated `pulseGlyph` (cycle through `· • ● •`); tool items use a single static `◐` glyph. These belong to the same visual family (rounded dots) so the page reads consistently, but the tool-group renderer does not need a per-tick redraw loop. Item text stays Tier 3 (`muted`).
- **Error** item: marker is `!` in `error` color; text in `error` color.

### Role glyphs lose their color

`thinking-steps/render.ts` currently maps semantic step roles (`compare`, `analyze`, `write`, `plan`, …) to colors (`warning`, `accent`, `muted`). Under the new hierarchy these colors violate Tier 2/3 (they introduce non-muted ink into otherwise-resting content). Decision: keep the glyph **shape** (it carries the semantic information), drop the color — all role glyphs render in `muted`.

### Bold

Active thinking steps are currently `bold + accent`. Under the new hierarchy:
- Drop the accent.
- Keep the bold **only on the active step's text** — bold is a weight signal, not a color, so it doesn't violate the muted-text rule and gives the active line a subtle "is being written right now" cue alongside the spinner marker.

(Tool items never go bold; their active signal is purely the spinner marker.)

### Concrete file/line changes

**`extensions/basic-tool-grouping.ts`**

- `wrapActionLine` (around line 302): change `headlineRole` to `error` on error, else `muted`. The `accent` branch is removed. Continuation lines follow the same `muted` rule.
- `formatCompactItem` (around line 321): for running items, replace the `•` marker with the shared spinner frame (warning color); for error items use `!`; for done items use `•` muted.
- `renderGroupLines` (around line 348): `titleRole` keeps its current behavior (`error` / `warning` / `muted`) — this is already correct.

**`extensions/thinking-steps/render.ts`**

- `roleColor` (around line 46–51): all roles return `"muted"`. (Function may simply be deleted and call sites pass `"muted"` literally.)
- Inline header (around line 322): `titleColor` for done state changes from `accent` to `muted`. Active state stays `warning`.
- Header step glyph (around line 340–342): same — active label `warning`, done `muted`.
- Step style record (around line 121–129):
  - Active: `markerColor: "warning"` (spinner), `summaryColor: "muted"`, `bold: true`.
  - Completed: `markerColor: "muted"` (`•`), `summaryColor: "muted"`, `bold: false`.
  - Skipped/other: `markerColor: "muted"`, `summaryColor: "muted"`, `bold: false`.
- Connector prefixes (around line 171–172): already `muted`, no change.

**`extensions/todo/render.ts` (standalone fallback path only — grouped path is already covered by the `basic-tool-grouping.ts` changes above)**

- `renderStandaloneCall` (line 151): `theme.fg("accent", ...)` → `theme.fg("muted", ...)`.
- `renderStandaloneResult` (line 159): `headlineColor` removes the `accent` branch — on non-error it returns `"muted"`. Error stays `"error"`.

These two functions only fire when `basic-tool-grouping` context is unavailable; in practice the grouped path covers normal use. They are updated for consistency so the rare fallback render does not silently violate the tier rules.

**Spinner frame source**

No new shared module. `thinking-steps/render.ts` keeps its existing `pulseGlyph`. `basic-tool-grouping.ts` uses a single static `◐` warning marker — the tool-group renderer does not have a tick loop and adding one would inflate the change scope. The two glyph families (animated `· • ● •` and static `◐`) share the rounded-dot visual family so consistency is preserved.

### Out of scope: TodoOverlay widget content color

The persistent above-editor `TodoOverlay` (`extensions/todo/overlay.ts`) is a different surface — it stays on screen between turns, summarizes plan state at a glance, and benefits from prominent (`text`-color) subjects for `pending` and `in_progress` items so the user can read their plan without focusing. Its widget header color rules (currently `accent` when active, `muted` otherwise) are aligned with the new in-stream rules — header switches to `warning` when something is in_progress, `muted` otherwise. Item subject colors inside the widget are left alone.

## Todo prompting reinforcement

### Current state

`extensions/todo/index.ts` exposes a `PROMPT_GUIDELINES` array that is attached to the tool's description. These guidelines are good but they live only on the tool definition. The agent must already be considering the todo tool for the guidelines to be read.

### Proposed addition

Add a `before_agent_start` system-prompt injection (mirroring the pattern `work_checkpoint` already uses) that contributes a short section to every turn's system prompt. The section text is modeled on Claude Code's TaskCreate description, condensed to four rules:

1. Use `todo` immediately when the user gives you 3+ steps, a multi-task list, or any new set of instructions you have not yet captured.
2. Skip it for single trivial requests and purely conversational turns.
3. Before starting a task, mark it `in_progress`. The moment a task is done, mark it `completed` — never batch completions.
4. Exactly one task is `in_progress` at a time.

These four rules already exist inside `PROMPT_GUIDELINES`. The change is that they are now also injected into the system prompt every turn, where they sit alongside the rest of the agent's working discipline (similar to how `work_checkpoint` injects its rule).

### Co-existence with work_checkpoint

`work_checkpoint` already injects a per-turn system prompt section. The todo injection is additive — it produces a second section under a clearly labeled heading. Order of injection in the file is deterministic so the system prompt stays stable across runs.

### Explicitly deferred

- **Stale-todo reminder** (inject a one-time reminder when the agent has run N tool calls without touching `todo`). This needs session-scoped state tracking and risks interacting with `work_checkpoint`'s injection. Ship the system-prompt rule first; measure whether the staleness reminder is still needed.
- **Visual change to `Tracked N todos` group header**: handled by the three-tier hierarchy above; no separate work.

## Risks

- **TUI capture regressions.** Multiple existing snapshot tests assert on rendered colors. Every spec change above will break at least one snapshot. The plan must call out which captures need refreshing and require a real-Pi `npm run test:tui-capture:current` confirmation before considering the work done.
- **Glyph drift.** Two separate marker sources (animated thinking pulse vs. static tool-item `◐`) can drift in visual feel if either side changes glyph family. Mitigation: both live within the same `extensions/` directory and the design note above documents the rounded-dot family as the shared constraint.
- **Todo injection inflation.** Each per-turn injection costs tokens. The injected section must stay under ~6 short lines.
- **Bold-on-active-thinking-step in mismatched terminals.** Some terminal themes render bold as a different color. We accept this — the user's terminal already has acceptable bold rendering for thinking-steps today.

## Validation plan

1. Update unit tests so each renderer's color-token assertions reflect the new tier rules. Files affected (expected):
   - `tests/repo-map-read-block.test.ts` — basic-tool-grouping done/running/error color and marker assertions.
   - `tests/thinking-steps.test.ts` — done header `muted`, role glyph `muted`, active step `muted` text + bold + warning spinner marker.
   - `tests/grouping-showcase.test.ts` — multi-tool transcript expectations.
   - `tests/todo.test.ts` — standalone-fallback renderer color, and a new assertion that the system-prompt injection contains the four rules.
   - `tests/ui-tools.test.ts` — work_checkpoint injection co-existence (assert both sections present, in deterministic order).
2. `npm run check` clean.
3. `npm run test:tui-capture` showing thinking + tool group + todo in one transcript, with manual inspection of the colors against the tier table.
4. `npm run test:tui-capture:current` (real settings) to verify nothing in the live extension load path regresses.

## Open questions

None — the user delegated aesthetic decisions; both the tier framework and the todo injection content above are final unless changed during plan review.
