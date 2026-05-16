import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { deriveThinkingSteps } from "./parse.ts";
import { getActiveThinkingState, getCurrentThinkingScopeKey, getThinkingStepsMode } from "./state.ts";
import { ROLE_GLYPHS, ROLE_COLORS, treeConnector, type VisualRole } from "../shared/visual.ts";
import type { DerivedThinkingStep, ThinkingSemanticRole, ThinkingSourceBlock, ThinkingThemeLike } from "./types.ts";

interface RenderOptions {
  mode: "collapsed" | "summary" | "expanded";
  steps: DerivedThinkingStep[];
  activeStepId?: string;
  isActive: boolean;
  nowMs?: number;
}

const MAX_SUMMARY_STEPS = 5;

// ---------- role glyphs & colors (upstream palette) ------------------------

function thinkingRoleAsVisual(role: ThinkingSemanticRole): VisualRole {
  switch (role) {
    case "inspect":
    case "search":
    case "compare":
    case "write":
    case "plan":
    case "verify":
      return role;
    case "error":
      return "default";
    default:
      return "default";
  }
}

function roleGlyph(role: ThinkingSemanticRole): string {
  if (role === "error") return "!";
  return ROLE_GLYPHS[thinkingRoleAsVisual(role)] ?? ROLE_GLYPHS.default;
}

function roleColor(role: ThinkingSemanticRole): string {
  if (role === "error") return "error";
  return ROLE_COLORS[thinkingRoleAsVisual(role)] ?? ROLE_COLORS.default;
}

function pulseGlyph(theme: ThinkingThemeLike, nowMs: number): string {
  const frames = [
    theme.fg("dim", "·"),
    theme.fg("muted", "•"),
    theme.fg("accent", "•"),
    theme.fg("muted", "•"),
  ];
  const frame = Math.floor(nowMs / 180) % frames.length;
  return frames[frame] ?? frames[0]!;
}

// ---------- inline markdown rendering --------------------------------------

type InlineSegmentStyle = "plain" | "bold" | "code";
interface InlineSegment { text: string; style: InlineSegmentStyle }

