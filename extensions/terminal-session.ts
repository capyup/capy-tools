import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { canGroupTool, renderGroupedToolCall, renderGroupedToolResult, summarizeToolCall } from "./basic-tool-grouping.ts";

const DEFAULT_YIELD_TIME_MS = 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 12_000;
const MAX_BUFFER_BYTES = 512_000;
const CTRL_C = "\u0003";

const execCommandSchema = Type.Object({
  cmd: Type.String({ description: "Shell command to start in a persistent terminal session" }),
  workdir: Type.Optional(Type.String({ description: "Working directory; defaults to the current project directory" })),
  tty: Type.Optional(Type.Boolean({ description: "Reserved for future PTY support. Current implementation runs without a PTY." })),
  yield_time_ms: Type.Optional(Type.Number({ description: "Milliseconds to wait for initial output before returning" })),
  max_output_bytes: Type.Optional(Type.Number({ description: "Maximum bytes of command output to return" })),
});

const writeStdinSchema = Type.Object({
  session_id: Type.Number({ description: "Session id returned by exec_command" }),
  chars: Type.Optional(Type.String({ description: "Text to write to stdin. Empty string polls new output; \\u0003 sends SIGINT." })),
  yield_time_ms: Type.Optional(Type.Number({ description: "Milliseconds to wait for output after writing" })),
  max_output_bytes: Type.Optional(Type.Number({ description: "Maximum bytes of session output to return" })),
});

type SessionStatus = "running" | "exited";

type TerminalSession = {
  id: number;
  command: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  status: SessionStatus;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  output: string;
  readOffset: number;
  bufferOmittedBytes: number;
  spawnError?: string;
};

type TerminalTombstone = {
  id: number;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  reason: "exited" | "interrupted" | "cleaned";
};

type TerminalDetails = {
  tool: "exec_command" | "write_stdin";
  sessionId?: number;
  command?: string;
  cwd?: string;
  status: SessionStatus | "error";
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  durationMs: number;
  output: string;
  outputBytes: number;
  lineCount: number;
  truncated: boolean;
  omittedBytes: number;
  bufferTruncated?: boolean;
  bufferOmittedBytes?: number;
  wroteBytes?: number;
  action?: "poll" | "write" | "interrupt";
  error?: string;
};

const sessions = new Map<number, TerminalSession>();
const tombstones = new Map<number, TerminalTombstone>();
let nextSessionId = 1;
const MAX_TOMBSTONES = 100;

function safeKeyHint(keybinding: string, description: string): string {
  try {
    return keyHint(keybinding, description);
  } catch {
    return `(${description})`;
  }
}

function fallbackText(result: any): string {
  const content = result.content?.[0];
  return content?.type === "text" ? content.text : "";
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").filter((line) => line.length > 0).length;
}

function truncateOutput(output: string, maxBytes: number) {
  const bytes = byteLength(output);
  if (bytes <= maxBytes) {
    return { output, bytes, truncated: false, omittedBytes: 0 };
  }

  const notice = "[... truncated ...]\n";
  const available = Math.max(0, maxBytes - byteLength(notice));
  const tail = Buffer.from(output, "utf8").subarray(bytes - available).toString("utf8");
  return {
    output: `${notice}${tail}`,
    bytes,
    truncated: true,
    omittedBytes: bytes - byteLength(tail),
  };
}

function trimSessionBuffer(session: TerminalSession): void {
  const bytes = byteLength(session.output);
  if (bytes <= MAX_BUFFER_BYTES) return;

  const before = session.output;
  const buffer = Buffer.from(before, "utf8");
  session.output = buffer.subarray(bytes - MAX_BUFFER_BYTES).toString("utf8");
  const droppedChars = before.length - session.output.length;
  const droppedBytes = bytes - byteLength(session.output);
  session.readOffset = Math.max(0, session.readOffset - droppedChars);
  session.bufferOmittedBytes += droppedBytes;
}

function appendOutput(session: TerminalSession, chunk: Buffer | string): void {
  session.output += chunk.toString();
  trimSessionBuffer(session);
}

function signalSession(session: TerminalSession, signal: NodeJS.Signals): void {
  if (session.status !== "running") return;
  if (process.platform !== "win32" && session.child.pid) {
    try {
      process.kill(-session.child.pid, signal);
      return;
    } catch {
      // Fall back to signaling the shell process when process-group signaling is unavailable.
    }
  }
  session.child.kill(signal);
}

function waitForOutputOrExit(session: TerminalSession, waitMs: number): Promise<void> {
  if (waitMs <= 0 || session.status !== "running") return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(done, waitMs);
    function done() {
      clearTimeout(timer);
      session.child.off("close", done);
      resolve();
    }
    session.child.once("close", done);
  });
}

