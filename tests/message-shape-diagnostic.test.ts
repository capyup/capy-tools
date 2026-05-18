import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import messageShapeDiagnosticExtension, {
  computeShape,
  type ShapeRecord,
} from "../extensions/message-shape-diagnostic.ts";
import { createExtensionHost } from "./extension-host.ts";

const ENV_FLAG = "PI_BASIC_TOOLS_DIAG_SHAPES";
const ENV_PATH = "PI_BASIC_TOOLS_DIAG_SHAPES_PATH";

describe("computeShape", () => {
  test("flags interleaved when text appears after a toolCall", () => {
    const shape = computeShape([
      { type: "text", text: "before" },
      { type: "toolCall", name: "bash", id: "t1" },
      { type: "text", text: "after the tool" },
      { type: "toolCall", name: "read", id: "t2" },
    ]);
    expect(shape.interleaved).toBe(true);
    expect(shape.textParts).toBe(2);
    expect(shape.toolCallParts).toBe(2);
    expect(shape.firstToolCallIndex).toBe(1);
    expect(shape.postToolTextChars).toBe("after the tool".length);
    expect(shape.shape).toBe("text(6),toolCall(bash),text(14),toolCall(read)");
  });

  test("does not flag interleaved when all text precedes all toolCalls", () => {
    const shape = computeShape([
      { type: "text", text: "prose 1" },
      { type: "text", text: "prose 2" },
      { type: "text", text: "prose 3" },
      { type: "toolCall", name: "bash", id: "t1" },
      { type: "toolCall", name: "read", id: "t2" },
      { type: "toolCall", name: "read", id: "t3" },
    ]);
    expect(shape.interleaved).toBe(false);
    expect(shape.textParts).toBe(3);
    expect(shape.toolCallParts).toBe(3);
    expect(shape.firstToolCallIndex).toBe(3);
    expect(shape.postToolTextChars).toBe(0);
  });

  test("ignores whitespace-only text when deciding interleaved", () => {
    const shape = computeShape([
      { type: "toolCall", name: "bash", id: "t1" },
      { type: "text", text: "   \n  " },
    ]);
    expect(shape.interleaved).toBe(false);
    // Whitespace still counts toward postToolTextChars (raw length).
    expect(shape.postToolTextChars).toBe(6);
  });

  test("treats thinking-after-tool the same way as text-after-tool", () => {
    const shape = computeShape([
      { type: "toolCall", name: "bash", id: "t1" },
      { type: "thinking", thinking: "reflecting on result" },
    ]);
    expect(shape.interleaved).toBe(true);
    expect(shape.thinkingParts).toBe(1);
  });

  test("returns zeros for empty content", () => {
    const shape = computeShape([]);
    expect(shape).toEqual({
      ts: shape.ts,
      interleaved: false,
      partCount: 0,
      textParts: 0,
      thinkingParts: 0,
      toolCallParts: 0,
      firstToolCallIndex: -1,
      postToolTextChars: 0,
      shape: "",
    });
  });

  test("labels unknown content types without throwing", () => {
    const shape = computeShape([{ type: "image" }]);
    expect(shape.shape).toBe("?(image)");
  });
});

describe("messageShapeDiagnosticExtension wiring", () => {
  const originalFlag = process.env[ENV_FLAG];
  const originalPath = process.env[ENV_PATH];
  let tmpDir: string | undefined;

  beforeEach(() => {
    delete process.env[ENV_FLAG];
    delete process.env[ENV_PATH];
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = originalFlag;
    if (originalPath === undefined) delete process.env[ENV_PATH];
    else process.env[ENV_PATH] = originalPath;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  test("no-ops when the env flag is unset", async () => {
    const host = createExtensionHost();
    messageShapeDiagnosticExtension(host.api as any);
    expect(host.handlers.get("message_end") ?? []).toHaveLength(0);

    // Even if a message_end fires, nothing crashes and nothing is written.
    await host.emit("message_end", {
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
  });

  test("writes one JSONL record per assistant message_end when enabled", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-shape-diag-"));
    const logPath = join(tmpDir, "shapes.jsonl");
    process.env[ENV_FLAG] = "1";
    process.env[ENV_PATH] = logPath;

    const host = createExtensionHost();
    messageShapeDiagnosticExtension(host.api as any);

    await host.emit("message_end", {
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "prose" },
          { type: "toolCall", name: "bash", id: "t1" },
          { type: "text", text: "after" },
        ],
      },
    });
    await host.emit("message_end", {
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "no tools here" }],
      },
    });

    const raw = readFileSync(logPath, "utf8").trim();
    const lines = raw.split("\n");
    // First line is the diag_enabled marker, then two real records.
    expect(lines).toHaveLength(3);
    const markerLine = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(markerLine.event).toBe("diag_enabled");

    const record1 = JSON.parse(lines[1]) as ShapeRecord;
    expect(record1.interleaved).toBe(true);
    expect(record1.stopReason).toBe("toolUse");
    expect(record1.shape).toBe("text(5),toolCall(bash),text(5)");

    const record2 = JSON.parse(lines[2]) as ShapeRecord;
    expect(record2.interleaved).toBe(false);
    expect(record2.toolCallParts).toBe(0);
    expect(record2.stopReason).toBe("stop");
  });

  test("ignores non-assistant message_end events", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-shape-diag-"));
    const logPath = join(tmpDir, "shapes.jsonl");
    process.env[ENV_FLAG] = "1";
    process.env[ENV_PATH] = logPath;

    const host = createExtensionHost();
    messageShapeDiagnosticExtension(host.api as any);

    await host.emit("message_end", {
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    await host.emit("message_end", {
      message: { role: "toolResult", content: [{ type: "text", text: "result" }] },
    });

    const raw = readFileSync(logPath, "utf8").trim();
    const lines = raw.split("\n");
    // Only the diag_enabled marker should be present — no real shape records.
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).event).toBe("diag_enabled");
  });

  test("supports relative paths resolved against cwd", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-shape-diag-"));
    process.env[ENV_FLAG] = "1";
    process.env[ENV_PATH] = "logs/shapes.jsonl";

    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const host = createExtensionHost();
      messageShapeDiagnosticExtension(host.api as any);
      await host.emit("message_end", {
        message: { role: "assistant", content: [{ type: "text", text: "x" }] },
      });
      const raw = readFileSync(join(tmpDir, "logs", "shapes.jsonl"), "utf8").trim();
      expect(raw.split("\n").length).toBeGreaterThanOrEqual(2);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