function sanitizeThinkingText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\]PX^_][\s\S]*?(?:|\\|)/g, "")
    .replace(/[][\s\S]*?(?:|\\|)/g, "")
    .replace(/(?:\[[0-?]*[ -/]*[@-~]|[ -/]*[0-9@-~])/g, "")
    .replace(/[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
}

function parseInlineSegments(text: string): InlineSegment[] {
  const sanitized = sanitizeThinkingText(text);
  const segments: InlineSegment[] = [];
  const markerRe =
    /(\*\*|__)(?=\S)([\s\S]*?\S)\1|`([^`]+)`|(?<![\w/.-])\*(?!\*)(?=\S)([\s\S]*?\S)(?<!\*)\*(?![\w/.-])|(?<![\w/.-])_(?!_)(?=\S)([\s\S]*?\S)(?<!_)_(?![\w/.-])/g;
  let lastIndex = 0;
  for (const match of sanitized.matchAll(markerRe)) {
    const start = match.index ?? 0;
    if (start > lastIndex) segments.push({ text: sanitized.slice(lastIndex, start), style: "plain" });
    if (match[2]) segments.push({ text: match[2], style: "bold" });
    if (match[3]) segments.push({ text: match[3], style: "code" });
    if (match[4]) segments.push({ text: match[4], style: "plain" });
    if (match[5]) segments.push({ text: match[5], style: "plain" });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < sanitized.length) segments.push({ text: sanitized.slice(lastIndex), style: "plain" });
  return segments;
}

function renderInlineSegment(theme: ThinkingThemeLike, segment: InlineSegment, textColor: string): string {
  if (segment.style === "bold") return theme.bold(theme.fg(textColor, segment.text));
  if (segment.style === "code") return theme.bold(theme.fg("mdCode", segment.text));
  return theme.fg(textColor, segment.text);
}

function renderInline(theme: ThinkingThemeLike, text: string, textColor: string): string {
  const sanitized = sanitizeThinkingText(text);
  const segments = parseInlineSegments(sanitized);
  if (segments.length === 0) return theme.fg(textColor, sanitized);
  return segments.map((segment) => renderInlineSegment(theme, segment, textColor)).join("");
}

function renderThinkingInlineMarkup(theme: ThinkingThemeLike, text: string): string {
  return renderInline(theme, text, "thinkingText");
}

function renderThinkingDisplayLine(theme: ThinkingThemeLike, text: string): string {
  const headingMatch = text.match(/^(\s{0,3})#{1,6}\s+(.+)$/);
  if (headingMatch) {
    const indent = headingMatch[1] ?? "";
    const content = headingMatch[2] ?? "";
    return `${indent}${theme.bold(theme.fg("accent", renderThinkingInlineMarkup(theme, content)))}`;
  }

  const listMatch = text.match(/^(\s*)([-*+]|\d+[.)]|[a-z][.)])\s+(.+)$/i);
  if (listMatch) {
    const indent = listMatch[1] ?? "";
    const marker = listMatch[2] ?? "";
    const content = listMatch[3] ?? "";
    const renderedMarker = /^[-*+]$/ .test(marker) ? "•" : marker;
    return `${indent}${theme.fg("muted", renderedMarker)} ${renderThinkingInlineMarkup(theme, content)}`;
  }

  return renderThinkingInlineMarkup(theme, text);
}

function renderWrappedRawText(theme: ThinkingThemeLike, text: string, width: number, prefix: string): string[] {
  const innerWidth = Math.max(8, width - visibleWidth(prefix));
  const sanitizedText = sanitizeThinkingText(text);
  const rawLines = sanitizedText.replace(/\t/g, "    ").split("\n");
  const rendered: string[] = [];
  for (const rawLine of rawLines) {
    if (rawLine.trim().length === 0) {
      rendered.push(truncateToWidth(prefix, width, ""));
      continue;
    }
    const styled = renderThinkingDisplayLine(theme, rawLine);
    const wrapped = wrapTextWithAnsi(styled, innerWidth);
    for (const line of wrapped) {
      rendered.push(truncateToWidth(`${prefix}${line}`, width, ""));
    }
  }
  return rendered;
}

// ---------- layout helpers -------------------------------------------------

interface StepStyle {
  summaryColor: string;
  bold: boolean;
}

function stepStyle(step: DerivedThinkingStep, active: boolean): StepStyle {
  if (active) {
    return { summaryColor: "accent", bold: true };
  }
  if (step.hasExplicitFailure) {
    return { summaryColor: "error", bold: false };
  }
  if (step.role === "verify" && step.hasExplicitSuccess) {
    return { summaryColor: "success", bold: false };
  }
  return { summaryColor: roleColor(step.role), bold: false };
}

function wrapStepHeader(
  theme: ThinkingThemeLike,
  width: number,
  step: DerivedThinkingStep,
  active: boolean,
  isLast: boolean,
): string[] {
  const style = stepStyle(step, active);
  const connectorColor = active ? "accent" : "muted";
  const treePrefix = treeConnector(isLast);
  const icon = theme.fg(roleColor(step.role), roleGlyph(step.role));
  const prefix = `${theme.fg(connectorColor, treePrefix)}${icon} `;
  const continuationPrefix = " ".repeat(visibleWidth(`${treePrefix}${roleGlyph(step.role)} `));
  const summaryText = renderInline(theme, step.summary, style.summaryColor);
  const finalSummary = style.bold ? theme.bold(summaryText) : summaryText;
  const innerWidth = Math.max(8, width - visibleWidth(prefix));
  const wrappedSummary = wrapTextWithAnsi(finalSummary, innerWidth);
  if (wrappedSummary.length === 0) {
    return [truncateToWidth(prefix, width, "")];
  }
  return wrappedSummary.map((line, index) =>
    truncateToWidth(`${index === 0 ? prefix : continuationPrefix}${line}`, width, ""),
  );
}

// ---------- collapsed mode -------------------------------------------------

function stripInlineFormattingMarkers(text: string): string {
  return text
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(?<![\w/.-])\*(?!\*)(?=\S)([\s\S]*?\S)(?<!\*)\*(?![\w/.-])/g, "$1")
    .replace(/(?<![\w/.-])_(?!_)(?=\S)([\s\S]*?\S)(?<!_)_(?![\w/.-])/g, "$1");
}

function wrapCollapsedSummaryText(theme: ThinkingThemeLike, text: string, firstWidth: number, continuationWidth: number): string[] {
  const words = parseInlineSegments(text).flatMap((segment) =>
    segment.text
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => {
        if (segment.style === "bold") return theme.bold(theme.fg("thinkingText", word));
        if (segment.style === "code") return theme.bold(theme.fg("mdCode", word));
        return theme.fg("thinkingText", word);
      }),
  );
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";
  let currentWidth = Math.max(8, firstWidth);
  const continuationLineWidth = () => Math.max(8, continuationWidth);

  for (const word of words) {
    let pending = word;
    while (pending.length > 0) {
      const candidate = current ? `${current} ${pending}` : pending;
      if (visibleWidth(candidate) <= currentWidth) {
        current = candidate;
        pending = "";
        continue;
      }

      if (current) {
        lines.push(current);
        current = "";
        currentWidth = continuationLineWidth();
        continue;
      }

      const wrappedWord = wrapTextWithAnsi(pending, currentWidth);
      if (wrappedWord.length === 0) {
        pending = "";
        continue;
      }

      if (wrappedWord.length === 1) {
        current = wrappedWord[0] ?? "";
        pending = "";
        continue;
      }

      lines.push(...wrappedWord.slice(0, -1));
      pending = wrappedWord[wrappedWord.length - 1] ?? "";
      currentWidth = continuationLineWidth();
    }
  }

  if (current) lines.push(current);
  return lines;
}

function renderCollapsed(
  theme: ThinkingThemeLike,
  width: number,
  steps: DerivedThinkingStep[],
  activeStepId: string | undefined,
  isActive: boolean,
  nowMs: number,
): string[] {
  const step = pickCollapsedStep(steps, activeStepId);
  if (!step) return [];

  const label = "Thinking";
  const icon = theme.fg(roleColor(step.role), step.icon);
  const activity = isActive ? pulseGlyph(theme, nowMs) : theme.fg("dim", "·");
  const activitySuffix = ` ${activity}`;
  const activityWidth = visibleWidth(activitySuffix);
  const prefix = `${theme.fg("muted", "│")} ${theme.fg("dim", label)} ${icon} `;
  const continuationPrefix = `${theme.fg("muted", "│")} ${" ".repeat(visibleWidth(`${label} ${step.icon} `))}`;
  const summaryLines = wrapCollapsedSummaryText(
    theme,
    step.summary,
    Math.max(1, width - visibleWidth(prefix) - activityWidth),
    Math.max(1, width - visibleWidth(continuationPrefix) - activityWidth),
  );

  if (summaryLines.length <= 1) {
    return [truncateToWidth(`${prefix}${summaryLines[0] ?? renderThinkingInlineMarkup(theme, step.summary)}${activitySuffix}`, width, "")];
  }

  return summaryLines.map((line, index) => {
    if (index === 0) return truncateToWidth(`${prefix}${line}`, width, "");
    if (index === summaryLines.length - 1) return truncateToWidth(`${continuationPrefix}${line}${activitySuffix}`, width, "");
    return truncateToWidth(`${continuationPrefix}${line}`, width, "");
  });
}

// ---------- step selection -------------------------------------------------

function pickCollapsedStep(steps: DerivedThinkingStep[], activeStepId?: string): DerivedThinkingStep | undefined {
  if (steps.length === 0) return undefined;
  if (activeStepId) {
    const active = steps.find((step) => step.id === activeStepId);
    if (active) return active;
  }

  let latestFailureIndex = -1;
  let latestSuccessAfterFailureIndex = -1;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (step.hasExplicitFailure) {
      latestFailureIndex = i;
      latestSuccessAfterFailureIndex = -1;
    }
    if (latestFailureIndex !== -1 && step.hasExplicitSuccess && i > latestFailureIndex) {
      latestSuccessAfterFailureIndex = i;
    }
  }

  if (latestSuccessAfterFailureIndex !== -1) return steps[latestSuccessAfterFailureIndex];
  if (latestFailureIndex !== -1) return steps[latestFailureIndex];

  return [...steps].sort((left, right) =>
    (right.collapsedPriority ?? 0) - (left.collapsedPriority ?? 0)
    || right.blockIndex - left.blockIndex
    || right.stepIndex - left.stepIndex,
  )[0];
}

function selectSummarySteps(steps: DerivedThinkingStep[], _activeStepId?: string): DerivedThinkingStep[] {
  if (steps.length <= MAX_SUMMARY_STEPS) return steps;
  return steps.slice(-MAX_SUMMARY_STEPS);
}

// ---------- mode renderers -------------------------------------------------

function renderGroupHeader(
  theme: ThinkingThemeLike,
  width: number,
  totalSteps: number,
  isActive: boolean,
): string {
  const titleRole = isActive ? "warning" : "dim";
  const title = theme.fg(titleRole, "Thinking Steps");
  if (totalSteps <= 1) return truncateToWidth(title, width, "");
  const count = theme.fg("muted", `  · ${totalSteps} thoughts`);
  return truncateToWidth(`${title}${count}`, width, "");
}

function renderSummary(
  theme: ThinkingThemeLike,
  width: number,
  steps: DerivedThinkingStep[],
  activeStepId: string | undefined,
  isActive: boolean,
): string[] {
  const lines = [renderGroupHeader(theme, width, steps.length, isActive)];
  const visible = selectSummarySteps(steps, activeStepId);
  for (let index = 0; index < visible.length; index++) {
    const step = visible[index]!;
    const isLast = index === visible.length - 1;
    lines.push(...wrapStepHeader(theme, width, step, step.id === activeStepId, isLast));
  }
  return lines;
}

function renderExpanded(
  theme: ThinkingThemeLike,
  width: number,
  steps: DerivedThinkingStep[],
  activeStepId: string | undefined,
  isActive: boolean,
): string[] {
  const lines = [renderGroupHeader(theme, width, steps.length, isActive)];

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    const isLast = index === steps.length - 1;
    const isStepActive = step.id === activeStepId;
    lines.push(...wrapStepHeader(theme, width, step, isStepActive, isLast));

    const normalizedBody = step.body.trim();
    if (!normalizedBody) continue;

    const bodyPrefix = isLast ? "   " : `${theme.fg("muted", "│")}  `;
    lines.push(...renderWrappedRawText(theme, normalizedBody, width, bodyPrefix));
  }

  return lines;
}

// ---------- public API -----------------------------------------------------

export function renderThinkingStepsLines(theme: ThinkingThemeLike, width: number, options: RenderOptions): string[] {
  if (options.steps.length === 0) return [];
  if (options.mode === "collapsed") {
    return renderCollapsed(theme, width, options.steps, options.activeStepId, options.isActive, options.nowMs ?? Date.now());
  }
  if (options.mode === "expanded") {
    return renderExpanded(theme, width, options.steps, options.activeStepId, options.isActive);
  }
  return renderSummary(theme, width, options.steps, options.activeStepId, options.isActive);
}

type MergeRegistryEntry = {
  primary: ThinkingStepsComponent;
  blocks: ThinkingSourceBlock[];
};

const MERGE_REGISTRY_KEY = Symbol.for("pi-basic-tools.thinking-steps.merge-registry");

function getMergeRegistry(): Map<string, MergeRegistryEntry> {
  const existing = (globalThis as Record<PropertyKey, unknown>)[MERGE_REGISTRY_KEY];
  if (existing instanceof Map) return existing as Map<string, MergeRegistryEntry>;
  const created = new Map<string, MergeRegistryEntry>();
  (globalThis as Record<PropertyKey, unknown>)[MERGE_REGISTRY_KEY] = created;
  return created;
}

function mergeRegistryKey(scopeKey: string, messageTimestamp: number): string {
  return `${scopeKey}::${messageTimestamp}`;
}

export function clearThinkingMergeRegistry(scopeKey?: string, messageTimestamp?: number): void {
  const registry = getMergeRegistry();
  if (scopeKey === undefined && messageTimestamp === undefined) {
    registry.clear();
    return;
  }
  if (scopeKey !== undefined && messageTimestamp !== undefined) {
    registry.delete(mergeRegistryKey(scopeKey, messageTimestamp));
    return;
  }
  if (scopeKey !== undefined) {
    for (const key of [...registry.keys()]) {
      if (key.startsWith(`${scopeKey}::`)) registry.delete(key);
    }
  }
}

export class ThinkingStepsComponent implements Component {
  private steps: DerivedThinkingStep[];
  private cacheKey?: string;
  private cachedLines?: string[];
  private readonly scopeKey: string;
  private readonly sourceBlocks: ThinkingSourceBlock[];
  private isShadow = false;

  constructor(
    private readonly theme: ThinkingThemeLike,
    private readonly messageTimestamp: number,
    blocks: ThinkingSourceBlock[],
    scopeKey?: string,
  ) {
    this.sourceBlocks = [...blocks];
    this.scopeKey = scopeKey ?? getCurrentThinkingScopeKey();
    this.steps = deriveThinkingSteps(this.sourceBlocks);

    const registry = getMergeRegistry();
    const key = mergeRegistryKey(this.scopeKey, this.messageTimestamp);
    const existing = registry.get(key);
    if (existing) {
      existing.primary.appendBlocks(this.sourceBlocks);
      this.isShadow = true;
    } else {
      registry.set(key, { primary: this, blocks: this.sourceBlocks });
    }
  }

  /** Called by a subsequent same-message component to fold its blocks into the primary. */
  appendBlocks(extra: ThinkingSourceBlock[]): void {
    let added = false;
    for (const block of extra) {
      if (this.sourceBlocks.some((existing) => existing.contentIndex === block.contentIndex)) continue;
      this.sourceBlocks.push(block);
      added = true;
    }
    if (added) {
      this.steps = deriveThinkingSteps(this.sourceBlocks);
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.isShadow) return [];
    const mode = getThinkingStepsMode(this.scopeKey);
    const active = getActiveThinkingState(this.messageTimestamp, this.scopeKey);
    const activeStepId = active.active && active.contentIndex !== undefined
      ? [...this.steps].reverse().find((step) => step.contentIndex === active.contentIndex)?.id
      : undefined;
    const shouldBypassCache = mode === "collapsed" && active.active;
    const nextCacheKey = `${width}:${mode}:${active.active ? 1 : 0}:${activeStepId ?? ""}:${this.sourceBlocks.length}`;
    if (!shouldBypassCache && this.cachedLines && this.cacheKey === nextCacheKey) {
      return this.cachedLines;
    }

    const lines = renderThinkingStepsLines(this.theme, width, {
      mode,
      steps: this.steps,
      activeStepId,
      isActive: active.active,
      nowMs: Date.now(),
    });

    if (!shouldBypassCache) {
      this.cacheKey = nextCacheKey;
      this.cachedLines = lines;
    } else {
      this.cacheKey = undefined;
      this.cachedLines = undefined;
    }
    return lines;
  }

  invalidate(): void {
    this.cacheKey = undefined;
    this.cachedLines = undefined;
  }
}