function waitForExitOrAbort(session: TerminalSession, waitMs: number, signal?: AbortSignal): Promise<"exited" | "aborted" | "timeout"> {
  if (session.status !== "running") return Promise.resolve("exited");
  if (signal?.aborted) return Promise.resolve("aborted");

  return new Promise((resolve) => {
    const timer = setTimeout(() => done("timeout"), waitMs);
    function done(result: "exited" | "aborted" | "timeout") {
      clearTimeout(timer);
      session.child.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    }
    function onClose() {
      done("exited");
    }
    function onAbort() {
      done("aborted");
    }
    session.child.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function terminateAbortedSession(session: TerminalSession): Promise<void> {
  signalSession(session, "SIGTERM");
  await waitForOutputOrExit(session, 250);
  if (session.status === "running") {
    signalSession(session, "SIGKILL");
    await waitForOutputOrExit(session, 1000);
  }
}

function unreadOutput(session: TerminalSession): string {
  const output = session.output.slice(session.readOffset);
  session.readOffset = session.output.length;
  return output;
}

function buildText(details: TerminalDetails): string {
  const lines = [
    `${details.tool} result`,
    `status: ${details.status}`,
  ];
  if (details.sessionId !== undefined) lines.push(`session_id: ${details.sessionId}`);
  if (details.exitCode !== undefined) lines.push(`exit_code: ${details.exitCode}`);
  if (details.signal) lines.push(`signal: ${details.signal}`);
  if (details.command) lines.push(`command: ${details.command}`);
  if (details.cwd) lines.push(`cwd: ${details.cwd}`);
  if (details.action) lines.push(`action: ${details.action}`);
  if (details.wroteBytes !== undefined) lines.push(`wrote_bytes: ${details.wroteBytes}`);
  lines.push(`duration_ms: ${details.durationMs}`);
  lines.push(`output_bytes: ${details.outputBytes}`);
  lines.push(`output_truncated: ${details.truncated}`);
  if (details.truncated) lines.push(`omitted_bytes: ${details.omittedBytes}`);
  if (details.bufferTruncated) lines.push(`buffer_omitted_bytes: ${details.bufferOmittedBytes ?? 0}`);
  if (details.error) lines.push(`error: ${details.error}`);
  lines.push("output:");
  lines.push(details.output);
  return lines.join("\n");
}

function resultFromDetails(details: TerminalDetails) {
  return {
    content: [{ type: "text" as const, text: buildText(details) }],
    details,
  };
}

function detailsForSession(tool: "exec_command" | "write_stdin", session: TerminalSession, output: string, maxOutputBytes: number, startedAt: number, extra: Partial<TerminalDetails> = {}): TerminalDetails {
  const truncated = truncateOutput(output, maxOutputBytes);
  return {
    tool,
    sessionId: session.id,
    command: session.command,
    cwd: session.cwd,
    status: session.status,
    exitCode: session.status === "exited" ? session.exitCode : undefined,
    signal: session.status === "exited" ? session.signal : undefined,
    durationMs: Date.now() - startedAt,
    output: truncated.output,
    outputBytes: truncated.bytes,
    lineCount: lineCount(truncated.output),
    truncated: truncated.truncated,
    omittedBytes: truncated.omittedBytes,
    bufferTruncated: session.bufferOmittedBytes > 0,
    bufferOmittedBytes: session.bufferOmittedBytes,
    error: session.spawnError,
    ...extra,
  };
}

function addTombstone(session: TerminalSession, reason: TerminalTombstone["reason"] = "exited"): void {
  tombstones.set(session.id, {
    id: session.id,
    command: session.command,
    cwd: session.cwd,
    startedAt: session.startedAt,
    endedAt: Date.now(),
    exitCode: session.exitCode,
    signal: session.signal,
    reason,
  });
  while (tombstones.size > MAX_TOMBSTONES) {
    const oldest = tombstones.keys().next().value;
    if (oldest === undefined) break;
    tombstones.delete(oldest);
  }
}

function detailsForTombstone(tool: "write_stdin", tombstone: TerminalTombstone, startedAt: number, action: "poll" | "write" | "interrupt"): TerminalDetails {
  return {
    tool,
    sessionId: tombstone.id,
    command: tombstone.command,
    cwd: tombstone.cwd,
    status: "exited",
    exitCode: tombstone.exitCode,
    signal: tombstone.signal,
    durationMs: Date.now() - startedAt,
    output: "",
    outputBytes: 0,
    lineCount: 0,
    truncated: false,
    omittedBytes: 0,
    action,
    error: `terminal session ${tombstone.id} already ${tombstone.reason}`,
  };
}

function summarizeCommand(command: unknown, maxLength = 96): string {
  const text = String(command ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function renderExecCall(args: any, theme: any) {
  const command = summarizeCommand(args?.cmd);
  if (!command) return new Container();
  return new Text(theme.fg("success", "exec command ") + theme.fg("accent", command), 0, 0);
}

function commandForSessionId(sessionId: unknown): string | undefined {
  const id = Number(sessionId);
  if (!Number.isFinite(id)) return undefined;
  return sessions.get(id)?.command ?? tombstones.get(id)?.command;
}

function renderWriteStdinCall(args: any, theme: any) {
  const sessionId = args?.session_id;
  if (sessionId === undefined) return new Container();
  const action = args?.chars === "\u0003" ? "interrupt" : args?.chars ? "write" : "poll";
  const command = commandForSessionId(sessionId);
  const suffix = command ? `: ${summarizeCommand(command)}` : "";
  return new Text(theme.fg("success", "write stdin ") + theme.fg("accent", `#${sessionId} ${action}${suffix}`), 0, 0);
}

function renderTerminalResult(label: string, result: any, { expanded, isPartial }: { expanded?: boolean; isPartial?: boolean }, theme: any, args?: any) {
  if (isPartial) {
    const command = label === "write stdin" ? commandForSessionId(args?.session_id) : args?.cmd;
    const suffix = command ? `: ${summarizeCommand(command)}` : "";
    return new Text(theme.fg("warning", `${label}${suffix}...`), 0, 0);
  }

  const details = result.details as TerminalDetails | undefined;
  const fullText = fallbackText(result);
  if (!details || expanded) return new Text(fullText, 0, 0);

  const hint = safeKeyHint("app.tools.expand", "to expand");
  const session = details.sessionId !== undefined ? `#${details.sessionId} ` : "";
  const action = details.action ? `${details.action} ` : "";
  const status = details.status === "running" ? "running" : details.status === "exited" ? `exited ${details.exitCode ?? details.signal ?? "signal"}` : "error";
  const output = details.lineCount === 0 ? "no output" : `${details.lineCount} ${details.lineCount === 1 ? "line" : "lines"}`;
  const command = details.command ? `: ${summarizeCommand(details.command)}` : "";
  const truncation = details.truncated ? " truncated" : "";
  const summary = `${session}${action}${status}${command} · ${output}`;
  return new Text(theme.fg(details.status === "error" ? "error" : "success", `${label} `) + theme.fg("accent", summary) + theme.fg("dim", `${truncation} ${hint}`), 0, 0);
}

async function ensureWorkdir(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error("path is not a directory");
}

function registerSession(session: TerminalSession): void {
  sessions.set(session.id, session);
  session.child.stdout.on("data", (chunk) => appendOutput(session, chunk));
  session.child.stderr.on("data", (chunk) => appendOutput(session, chunk));
  session.child.on("close", (code, signal) => {
    session.status = "exited";
    session.exitCode = code;
    session.signal = signal;
  });
  session.child.on("error", (error) => {
    session.spawnError = error.message;
    session.status = "exited";
    session.exitCode = 127;
  });
}

export default function terminalSessionExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "exec_command",
    label: "exec_command",
    description: "Start a persistent shell command session. Returns recent output plus either exit_code or session_id when the process is still running.",
    promptSnippet: "Start a persistent terminal session for long-running or interactive commands",
    promptGuidelines: [
      "Use exec_command for long-running or interactive commands that need later polling or stdin input.",
      "Prefer bash for ordinary one-shot commands that should simply finish and return output.",
      "Do not use exec_command for destructive, privileged, or sensitive commands unless the user explicitly asked for that workflow.",
      "Use write_stdin with empty chars to poll new output, and chars='\\u0003' to send SIGINT when cleanup is needed.",
    ],
    parameters: execCommandSchema,
    renderShell: "self",
    renderCall(args, theme, context) {
      if (!canGroupTool(context)) return renderExecCall(args, theme);
      return renderGroupedToolCall("exec_command", args, theme, context, summarizeToolCall("exec_command", args));
    },
    renderResult(result, options, theme, context) {
      if (!canGroupTool(context)) return renderTerminalResult("exec command", result, options, theme, context?.args);
      return renderGroupedToolResult("exec_command", result, options, theme, context);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const startedAt = Date.now();
      const command = String(params.cmd ?? "").trim();
      if (!command) throw new Error("cmd must not be empty");
      if (params.tty) throw new Error("tty mode is not supported yet; omit tty or set it to false");

      const cwd = params.workdir ?? ctx.cwd ?? process.cwd();
      const maxOutputBytes = clampNumber(params.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES, 1, 200_000);
      const yieldTimeMs = clampNumber(params.yield_time_ms, DEFAULT_YIELD_TIME_MS, 0, 60_000);

      try {
        await ensureWorkdir(cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return resultFromDetails({
          tool: "exec_command",
          command,
          cwd,
          status: "error",
          durationMs: Date.now() - startedAt,
          output: "",
          outputBytes: 0,
          lineCount: 0,
          truncated: false,
          omittedBytes: 0,
          error: `invalid workdir: ${message}`,
        });
      }

      if (signal?.aborted) {
        return resultFromDetails({
          tool: "exec_command",
          command,
          cwd,
          status: "error",
          durationMs: Date.now() - startedAt,
          output: "",
          outputBytes: 0,
          lineCount: 0,
          truncated: false,
          omittedBytes: 0,
          error: "command was cancelled before it started",
        });
      }

      const session: TerminalSession = {
        id: nextSessionId++,
        command,
        cwd,
        child: spawn(command, { cwd, env: process.env, shell: true, stdio: "pipe", detached: process.platform !== "win32" }),
        startedAt,
        status: "running",
        output: "",
        readOffset: 0,
        bufferOmittedBytes: 0,
      };
      registerSession(session);

      const waitResult = await waitForExitOrAbort(session, yieldTimeMs, signal);
      if (waitResult === "aborted") {
        await terminateAbortedSession(session);
        const output = unreadOutput(session);
        sessions.delete(session.id);
        addTombstone(session, "cleaned");
        return resultFromDetails(detailsForSession("exec_command", session, output, maxOutputBytes, startedAt, {
          sessionId: undefined,
          status: session.status === "running" ? "error" : session.status,
          error: session.status === "running" ? "command was cancelled but did not exit after SIGTERM/SIGKILL" : "command was cancelled and terminated",
        }));
      }

      const output = unreadOutput(session);
      if (session.status === "running") {
        return resultFromDetails(detailsForSession("exec_command", session, output, maxOutputBytes, startedAt));
      }

      sessions.delete(session.id);
      return resultFromDetails(detailsForSession("exec_command", session, output, maxOutputBytes, startedAt, { sessionId: undefined }));
    },
  });

  pi.registerTool({
    name: "write_stdin",
    label: "write_stdin",
    description: "Write to, poll, or interrupt a persistent terminal session created by exec_command.",
    promptSnippet: "Send stdin to a persistent terminal session or poll its latest output",
    promptGuidelines: [
      "Use write_stdin only with a session_id returned by exec_command.",
      "Pass an empty chars string to poll new output without writing input.",
      "Pass chars='\\u0003' to send SIGINT and clean up a running session.",
    ],
    parameters: writeStdinSchema,
    renderShell: "self",
    renderCall(args, theme, context) {
      if (!canGroupTool(context)) return renderWriteStdinCall(args, theme);
      return renderGroupedToolCall("write_stdin", args, theme, context, summarizeToolCall("write_stdin", args));
    },
    renderResult(result, options, theme, context) {
      if (!canGroupTool(context)) return renderTerminalResult("write stdin", result, options, theme, context?.args);
      return renderGroupedToolResult("write_stdin", result, options, theme, context);
    },
    async execute(_toolCallId, params) {
      const startedAt = Date.now();
      const sessionId = Number(params.session_id);
      const session = sessions.get(sessionId);
      const chars = params.chars ?? "";
      if (!session) {
        const tombstone = tombstones.get(sessionId);
        if (tombstone && chars.length === 0) {
          return resultFromDetails(detailsForTombstone("write_stdin", tombstone, startedAt, "poll"));
        }
        if (tombstone) throw new Error(`terminal session ${sessionId} already ${tombstone.reason}`);
        throw new Error(`terminal session ${sessionId} was never created or its terminal state has expired`);
      }


      const maxOutputBytes = clampNumber(params.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES, 1, 200_000);
      const yieldTimeMs = clampNumber(params.yield_time_ms, DEFAULT_YIELD_TIME_MS, 0, 60_000);
      let action: "poll" | "write" | "interrupt" = chars.length === 0 ? "poll" : "write";
      let wroteBytes = 0;

      if (session.status !== "running" && chars.length > 0) {
        throw new Error(`terminal session ${sessionId} already exited with code ${session.exitCode ?? "null"}${session.signal ? ` and signal ${session.signal}` : ""}`);
      }

      if (session.status === "running" && chars.length > 0) {
        if (chars === CTRL_C) {
          action = "interrupt";
          signalSession(session, "SIGINT");
        } else {
          wroteBytes = byteLength(chars);
          session.child.stdin.write(chars);
        }
      }

      await waitForOutputOrExit(session, yieldTimeMs);
      const output = unreadOutput(session);
      const details = detailsForSession("write_stdin", session, output, maxOutputBytes, startedAt, { action, wroteBytes });
      if (session.status === "exited") {
        addTombstone(session, action === "interrupt" ? "interrupted" : "exited");
        sessions.delete(session.id);
      }
      return resultFromDetails(details);
    },
  });
}
