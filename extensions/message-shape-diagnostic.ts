import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Diagnostic-only extension. When enabled via the env flag, every
 * `message_end` for an assistant message gets one JSONL line written to a
 * log file, capturing the *shape* of `message.content`. This lets us answer:
 *
 *   "Does the model actually emit `[text, toolCall, text, toolCall]` (which
 *    pi would flatten into `text+text, toolCall, toolCall` and look like a
 *    rendering bug), or does it emit `[text*N, toolCall*M]` (in which case
 *    pi's rendering is faithful and the awkwardness is a prompt problem)?"
 *
 * Enabling:
 *   PI_BASIC_TOOLS_DIAG_SHAPES=1 pi
 *
 * Output goes to `.pi/diagnostics/message-shapes.jsonl` under the project
 * cwd by default; override with `PI_BASIC_TOOLS_DIAG_SHAPES_PATH=/abs/path`.
 *
 * Each line looks like:
 *   {"ts":"2026-05-18T14:23:01.000Z","interleaved":false,"partCount":6,
 *    "textParts":3,"thinkingParts":0,"toolCallParts":3,
 *    "firstToolCallIndex":3,"postToolTextChars":0,
 *    "shape":"text(120),text(85),text(140),toolCall(bash),toolCall(read),toolCall(read)",
 *    "stopReason":"toolUse"}
 *
 * The signal we care about is `interleaved`. If runs of real sessions never
 * produce `interleaved:true`, the perceived ordering issue is a prompt /
 * model-emission concern, not a pi rendering bug — and the patch idea can be
 * dropped in favor of prompt tweaks.
 */

const ENV_FLAG = "PI_BASIC_TOOLS_DIAG_SHAPES";
const ENV_PATH = "PI_BASIC_TOOLS_DIAG_SHAPES_PATH";

export interface ShapeRecord {
  ts: string;
  interleaved: boolean;
  partCount: number;
  textParts: number;
  thinkingParts: number;
  toolCallParts: number;
  firstToolCallIndex: number;
  postToolTextChars: number;
  shape: string;
  stopReason?: string;
}

/** Pure helper, exported for tests. */
export function computeShape(content: readonly any[]): ShapeRecord {
  const parts: string[] = [];
  let textParts = 0;
  let thinkingParts = 0;
  let toolCallParts = 0;
  let firstToolCallIndex = -1;
  let postToolTextChars = 0;
  let interleaved = false;
  let sawToolCall = false;

  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    const type = part?.type;
    if (type === "text") {
      const text = typeof part.text === "string" ? part.text : "";
      parts.push(`text(${text.length})`);
      textParts++;
      if (sawToolCall) {
        if (text.trim().length > 0) interleaved = true;
        postToolTextChars += text.length;
      }
    } else if (type === "thinking") {
      const thinking = typeof part.thinking === "string" ? part.thinking : "";
      parts.push(`thinking(${thinking.length})`);
      thinkingParts++;
      if (sawToolCall) {
        if (thinking.trim().length > 0) interleaved = true;
        postToolTextChars += thinking.length;
      }
    } else if (type === "toolCall") {
      const name = typeof part.name === "string" ? part.name : "?";
      parts.push(`toolCall(${name})`);
      toolCallParts++;
      if (firstToolCallIndex < 0) firstToolCallIndex = i;
      sawToolCall = true;
    } else {
      parts.push(`?(${typeof type === "string" ? type : "unknown"})`);
    }
  }

  return {
    ts: new Date().toISOString(),
    interleaved,
    partCount: content.length,
    textParts,
    thinkingParts,
    toolCallParts,
    firstToolCallIndex,
    postToolTextChars,
    shape: parts.join(","),
  };
}

function resolveLogPath(cwd: string): string {
  const override = process.env[ENV_PATH];
  if (override && override.length > 0) {
    return isAbsolute(override) ? override : join(cwd, override);
  }
  return join(cwd, ".pi", "diagnostics", "message-shapes.jsonl");
}

export default function messageShapeDiagnosticExtension(pi: ExtensionAPI): void {
  if (!process.env[ENV_FLAG]) return;

  let warnedOnce = false;
  const cwd = process.cwd();
  const logPath = resolveLogPath(cwd);
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    // Best-effort. If the directory cannot be created, the first append will
    // fail loudly and we surface a single console warning.
  }
  // Tag the log so the user can confirm the diagnostic took effect.
  try {
    appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), event: "diag_enabled", cwd }) + "\n");
  } catch {
    // Ignored — handler below will warn on first real write failure.
  }

  pi.on("message_end" as any, (event: any) => {
    const message = event?.message;
    if (!message || message.role !== "assistant") return;
    const content = Array.isArray(message.content) ? message.content : [];
    if (content.length === 0) return;
    const record: ShapeRecord = computeShape(content);
    if (typeof message.stopReason === "string") record.stopReason = message.stopReason;
    try {
      appendFileSync(logPath, JSON.stringify(record) + "\n");
    } catch (error) {
      if (!warnedOnce) {
        warnedOnce = true;
        const msg = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.warn(`[pi-basic-tools] message-shape-diagnostic failed to write ${logPath}: ${msg}`);
      }
    }
  });
}
