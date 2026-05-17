import { describe, expect, test } from "bun:test";
import {
  getToolDefinitionOverride,
  isVisuallyEmptyLine,
  registerToolDefinitionOverride,
  shouldHideRenderedLines,
} from "../extensions/tool-execution-patch.ts";

// Build a raw SGR sequence (ESC [ ... m) without putting the escape character
// directly in source. Bun source files normalize to NFC and stripping it via
// the regex is what the patch relies on at runtime.
const ESC = String.fromCharCode(0x1b);
const RED = `${ESC}[31m`;
const RESET = `${ESC}[0m`;

describe("isVisuallyEmptyLine", () => {
  test("returns true for the empty string", () => {
    expect(isVisuallyEmptyLine("")).toBe(true);
  });

  test("returns true for whitespace-only lines", () => {
    expect(isVisuallyEmptyLine("   ")).toBe(true);
    expect(isVisuallyEmptyLine("\t \t")).toBe(true);
  });

  test("returns true for ANSI-only lines with no glyphs", () => {
    expect(isVisuallyEmptyLine(`${RED}${RESET}`)).toBe(true);
    expect(isVisuallyEmptyLine(`${RED}   ${RESET}`)).toBe(true);
  });

  test("returns false when any visible character is present", () => {
    expect(isVisuallyEmptyLine("hello")).toBe(false);
    expect(isVisuallyEmptyLine(`${RED}x${RESET}`)).toBe(false);
    expect(isVisuallyEmptyLine("·")).toBe(false);
  });
});

describe("shouldHideRenderedLines", () => {
  test("returns false for an empty render result (component already invisible)", () => {
    expect(shouldHideRenderedLines([])).toBe(false);
  });

  test("returns true when every line is visually empty (the Spacer-only case)", () => {
    expect(shouldHideRenderedLines([""])).toBe(true);
    expect(shouldHideRenderedLines(["", ""])).toBe(true);
    expect(shouldHideRenderedLines([`${RED}${RESET}`, "   "])).toBe(true);
  });

  test("returns false as soon as any line has visible content", () => {
    expect(shouldHideRenderedLines(["", "Explored 3 targets"])).toBe(false);
    expect(shouldHideRenderedLines(["Used 9 tools", ""])).toBe(false);
    expect(shouldHideRenderedLines(["Map ."])).toBe(false);
  });
});

describe("registerToolDefinitionOverride", () => {
  // Use a unique tool name so we don't collide with overrides registered by
  // installBasicToolGrouping at module-import time (fffind / ffgrep / …).
  const TOOL = "test-override-target-tool";

  test("stores an override that can be retrieved by name", () => {
    const renderCall = () => undefined;
    const renderResult = () => undefined;
    const dispose = registerToolDefinitionOverride(TOOL, { renderShell: "self", renderCall, renderResult });
    try {
      const got = getToolDefinitionOverride(TOOL);
      expect(got).toBeDefined();
      expect(got?.renderShell).toBe("self");
      expect(got?.renderCall).toBe(renderCall);
      expect(got?.renderResult).toBe(renderResult);
    } finally {
      dispose();
    }
  });

  test("disposer removes the override", () => {
    const dispose = registerToolDefinitionOverride(TOOL, { renderCall: () => undefined });
    expect(getToolDefinitionOverride(TOOL)).toBeDefined();
    dispose();
    expect(getToolDefinitionOverride(TOOL)).toBeUndefined();
  });

  test("disposer only removes the override it created (last-write-wins semantics)", () => {
    const firstDispose = registerToolDefinitionOverride(TOOL, { renderCall: () => "first" as unknown });
    const secondDispose = registerToolDefinitionOverride(TOOL, { renderCall: () => "second" as unknown });
    // The first disposer is now stale — it must not clear the second override.
    firstDispose();
    expect(getToolDefinitionOverride(TOOL)).toBeDefined();
    secondDispose();
    expect(getToolDefinitionOverride(TOOL)).toBeUndefined();
  });

  test("calling the disposer twice is a no-op", () => {
    const dispose = registerToolDefinitionOverride(TOOL, { renderCall: () => undefined });
    dispose();
    expect(getToolDefinitionOverride(TOOL)).toBeUndefined();
    expect(() => dispose()).not.toThrow();
  });
});

describe("foreign-tool overrides wired by installBasicToolGrouping", () => {
  test("fffind / ffgrep / fff-multi-grep have renderShell:'self' overrides registered", async () => {
    // Importing basic-tool-grouping triggers module-level state setup; install
    // registers the override entries. We pass a stub pi that satisfies the
    // typeof check so install runs to completion.
    const { installBasicToolGrouping } = await import("../extensions/basic-tool-grouping.ts");
    installBasicToolGrouping({ on: () => {} });
    for (const toolName of ["fffind", "ffgrep", "fff-multi-grep"] as const) {
      const override = getToolDefinitionOverride(toolName);
      expect(override).toBeDefined();
      expect(override?.renderShell).toBe("self");
      expect(typeof override?.renderCall).toBe("function");
      expect(typeof override?.renderResult).toBe("function");
    }
  });
});
