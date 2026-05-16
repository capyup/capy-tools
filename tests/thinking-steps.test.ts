import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderThinkingStepsLines, ThinkingStepsComponent } from "../extensions/thinking-steps/render.ts";
import { deriveThinkingSteps } from "../extensions/thinking-steps/parse.ts";
import {
  setCurrentThinkingScopeKey,
  setThinkingStepsMode,
  setActiveThinkingState,
  clearActiveThinkingState,
} from "../extensions/thinking-steps/state.ts";
import type { ThinkingSourceBlock, ThinkingThemeLike } from "../extensions/thinking-steps/types.ts";

const repoRoot = new URL("..", import.meta.url).pathname;

// A width-accurate theme returns the raw text so `visibleWidth` from
// pi-tui keeps reporting the real visible width.  Real Pi themes wrap text
// in ANSI escapes that are stripped before width math; a tagging stub would
// not be stripped and would push lines into bogus wraps.
const widthSafeTheme: ThinkingThemeLike = {
  fg(_color, text) {
    return text;
  },
  bold(text) {
    return text;
  },
};

// A tagging theme is only used for color-assertion tests where the input is
// short enough to fit on a single line so no width math is involved.
const taggingTheme: ThinkingThemeLike = {
  fg(color, text) {
    return `<${color}>${text}</${color}>`;
  },
  bold(text) {
    return `<b>${text}</b>`;
  },
};

function makeBlocks(...texts: string[]): ThinkingSourceBlock[] {
  return texts.map((text, index) => ({ contentIndex: index, text }));
}



const sampleBlocks = makeBlocks(
  "First I need to inspect the renderer implementation to see how it draws steps.",
  "Then I'll compare visibility toggling between the new and old renderer.",
  "Finally I'll verify that the refresh path still fires after a mode change.",
);

