# Visual Redesign: Unified Tree Style for Tool Grouping and Thinking Steps

**Date**: 2026-05-16
**Status**: Draft (awaiting user review)

## Problem

The current UI has three concrete defects, surfaced by a real session screenshot:

1. **Monotonous flat list**: every grouped tool row renders as `• <muted text>`, with only muted / warning / error variations. The eye has no anchor; nothing distinguishes a read from a run from an error.
2. **Inconsistent visual languages between thinking-steps and basic-tool-grouping**: `thinking-steps` uses `┆ Thinking Steps` + `├─/└─ ◫/⌕/↔/✓/✎/◇` tree connectors with role glyphs; `basic-tool-grouping` uses a flat `Ran N commands` + `• ...` list. The user sees these as two unrelated UIs in the same session.
3. **`write_stdin` noise**: every `poll` and `write` against an `exec_command` session renders a top-level row (`• stdin #1 · poll`), drowning out the actual work.
4. **Thinking Steps only shows one step per block**: each `thinking` content block renders its own `ThinkingStepsComponent`. When a turn produces several short thinking blocks interleaved with tool calls, each block contributes only one row to its own "Thinking Steps" section, so the user sees disconnected single-step thoughts rather than the chain.

## Goals

- **Unify** the visual language across `thinking-steps` and `basic-tool-grouping`. The user should perceive them as the same UI applied to different kinds of work.
- **Break the monotony** without inflating information density. Variation comes from role color, role glyph shape, and status accents — not from extra meta columns.
- **Hide stdin noise** at the row level. Aggregate it back into the parent `exec_command` row as a count suffix.
- **Show a multi-step chain** in Thinking Steps even when the model produces several short thinking blocks per turn.

## Non-Goals

- Theming overhaul. All colors reference existing theme tokens (`mdLink`, `accent`, `warning`, `success`, `error`, `mdCode`, `muted`, `dim`); how those tokens map to RGB is a separate concern handled by the user's theme.
- New tools or new tool semantics. We are not adding fields, only relayering presentation.
- Layout changes outside the group/thinking blocks (skill header, status bar, todo overlay, editor footer all stay as-is).

## Design Decisions (confirmed with user)

| Question | Answer |
|---|---|
| Unification direction | Both UIs adopt the tree style (winner over flat-merge or status-quo). |
| Source of variety | Per-role colors + per-role glyphs + status accents (not info density). |
| Thinking step count | Merge across same-turn blocks; show latest 5. |
| stdin handling | Hide rows, merge into parent `exec_command` as meta (`· 3 polls · 1 write`). |
| Layout variant | A — single-char connectors, inline `·` meta, no vertical guide. |

## Visual System

### Connector

- Branch: `├ ` (3 visible columns including space)
- Tail: `└ ` (3 visible columns)
- Color: theme token `muted`
- No `│` vertical guide between header and items. Variant A keeps it tight; the connector itself implies the tree.

### Role glyphs + colors

| Role      | Glyph | Color token | Used by |
|-----------|-------|-------------|---------|
| `inspect` | `◫`   | `mdLink`    | `read`, `read_block`, `ls`, `repo_map`, `symbol_outline`; thinking `inspect` |
| `search`  | `⌕`   | `accent`    | `grep`, `find`, `sourcegraph`, `fffind`, `ffgrep`, `fff-multi-grep`; thinking `search` |
| `compare` | `↔`   | `warning`   | thinking `compare` (no basic-tool counterpart) |
| `write`   | `✎`   | `success`   | `apply_patch`; thinking `write` |
| `run`     | `▸`   | `warning`   | `bash`, `exec_command` |
| `network` | `↗`   | `mdCode`    | `fetch` |
| `plan`    | `◇`   | `accent`    | `todo`; thinking `plan` |
| `ask`     | `?`   | `accent`    | `ask_user`, `ask_question`, `ask_questionnaire` |
| `verify`  | `✓`   | `success`   | thinking `verify` (no basic-tool counterpart) |
| `running` | `◐`   | `warning`   | any role + status=running (overrides role glyph) |
| `error`   | `!`   | `error`     | any role + status=error (overrides role glyph) |
| `default` | `·`   | `muted`     | unknown role |

The marker glyph is the colored element. The headline text is `muted` (or `error` for failed rows). The continuation prefix is `  │ ` in `muted`.

### Group header

- Thinking: `Thinking Steps  · 4 thoughts` (drop ` · N thoughts` when count == 1).
- Basic tools: existing `groupTitle()` output kept verbatim — `Ran 7 commands`, `Edited 3 files`, `Explored 4 targets`, `Fetched 2 resources`, `Tracked 3 todos`, `Used N tools`. The previous `┆` prefix is removed for thinking parity; both UIs now have header-then-tree.
- Header color: `muted` by default. Promotes to `warning` if any item is running, to `error` if any item failed. This is the existing `groupStatus()` logic, applied to the thinking renderer as well (active stream → warning).

