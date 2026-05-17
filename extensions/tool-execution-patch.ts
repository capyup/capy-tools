import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Pi's ToolExecutionComponent unconditionally adds `new Spacer(1)` as its
// first child in its constructor (see
// node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js:42).
// When basic-tool-grouping marks earlier tools in a group as hidden, those
// tools' inner renderer components return `[]`, but the wrapping
// ToolExecutionComponent still renders its Spacer line, producing one stacked
// blank line per hidden tool. With N grouped tools the user sees N-1 blank
// lines before the visible group block.
//
// We patch `ToolExecutionComponent.prototype.render` so that when every
// rendered line is visually empty (no characters besides whitespace and ANSI
// escape sequences) the wrapping component disappears entirely. Tools that
// produce real content still render normally — only the Spacer-only case is
// suppressed.

const PI_TOOL_EXECUTION_MODULE = "dist/modes/interactive/components/tool-execution.js";
const PATCH_STATE_KEY = Symbol.for("pi-basic-tools.tool-execution-patch.state");
const OVERRIDE_REGISTRY_KEY = Symbol.for("pi-basic-tools.tool-execution-patch.overrides");
// Strip CSI / SGR ANSI escape sequences so colored-but-blank lines are still
// detected as visually empty.
const ANSI_RE = /\[[0-9;?]*[A-Za-z]/g;

interface ToolExecutionPrototype {
  render(width: number): string[];
}

type ToolExecutionRenderShell = "default" | "self";

export interface ToolDefinitionOverride {
  renderShell?: ToolExecutionRenderShell;
  renderCall?: (args: unknown, theme: unknown, context: unknown) => unknown;
  renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => unknown;
}

interface ToolExecutionPatchState {
  refCount: number;
  cleanup?: () => void;
  installPromise?: Promise<() => void>;
}

function getOverrideRegistry(): Map<string, ToolDefinitionOverride> {
  const existing = (globalThis as Record<PropertyKey, unknown>)[OVERRIDE_REGISTRY_KEY];
  if (existing instanceof Map) return existing as Map<string, ToolDefinitionOverride>;
  const created = new Map<string, ToolDefinitionOverride>();
  (globalThis as Record<PropertyKey, unknown>)[OVERRIDE_REGISTRY_KEY] = created;
  return created;
}

/**
 * Inject a renderCall/renderResult (and optionally renderShell) for `toolName`
 * so tools registered by other extensions (e.g. @ff-labs/pi-fff's `fffind` /
 * `ffgrep` / `fff-multi-grep`) render through our basic-tool grouping UI
 * instead of pi-coding-agent's default toolDefinition-only renderer. The
 * override is consulted from inside the patched `ToolExecutionComponent`
 * prototype methods. Returns a disposer; calling it again is a no-op.
 */
export function registerToolDefinitionOverride(toolName: string, override: ToolDefinitionOverride): () => void {
  const registry = getOverrideRegistry();
  registry.set(toolName, override);
  return () => {
    if (registry.get(toolName) === override) registry.delete(toolName);
  };
}

export function getToolDefinitionOverride(toolName: string): ToolDefinitionOverride | undefined {
  return getOverrideRegistry().get(toolName);
}

function getPatchState(): ToolExecutionPatchState {
  const existing = (globalThis as Record<PropertyKey, unknown>)[PATCH_STATE_KEY];
  if (existing && typeof existing === "object") return existing as ToolExecutionPatchState;
  const created: ToolExecutionPatchState = { refCount: 0 };
  (globalThis as Record<PropertyKey, unknown>)[PATCH_STATE_KEY] = created;
  return created;
}

export function isVisuallyEmptyLine(line: string): boolean {
  return line.replace(ANSI_RE, "").trim().length === 0;
}

export function shouldHideRenderedLines(lines: readonly string[]): boolean {
  if (lines.length === 0) return false;
  for (const line of lines) {
    if (!isVisuallyEmptyLine(line)) return false;
  }
  return true;
}

function assertPatchableToolExecutionComponent(value: unknown): { prototype: ToolExecutionPrototype } {
  if (!value || (typeof value !== "function" && typeof value !== "object")) {
    throw new Error("ToolExecution patch failed: ToolExecutionComponent export is missing or invalid.");
  }
  const prototype = (value as { prototype?: unknown }).prototype;
  if (!prototype || typeof prototype !== "object") {
    throw new Error("ToolExecution patch failed: ToolExecutionComponent.prototype is missing.");
  }
  const proto = prototype as Record<string, unknown>;
  if (typeof proto.render !== "function") {
    throw new Error("ToolExecution patch failed: ToolExecutionComponent.prototype.render is not a function.");
  }
  for (const name of ["getCallRenderer", "getResultRenderer", "getRenderShell"] as const) {
    if (typeof proto[name] !== "function") {
      throw new Error(`ToolExecution patch failed: ToolExecutionComponent.prototype.${name} is not a function.`);
    }
  }
  return value as { prototype: ToolExecutionPrototype };
}

function getPackageRoot(packageName: string): string {
  let entryUrl: string;
  try {
    entryUrl = import.meta.resolve(packageName);
  } catch (error) {
    throw new Error(`ToolExecution patch failed: could not resolve ${packageName} package root.`, { cause: error });
  }
  try {
    const entryPath = fileURLToPath(entryUrl);
    return dirname(dirname(entryPath));
  } catch (error) {
    throw new Error(`ToolExecution patch failed: could not derive ${packageName} package root from ${entryUrl}.`, {
      cause: error,
    });
  }
}

async function importPiCodingAgentInternal<TModule>(relativePath: string): Promise<TModule> {
  const packageRoot = getPackageRoot("@earendil-works/pi-coding-agent");
  const moduleUrl = pathToFileURL(join(packageRoot, relativePath)).href;
  try {
    return (await import(moduleUrl)) as TModule;
  } catch (error) {
    throw new Error(
      `ToolExecution patch failed: could not import internal module "@earendil-works/pi-coding-agent/${relativePath}".`,
      { cause: error },
    );
  }
}

async function installPatch(): Promise<() => void> {
  const moduleExports = await importPiCodingAgentInternal<{ ToolExecutionComponent: unknown }>(
    PI_TOOL_EXECUTION_MODULE,
  );
  const ToolExecutionComponent = assertPatchableToolExecutionComponent(moduleExports.ToolExecutionComponent);
  const prototype = ToolExecutionComponent.prototype as ToolExecutionPrototype & Record<string, any>;
  const registry = getOverrideRegistry();

  const originalRender = prototype.render;
  const patchedRender = function patchedRender(this: ToolExecutionPrototype, width: number): string[] {
    const lines = originalRender.call(this, width);
    return shouldHideRenderedLines(lines) ? [] : lines;
  };
  prototype.render = patchedRender;

  const originalGetCallRenderer = prototype.getCallRenderer as (this: any) => unknown;
  const patchedGetCallRenderer = function patchedGetCallRenderer(this: { toolName: string }): unknown {
    const override = registry.get(this.toolName);
    if (override?.renderCall) return override.renderCall;
    return originalGetCallRenderer.call(this);
  };
  prototype.getCallRenderer = patchedGetCallRenderer;

  const originalGetResultRenderer = prototype.getResultRenderer as (this: any) => unknown;
  const patchedGetResultRenderer = function patchedGetResultRenderer(this: { toolName: string }): unknown {
    const override = registry.get(this.toolName);
    if (override?.renderResult) return override.renderResult;
    return originalGetResultRenderer.call(this);
  };
  prototype.getResultRenderer = patchedGetResultRenderer;

  const originalGetRenderShell = prototype.getRenderShell as (this: any) => ToolExecutionRenderShell;
  const patchedGetRenderShell = function patchedGetRenderShell(this: { toolName: string }): ToolExecutionRenderShell {
    const override = registry.get(this.toolName);
    if (override?.renderShell) return override.renderShell;
    return originalGetRenderShell.call(this);
  };
  prototype.getRenderShell = patchedGetRenderShell;

  // hasRendererDefinition() short-circuits to "no renderer" when neither
  // toolDefinition nor builtInToolDefinition exist for the tool name. Custom
  // tools registered by other extensions (pi-fff's fffind / ffgrep / …) do
  // have a toolDefinition so this is rarely a problem, but if the override is
  // set for a name with no underlying registration we still want our renderer
  // to be invoked. Wrap hasRendererDefinition so the presence of an override
  // counts as having a renderer.
  const originalHasRendererDefinition = prototype.hasRendererDefinition as (this: any) => boolean;
  if (typeof originalHasRendererDefinition === "function") {
    const patchedHasRendererDefinition = function patchedHasRendererDefinition(this: { toolName: string }): boolean {
      if (registry.has(this.toolName)) return true;
      return originalHasRendererDefinition.call(this);
    };
    prototype.hasRendererDefinition = patchedHasRendererDefinition;
    return () => {
      if (prototype.render === patchedRender) prototype.render = originalRender;
      if (prototype.getCallRenderer === patchedGetCallRenderer) prototype.getCallRenderer = originalGetCallRenderer;
      if (prototype.getResultRenderer === patchedGetResultRenderer) prototype.getResultRenderer = originalGetResultRenderer;
      if (prototype.getRenderShell === patchedGetRenderShell) prototype.getRenderShell = originalGetRenderShell;
      if (prototype.hasRendererDefinition === patchedHasRendererDefinition) {
        prototype.hasRendererDefinition = originalHasRendererDefinition;
      }
    };
  }

  return () => {
    if (prototype.render === patchedRender) prototype.render = originalRender;
    if (prototype.getCallRenderer === patchedGetCallRenderer) prototype.getCallRenderer = originalGetCallRenderer;
    if (prototype.getResultRenderer === patchedGetResultRenderer) prototype.getResultRenderer = originalGetResultRenderer;
    if (prototype.getRenderShell === patchedGetRenderShell) prototype.getRenderShell = originalGetRenderShell;
  };
}

export async function retainToolExecutionPatch(): Promise<() => Promise<void>> {
  const state = getPatchState();
  state.refCount += 1;

  if (!state.cleanup) {
    const installPromise = state.installPromise ?? installPatch();
    if (!state.installPromise) state.installPromise = installPromise;
    try {
      state.cleanup = await installPromise;
    } catch (error) {
      state.refCount = Math.max(0, state.refCount - 1);
      throw error;
    } finally {
      if (state.installPromise === installPromise) state.installPromise = undefined;
    }
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    state.refCount = Math.max(0, state.refCount - 1);
    if (state.refCount > 0) return;
    const cleanup = state.cleanup;
    if (!cleanup) return;
    state.cleanup = undefined;
    try {
      cleanup();
    } catch (error) {
      state.cleanup = cleanup;
      state.refCount += 1;
      released = false;
      throw error;
    }
  };
}