describe("thinking-steps parse + render", () => {
  test("derives one step per paragraph", () => {
    const steps = deriveThinkingSteps(sampleBlocks);
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps[0]?.summary.length).toBeGreaterThan(0);
  });

  test("splits single-newline action lines into separate steps", () => {
    const text = [
      "Inspect the server configuration.",
      "Check the Redis connection.",
      "Verify the API endpoint.",
    ].join("\n");
    const steps = deriveThinkingSteps([{ contentIndex: 0, text }]);
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps[0]?.summary.toLowerCase()).toContain("inspect");
    expect(steps[1]?.summary.toLowerCase()).toContain("check");
    expect(steps[2]?.summary.toLowerCase()).toContain("verify");
  });

  test("does not over-split a single cohesive paragraph", () => {
    // A single paragraph with multiple sentences but no clear action cues
    // on every line should stay as one step.
    const text =
      "I need to understand the current state before making changes. " +
      "The renderer seems to have a bug in the refresh path. " +
      "Let me trace through the code carefully.";
    const steps = deriveThinkingSteps([{ contentIndex: 0, text }]);
    expect(steps.length).toBe(1);
  });

  test("is a passive renderer with no user-facing controls", async () => {
    const indexSource = await readFile(join(repoRoot, "extensions/thinking-steps/index.ts"), "utf8");

    // Adding a slash command or shortcut would expose user-facing controls
    // that we explicitly do not want for the renderer.
    expect(indexSource).not.toContain("registerCommand");
    expect(indexSource).not.toContain("registerShortcut");
    // We also do not want a persistence file, a status bar entry, or any
    // user notifications.
    expect(indexSource).not.toContain("setStatus");
    expect(indexSource).not.toContain("ui.notify");
    expect(indexSource).not.toContain("./persistence.ts");
    expect(indexSource).not.toContain("setHiddenThinkingLabel");
  });

  test("summary mode renders a tree-shaped header + connector rows", () => {
    const steps = deriveThinkingSteps(sampleBlocks);
    const lines = renderThinkingStepsLines(widthSafeTheme, 200, {
      mode: "summary",
      steps,
      isActive: false,
    });
    expect(lines.length).toBeGreaterThan(1);

    const header = lines[0] ?? "";
    expect(header).toContain("Thinking Steps");
    // The `┆` left-margin decoration is gone after the visual redesign.
    expect(header).not.toContain("┆");

    // Step rows use single-char tree connectors ├ / └.
    const stepRows = lines.slice(1).filter((line) => line.includes("├ ") || line.includes("└ "));
    expect(stepRows.length).toBe(Math.min(steps.length, 5));

    // Role icons are colored by their semantic role.
    const hasColoredIcon = lines.some((line) =>
      line.includes("◫") || line.includes("⌕") || line.includes("↔") || line.includes("✓") || line.includes("✎") || line.includes("◇") || line.includes("!")
    );
    expect(hasColoredIcon).toBe(true);
  });

  test("collapsed mode renders a tree-connector summary line with a pulse glyph when active", () => {
    const steps = deriveThinkingSteps([
      { contentIndex: 0, text: "Inspect renderer." },
    ]);
    const lines = renderThinkingStepsLines(widthSafeTheme, 200, {
      mode: "collapsed",
      steps,
      isActive: true,
      activeStepId: steps[0]?.id,
      nowMs: 0,
    });
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const text = lines[0] ?? "";
    // Collapsed line starts with the upstream-style tree connector.
    expect(text.startsWith("│ Thinking ")).toBe(true);
    // The trailing pulse glyph belongs to the current animation frame, which
    // is one of `·`, `•`.
    expect(/[·•]\s*$/u.test(text)).toBe(true);
  });

  test("expanded mode emits tree connectors and body with markdown structure", () => {
    const steps = deriveThinkingSteps([
      { contentIndex: 0, text: "Inspect renderer implementation.\nWe need to read the file." },
      { contentIndex: 1, text: "Compare visibility toggling.\nLook at the old and new path." },
    ]);
    const lines = renderThinkingStepsLines(widthSafeTheme, 200, {
      mode: "expanded",
      steps,
      isActive: false,
    });
    // Step headers use single-char tree connectors.
    expect(lines.some((line) => line.includes("├ "))).toBe(true);
    expect(lines.some((line) => line.includes("└ "))).toBe(true);
    // Body lines use the tree continuation connector (│  ) for non-last steps.
    expect(lines.some((line) => line.includes("│  "))).toBe(true);
  });

  test("active thinking step uses accent color + bold", () => {
    const blocks = makeBlocks("Investigating the renderer right now to find the bug.");
    const steps = deriveThinkingSteps(blocks);
    const activeId = steps[0]!.id;
    const lines = renderThinkingStepsLines(taggingTheme, 200, {
      mode: "summary",
      steps,
      activeStepId: activeId,
      isActive: true,
    });
    // The active step header uses the accent-colored connector.
    // With only one step the connector is └ (last); with multiple it would be ├ .
    const activeRow = lines.find((line) => line.includes("<accent>└ </accent>")) ?? "";
    expect(activeRow).toMatch(/<accent>└ <\/accent>/);
    // Summary text is also accent-colored and bold.
    expect(activeRow).toMatch(/<b><accent>[^<]*<\/accent><\/b>/);
  });

  test("done Thinking summary header uses dim color", () => {
    const steps = deriveThinkingSteps(sampleBlocks);
    const lines = renderThinkingStepsLines(taggingTheme, 200, {
      mode: "summary",
      steps,
      activeStepId: undefined,
      isActive: false,
    });
    expect(lines[0]).not.toContain("┆");
    expect(lines[0]).toContain("Thinking Steps");
    expect(lines[0]).toContain("3 thoughts");
  });

  test("active signal lives on step connectors, not the group header", () => {
    // Upstream puts the active signal on step connectors, not on the group header.
    const steps = deriveThinkingSteps(sampleBlocks);
    const lines = renderThinkingStepsLines(taggingTheme, 200, {
      mode: "summary",
      steps,
      activeStepId: steps[0]!.id,
      isActive: true,
    });
    expect(lines[0]).toContain("Thinking Steps");
    const activeRow = lines.find((line) => line.includes("<accent>├ </accent>"));
    expect(activeRow).toBeDefined();
  });

  test("done collapsed Thinking label uses dim", () => {
    const steps = deriveThinkingSteps(sampleBlocks);
    const lines = renderThinkingStepsLines(taggingTheme, 200, {
      mode: "collapsed",
      steps,
      activeStepId: undefined,
      isActive: false,
      nowMs: 0,
    });
    expect(lines[0]).toContain("<muted>│</muted>");
    expect(lines[0]).toContain("<dim>Thinking</dim>");
    expect(lines[0]).not.toContain("<accent>Thinking</accent>");
  });

  test("role glyphs render in role color", () => {
    const blocks = makeBlocks(
      "I need to compare the new and old renderers carefully.",
      "Let me inspect the existing implementation to understand it.",
      "I'll verify the fix works against a real capture.",
    );
    const steps = deriveThinkingSteps(blocks);
    const lines = renderThinkingStepsLines(taggingTheme, 200, {
      mode: "summary",
      steps,
      activeStepId: undefined,
      isActive: false,
    });
    const stepRows = lines.filter((line) => line.includes("├ ") || line.includes("└ "));
    expect(stepRows.length).toBeGreaterThanOrEqual(3);
    // Verify that role icons are colored by their semantic role.
    expect(lines.some((line) => line.includes("<warning>↔</warning>"))).toBe(true);  // compare
    expect(lines.some((line) => line.includes("<mdLink>◫</mdLink>"))).toBe(true);   // inspect
    expect(lines.some((line) => line.includes("<success>✓</success>"))).toBe(true); // verify
  });

  test("uses accent color for the connector of the active step", () => {
    const steps = deriveThinkingSteps(sampleBlocks);
    const lines = renderThinkingStepsLines(taggingTheme, 200, {
      mode: "summary",
      steps,
      isActive: true,
      activeStepId: steps[0]?.id,
    });
    const activeRow = lines.find((line) => line.includes("<accent>├ </accent>"));
    expect(activeRow).toBeDefined();
  });

  test("multiple thinking blocks within one message merge into one component", () => {
    setCurrentThinkingScopeKey("merge-test");
    setThinkingStepsMode("summary", "merge-test");
    clearActiveThinkingState(undefined, "merge-test");

    const messageTimestamp = 1234567890;
    // Two thinking blocks, each with one short paragraph (parser yields one step each).
    const block1: ThinkingSourceBlock[] = [{ contentIndex: 0, text: "Inspect Users/lucas." }];
    const block2: ThinkingSourceBlock[] = [{ contentIndex: 2, text: "Verify file size and pages." }];

    const c1 = new ThinkingStepsComponent(widthSafeTheme, messageTimestamp, block1, "merge-test");
    const c2 = new ThinkingStepsComponent(widthSafeTheme, messageTimestamp, block2, "merge-test");

    // After redesign: the second component for the same message timestamp
    // returns [], its steps merged into the first.
    const linesFirst = c1.render(200);
    const linesSecond = c2.render(200);

    expect(linesSecond).toEqual([]);
    // First component now renders 2 steps under one header.
    const stepRows = linesFirst.filter((line) => line.includes("├ ") || line.includes("└ "));
    expect(stepRows.length).toBe(2);
    expect(linesFirst.some((line) => line.includes("Inspect"))).toBe(true);
    expect(linesFirst.some((line) => line.includes("Verify"))).toBe(true);
    expect(linesFirst[0]).toContain("Thinking Steps");
    expect(linesFirst[0]).toContain("2 thoughts");

    clearActiveThinkingState(undefined, "merge-test");
  });

  test("ThinkingStepsComponent honours the scope mode", () => {
    const scopeKey = "test-scope";
    setCurrentThinkingScopeKey(scopeKey);
    setThinkingStepsMode("summary", scopeKey);
    clearActiveThinkingState(undefined, scopeKey);

    const component = new ThinkingStepsComponent(widthSafeTheme, 42, sampleBlocks, scopeKey);
    const summaryLines = component.render(200);
    expect(summaryLines.length).toBeGreaterThan(1);

    setThinkingStepsMode("collapsed", scopeKey);
    setActiveThinkingState({ active: true, messageTimestamp: 42, contentIndex: 0 }, scopeKey);
    component.invalidate();
    const collapsedLines = component.render(200);
    expect(collapsedLines.length).toBeGreaterThanOrEqual(1);
    expect(collapsedLines[0] ?? "").toMatch(/^│ Thinking /);

    clearActiveThinkingState(undefined, scopeKey);
  });
});