### Hint footer

- `(ctrl+o to expand)` retained in `muted` only when the group is collapsed. No change to keybinding wiring.

### Sample rendering

```
Thinking Steps  · 4 thoughts
├ ◫ Inspect Users/lucas.
├ ▸ Run ocr scripts and analyze output
├ ⌕ Search proxy alternatives
└ ✓ Verify file size and pages.

Ran 7 commands
├ ▸ ocr-large-pdf.sh
├ ▸ ocr-curl-fallback.sh   · 2 polls
├ ◫ ocr-curl-fallback.sh   · 113 lines
├ ◫ troubleshooting.md     · 147 lines
├ ! scutil --proxy         · failed
├ ▸ for ip in ...          · 1 poll
└ ▸ HTTPS_PROXY=...        · 1 poll
```

## Behavioral Changes

### A. thinking-steps: merge same-turn blocks

**Today**: `AssistantMessageComponent` (patched by `thinking-steps/internal-patch.ts`) creates a fresh `ThinkingStepsComponent` per `thinking` content block. A turn with 3 thinking blocks (interleaved with tool calls) renders 3 separate "Thinking Steps" sections, each with whatever steps that one block yielded — usually 1.

**After**: per assistant message, the first thinking block creates the component; later thinking blocks of the same message append their `ThinkingSourceBlock` into that component and their own render returns `[]`. The merged component shows the last 5 steps in chronological order (not the salience-weighted selection used by the existing `selectSummarySteps`); older steps collapse into a leading `… N earlier thoughts` row (`muted`).

The salience-based `selectSummarySteps` is replaced (within the merged-thinking path) by a simple `steps.slice(-5)` — the user wants "latest" not "most salient". The salience scoring logic stays available for `collapsed` mode (where only one step shows and salience genuinely helps pick the right one).

Mechanism:
- Add a `messageTimestamp → ThinkingStepsComponent` map keyed off the assistant message identity, in either `state.ts` or `internal-patch.ts`.
- When `AssistantMessageComponent` asks for a renderer for content index `K`, check whether a renderer already exists for this `messageTimestamp`. If yes, push the new block into that renderer and return an `EmptyContainer`. If no, instantiate as today and register it.
- On `message_end` / `session_shutdown` / `message_start`(`role=user`), clear the map for the affected timestamps.

Edge case: the active step indicator (pulse + accent) must follow the truly active step across blocks. The existing `ActiveThinkingState.contentIndex` already references a content-index; the merged component just needs to scan all its source blocks (not only one) when resolving `activeStepId`.

### B. basic-tool-grouping: hide stdin, merge into parent exec_command

**Today**: `write_stdin` is in `BASIC_TOOL_NAMES`, so each call (poll, write, interrupt) yields a row like `• stdin #1 · poll`. Group count `Ran N commands` includes these.

**After**:
- Remove `write_stdin` from `BASIC_TOOL_NAMES` so it never reaches `getOrCreateItem` and never renders.
- Add a module-local `stdinAggregator: Map<sessionId, { polls: number; writes: number; interrupts: number }>` to `basic-tool-grouping.ts`.
- Add a `pi.on("message_update", …)` branch (or extend the existing one) that, when it sees a `write_stdin` toolCall, increments the aggregator without creating an item.
- Add a parent-lookup: maintain `execCommandBySession: Map<sessionId, toolCallId>` populated when an `exec_command` row gets a `session_id` from its result (`details.session_id`).
- When rendering an `exec_command` row, look up its `sessionId` in the aggregator and append the non-zero counts as inline meta: `· 3 polls · 1 write` (or `· 1 interrupt` etc.).
- `Ran N commands` group count is naturally correct because stdin items never enter the group.

Edge case: stdin call lands without a registered parent (stale session, or parent in a previous group). Drop silently. This matches today's "invalid session" semantics — no row, no meta. Logged at `debug` level if useful.

Edge case (rare): a turn contains only a `write_stdin` interrupt and no `exec_command` in the current group. We degrade to a single visible row `▸ Interrupted #<sid>` (special case in the aggregator → flush as one row when its parent is missing AND the call is an interrupt).

### C. Layout variant A (per-row format)

```
{connector}{glyph} {headline}[  · {meta}]
```

