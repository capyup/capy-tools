import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { retainThinkingStepsPatch } from "./internal-patch.ts";
import { clearThinkingMergeRegistry } from "./render.ts";
import {
  clearActiveThinkingState,
  clearThinkingMessageOwnership,
  getCurrentThinkingScopeKey,
  recordThinkingMessageScope,
  registerThinkingPatchRelease,
  resolveThinkingMessageScope,
  setActiveThinkingState,
  setCurrentThinkingScopeKey,
  setThinkingStepsMode,
  takeThinkingPatchRelease,
} from "./state.ts";

// pi-basic-tools fork of pi-thinking-steps (MIT, fluxgear).
//
// This extension is intentionally invisible to the user.  It exposes no
// slash command, no shortcut, no status bar entry, and no persistence file.
// On session start it installs Pi's `AssistantMessageComponent` patch and
// locks the renderer to `summary` so chain-of-thought blocks render in the
// same Codex-style `\u2022 \u2026 \u2502 \u2026 \u2514` shape as the rest of pi-basic-tools.
// On session shutdown the patch is released so Pi's native renderer comes
// back if the extension is unloaded.

const RENDER_MODE = "summary" as const;

function reportPatchError(ctx: ExtensionContext, error: unknown): void {
  // We do not surface patch failures through the UI because the user is
  // not expected to know this extension exists.  Pi's native thinking
  // renderer will be used instead and the failure is recorded to stderr
  // for maintainers.
  const message = error instanceof Error ? error.message : String(error);
  void ctx;
  console.warn(`pi-basic-tools thinking-steps: patch unavailable, falling back to Pi's native renderer (${message})`);
}

export default function thinkingStepsExtension(pi: ExtensionAPI): void {
  let sessionScopeKey = getCurrentThinkingScopeKey();
  const setSessionScopeKey = (scopeKey: string): string => {
    sessionScopeKey = scopeKey;
    setCurrentThinkingScopeKey(scopeKey);
    return sessionScopeKey;
  };

  pi.on("session_start", async (_event, ctx) => {
    const activeScopeKey = setSessionScopeKey(ctx.cwd);
    clearActiveThinkingState(undefined, activeScopeKey);
    try {
      registerThinkingPatchRelease(activeScopeKey, await retainThinkingStepsPatch());
    } catch (error) {
      reportPatchError(ctx, error);
      return;
    }

    // Lock the renderer to summary mode every session.  Persistence and
    // scope-keyed mode switching from upstream are intentionally bypassed.
    setThinkingStepsMode(RENDER_MODE, activeScopeKey);
  });

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    recordThinkingMessageScope(event.message, sessionScopeKey);
    const ownerScopeKey = resolveThinkingMessageScope(event.message, sessionScopeKey);
    const timestamp = typeof (event.message as { timestamp?: unknown }).timestamp === "number"
      ? (event.message as { timestamp: number }).timestamp
      : undefined;
    clearActiveThinkingState(timestamp, ownerScopeKey);
    if (timestamp !== undefined) clearThinkingMergeRegistry(ownerScopeKey, timestamp);
  });

  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant") return;
    recordThinkingMessageScope(event.message, sessionScopeKey);
    const ownerScopeKey = resolveThinkingMessageScope(event.message, sessionScopeKey);
    const assistantEvent = event.assistantMessageEvent;
    if (assistantEvent.type === "thinking_start" || assistantEvent.type === "thinking_delta") {
      setActiveThinkingState(
        {
          active: true,
          messageTimestamp: event.message.timestamp,
          contentIndex: assistantEvent.contentIndex,
        },
        ownerScopeKey,
      );
      return;
    }

    if (
      assistantEvent.type === "thinking_end"
      || assistantEvent.type === "text_start"
      || assistantEvent.type === "text_delta"
      || assistantEvent.type === "text_end"
      || assistantEvent.type === "toolcall_start"
      || assistantEvent.type === "toolcall_delta"
      || assistantEvent.type === "toolcall_end"
    ) {
      clearActiveThinkingState(event.message.timestamp, ownerScopeKey);
    }
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    recordThinkingMessageScope(event.message, sessionScopeKey);
    const ownerScopeKey = resolveThinkingMessageScope(event.message, sessionScopeKey);
    const timestamp = typeof (event.message as { timestamp?: unknown }).timestamp === "number"
      ? (event.message as { timestamp: number }).timestamp
      : undefined;
    clearActiveThinkingState(timestamp, ownerScopeKey);
  });

  pi.on("agent_end", async () => {
    clearActiveThinkingState(undefined, sessionScopeKey);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const activeScopeKey = setSessionScopeKey(ctx.cwd);
    clearActiveThinkingState(undefined, activeScopeKey);
    clearThinkingMessageOwnership(activeScopeKey);
    clearThinkingMergeRegistry(activeScopeKey);

    const releasePatch = takeThinkingPatchRelease(activeScopeKey);
    if (!releasePatch) return;
    try {
      await releasePatch();
    } catch (error) {
      registerThinkingPatchRelease(activeScopeKey, releasePatch);
      reportPatchError(ctx, error);
    }
  });
}