- `connector`: `├ ` for non-last, `└ ` for last (3 cols).
- `glyph`: 1 col, colored per role/status.
- `headline`: existing `actionHeadline()` output; the leading verb (`Ran`/`Read`/etc.) is preserved.
- `meta`: existing `summary.detail` rendering (`113 lines`, `failed`, `output 6 lines`, plus the new `N polls/writes/interrupts`).
- Wrap: if the row exceeds width, break at word boundary; continuation lines prefixed with `  │ ` (`muted`). Maximum 3 continuation lines (matches today's `MAX_ACTION_CONTINUATION_LINES`).
- Width < 30 cols: truncate to `connector + glyph + 1 char + …`.

## Files Affected

| File | Change |
|---|---|
| `extensions/shared/visual.ts` (new) | Exports `ROLE_GLYPHS`, `ROLE_COLORS`, `STATUS_OVERRIDES`, `treeConnector(isLast)`, `renderTreeRow({ glyph, role, status, headline, meta, theme, width })`. Single source of truth for the visual system. |
| `extensions/basic-tool-grouping.ts` | Remove `write_stdin` from `BASIC_TOOL_NAMES`. Replace `formatCompactItem` markers (`•/◐/!`) with `renderTreeRow` calls. Replace `wrapActionLine` `marker`-based logic with shared tree row renderer. Add `stdinAggregator` + `execCommandBySession` + meta injection at render time. Adjust `groupTitle` (no change — keep verbatim). Adjust `roleIcon` to delegate to `ROLE_GLYPHS`. |
| `extensions/thinking-steps/render.ts` | `renderGroupHeader` becomes `Thinking Steps[  · N thoughts]`. `wrapStepHeader` connector becomes `├ /└ ` via shared helper. Role glyphs/colors come from `ROLE_GLYPHS`/`ROLE_COLORS` (shared module supersedes local `roleGlyph` / `roleColor`). Remove `┆` prefix. Keep `MAX_SUMMARY_STEPS = 5` and `… N earlier thoughts` rollup. |
| `extensions/thinking-steps/internal-patch.ts` | Implement per-message merging: track `messageTimestamp → ThinkingStepsComponent`, redirect subsequent thinking blocks into the first component, clear map on message boundaries. |
| `extensions/thinking-steps/state.ts` | Possibly extend `getActiveThinkingState` to accept any of the merged component's blocks (or expose a helper to check "is any block in this set active"). |
| `tests/grouping-showcase.test.ts` | Update existing fixtures to the new tree format. Add a role × status matrix fixture. Add a stdin-merge fixture (`exec_command` + 3 polls + 1 write → single `▸ ... · 3 polls · 1 write` row). |
| `tests/thinking-steps.test.ts` | Update existing renderer assertions to new header/connector shapes. Add a multi-block merge test feeding 3 `ThinkingSourceBlock`s within one message timestamp and asserting one component output containing the union of steps. |
| `tests/network-tools.test.ts` | Add `write_stdin` aggregation test if not already covered by grouping-showcase. |
| `scripts/capture-pi-tui.py` | No code change required, but golden ANSI capture needs regeneration after the renderer change. |

## Edge Cases

1. **stdin without parent exec_command** (stale `session_id`): drop silently. No row, no meta. Same as today's invalid-session semantics.
2. **Turn has only thinking, no tools**: merged thinking component still renders.
3. **Mid-stream rendering of thinking**: an active block's most recent step gets `accent` color in summary mode. The existing `pulseGlyph` animation is kept for `collapsed` mode (where one step is shown). The component invalidates and re-renders on every `thinking_delta`. Separately, a `running` row in `basic-tool-grouping` shows a static `◐` marker in `warning` color — there is no pulse animation on individual tool rows.
4. **Width < 30 cols**: minimum row is `connector + glyph + 1 char + …`. Continuation suppressed.
5. **Expand (`ctrl+o`)**: removes `MAX_COLLAPSED_ITEMS = 5` cap and lists all members of the group. Same shortcut binding as today.
6. **Error styling**: error item's marker is `!` (`error`), the headline text is `error` (not `muted`). Group header turns `error` if any item failed (existing `groupStatus()` propagation).
7. **All-stdin turn** (e.g., a single Ctrl-C interrupt with no surrounding `exec_command` in the current group): special-case the aggregator to emit a single `▸ Interrupted #<sid>` row instead of dropping silently.
8. **Theme without a color token** (custom themes that omit `mdLink` etc.): fall back to `muted` for that role. The visual system survives missing tokens gracefully.

## Testing

- `tests/grouping-showcase.test.ts`: extend with a role × status matrix fixture and a stdin-aggregation fixture; assert the rendered plain-text shape and ANSI color tags.
- `tests/thinking-steps.test.ts`: assert single-block render (1 component, N steps), multi-block merge (3 blocks → 1 component with merged steps), and active-step accent across blocks.
- `npm run test:tui-capture`: regenerate the golden PTY transcript with a real `pi` session; assert that the captured output uses `├`/`└` connectors and contains no `stdin` rows.
- Manual smoke: run a session that calls `exec_command` for a long-running command + 3-5 polls + 1 write; visually verify the row reads `▸ <cmd>  · 3 polls · 1 write` with no separate stdin rows.

## Open Questions

None outstanding for the design. Implementation details (exact field names for the merge map, exact import path for the shared visual module) are left to the writing-plans phase.
