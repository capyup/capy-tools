import { describe, expect, test } from "bun:test";
import { resetBasicToolGroupingForTests, renderGroupedToolCall, renderGroupedToolResult, installBasicToolGrouping, summarizeToolCall } from "../extensions/basic-tool-grouping.ts";

// 一个 passthrough theme，方便看纯文本输出
function plainTheme() {
  return {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function render(component: { render: (width: number) => string[] }, width = 80) {
  return component.render(width).join("\n");
}

function ctx(toolCallId: string, executionStarted = true, expanded = false) {
  return { toolCallId, executionStarted, expanded, invalidate: () => {} };
}

// 模拟一个 tool result
function okResult(text: string, details?: Record<string, any>) {
  return {
    content: [{ type: "text", text }],
    details: details ?? {},
  };
}

describe("grouping showcase - harmless combos", () => {
  test("combo A: 纯 inspect 三连 - read + read_block + symbol_outline", () => {
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    // 1. read
    const c1 = renderGroupedToolCall("read", { path: "README.md" }, theme, ctx("c1"));
    // 2. read_block
    const c2 = renderGroupedToolCall("read_block", { path: "extensions/basic-tool-grouping.ts", symbol: "renderGroupLines" }, theme, ctx("c2"));
    // 3. symbol_outline
    const c3 = renderGroupedToolCall("symbol_outline", { path: "extensions/basic-tool-grouping.ts", maxBlocks: 4 }, theme, ctx("c3"));

    // 全部成功后看分组标题
    renderGroupedToolResult("read", okResult("# pi-basic-tools\n\nCore tools.\n", { lineCount: 3 }), { expanded: false, isPartial: false }, theme, ctx("c1"));
    renderGroupedToolResult("read_block", okResult("function renderGroupLines(...) { ... }", { displayPath: "extensions/basic-tool-grouping.ts", outputStart: 420, outputEnd: 440 }), { expanded: false, isPartial: false }, theme, ctx("c2"));
    renderGroupedToolResult("symbol_outline", okResult("renderGroupLines\ncodexAction\n...", { displayPath: "extensions/basic-tool-grouping.ts", displayedCount: 4 }), { expanded: false, isPartial: false }, theme, ctx("c3"));

    // 用最后一个 call 的 component 看整组折叠态
    const collapsed = render(c3, 80);
    console.log("\n=== Combo A: 纯 inspect 三连 (collapsed) ===\n" + collapsed);

    expect(collapsed).toContain("Explored 3 targets");
    expect(collapsed).toContain("Read README.md");
    expect(collapsed).toContain("Read extensions/basic-tool-grouping.ts");
    expect(collapsed).toContain("Outline extensions/basic-tool-grouping.ts");
    expect(collapsed).toContain("├ ");
    expect(collapsed).toContain("└ ");
  });

  test("combo B: 纯 search 三连 - grep + find + sourcegraph", () => {
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    renderGroupedToolCall("grep", { pattern: "BasicToolGroup", path: "extensions" }, theme, ctx("c1"));
    renderGroupedToolCall("find", { pattern: "*.ts", path: "tests" }, theme, ctx("c2"));
    renderGroupedToolCall("sourcegraph", { query: "repo:capyup/pi-basic-tools file:.ts" }, theme, ctx("c3"));

    renderGroupedToolResult("grep", okResult("extensions/basic-tool-grouping.ts:42\nextensions/basic-tool-grouping.ts:88", { lineCount: 2 }), { expanded: false, isPartial: false }, theme, ctx("c1"));
    renderGroupedToolResult("find", okResult("tests/ui-tools.test.ts\ntests/extension-host.ts", { lineCount: 2 }), { expanded: false, isPartial: false }, theme, ctx("c2"));
    renderGroupedToolResult("sourcegraph", okResult("repo_map-read-block.test.ts\napply-patch.test.ts", { lineCount: 2 }), { expanded: false, isPartial: false }, theme, ctx("c3"));

    const collapsed = render(renderGroupedToolCall("sourcegraph", { query: "repo:capyup/pi-basic-tools file:.ts" }, theme, ctx("c3", false)), 80);
    console.log("\n=== Combo B: 纯 search 三连 (collapsed) ===\n" + collapsed);

    expect(collapsed).toContain("Explored 3 targets");
    expect(collapsed).toContain("Search BasicToolGroup");
    expect(collapsed).toContain("Find *.ts");
    expect(collapsed).toContain("Search Sourcegraph repo:capyup/pi-basic-tools file:.ts");
    expect(collapsed).toContain("├ ");
    expect(collapsed).toContain("└ ");
  });

  test("combo C: 混合 inspect + search 五连", () => {
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    renderGroupedToolCall("repo_map", { path: ".", depth: 2 }, theme, ctx("c1"));
    renderGroupedToolCall("read", { path: "package.json" }, theme, ctx("c2"));
    renderGroupedToolCall("grep", { pattern: "test", path: "tests" }, theme, ctx("c3"));
    renderGroupedToolCall("ls", { path: "extensions" }, theme, ctx("c4"));
    renderGroupedToolCall("read_block", { path: "extensions/basic-tool-grouping.ts", line: 1 }, theme, ctx("c5"));

    renderGroupedToolResult("repo_map", okResult("Root: pi-basic-tools\nFiles: 41", { root: "/Users/lucas/Developer/pi-basic-tools", fileCount: 41 }), { expanded: false, isPartial: false }, theme, ctx("c1"));
    renderGroupedToolResult("read", okResult('{ "name": "@capyup/pi-basic-tools" }', { lineCount: 1 }), { expanded: false, isPartial: false }, theme, ctx("c2"));
    renderGroupedToolResult("grep", okResult("tests/ui-tools.test.ts:10\ntests/ui-tools.test.ts:25", { lineCount: 2 }), { expanded: false, isPartial: false }, theme, ctx("c3"));
    renderGroupedToolResult("ls", okResult("basic-tool-grouping.ts\nindex.ts\n...", { lineCount: 14 }), { expanded: false, isPartial: false }, theme, ctx("c4"));
    renderGroupedToolResult("read_block", okResult("import { ... } from ...", { displayPath: "extensions/basic-tool-grouping.ts", outputStart: 1, outputEnd: 20 }), { expanded: false, isPartial: false }, theme, ctx("c5"));

    const collapsed = render(renderGroupedToolCall("read_block", { path: "extensions/basic-tool-grouping.ts", line: 1 }, theme, ctx("c5", false)), 80);
    console.log("\n=== Combo C: 混合 inspect + search 五连 (collapsed) ===\n" + collapsed);

    expect(collapsed).toContain("Explored 5 targets");
    expect(collapsed).toContain("├ ");
    expect(collapsed).toContain("└ ");
  });

  test("combo D: 同类型纯 run 命令三连（展示 Codex-style）", () => {
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    renderGroupedToolCall("bash", { command: "git status --short" }, theme, ctx("c1"));
    renderGroupedToolCall("bash", { command: "git log --oneline -3" }, theme, ctx("c2"));
    renderGroupedToolCall("bash", { command: "ls -la" }, theme, ctx("c3"));

    renderGroupedToolResult("bash", okResult(" M README.md\n M extensions/basic-tool-grouping.ts", { lineCount: 2, isError: false }), { expanded: false, isPartial: false }, theme, ctx("c1"));
    renderGroupedToolResult("bash", okResult("a1b2c3d feat: grouping\ne4f5g6h fix: collapse\n", { lineCount: 2, isError: false }), { expanded: false, isPartial: false }, theme, ctx("c2"));
    renderGroupedToolResult("bash", okResult("total 120\ndrwxr-xr-x  14 ...", { lineCount: 3, isError: false }), { expanded: false, isPartial: false }, theme, ctx("c3"));

    const collapsed = render(renderGroupedToolCall("bash", { command: "ls -la" }, theme, ctx("c3", false)), 80);
    console.log("\n=== Combo D: 纯 run 三连 (collapsed) ===\n" + collapsed);

    expect(collapsed).toContain("Ran 3 commands");
    expect(collapsed).toContain("Ran git status --short");
    expect(collapsed).toContain("Ran git log --oneline -3");
    expect(collapsed).toContain("Ran ls -la");
    expect(collapsed).toContain("├ ");
    expect(collapsed).toContain("└ ");
  });

  test("combo E: expanded 态展示完整内容", () => {
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    renderGroupedToolCall("read", { path: "README.md" }, theme, ctx("c1"));
    renderGroupedToolCall("grep", { pattern: "grouping", path: "extensions" }, theme, ctx("c2"));

    renderGroupedToolResult("read", okResult("# Title\nContent here.\n", { lineCount: 2 }), { expanded: true, isPartial: false }, theme, ctx("c1"));
    renderGroupedToolResult("grep", okResult("extensions/basic-tool-grouping.ts:10\nextensions/basic-tool-grouping.ts:20", { lineCount: 2 }), { expanded: true, isPartial: false }, theme, ctx("c2"));

    const expanded = render(renderGroupedToolCall("grep", { pattern: "grouping", path: "extensions" }, theme, { ...ctx("c2", false), expanded: true }), 80);
    console.log("\n=== Combo E: expanded 态 ===\n" + expanded);

    expect(expanded).toContain("Explored 2 targets");
    // expanded 态下不会有 "to expand" 提示
    expect(expanded).not.toContain("to expand");
    expect(expanded).toContain("├ ");
    expect(expanded).toContain("└ ");
  });

  test("combo F: 单个工具不成组", () => {
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    renderGroupedToolCall("repo_map", { path: "." }, theme, ctx("c1"));
    renderGroupedToolResult("repo_map", okResult("Files: 10", { root: ".", fileCount: 10 }), { expanded: false, isPartial: false }, theme, ctx("c1"));

    const solo = render(renderGroupedToolCall("repo_map", { path: "." }, theme, ctx("c1", false)), 80);
    console.log("\n=== Combo F: 单个工具（不成组） ===\n" + solo);

    // 单个工具不会显示组标题 "Explored 1 targets"，而是直接显示单行 Codex action
    expect(solo).toContain("Map .");
    // 单个工具不走 tree connector
    expect(solo).not.toContain("├ ");
    expect(solo).not.toContain("└ ");
  });

  test("combo G: error 状态展示", () => {
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    renderGroupedToolCall("bash", { command: "git invalid-cmd" }, theme, ctx("c1"));
    renderGroupedToolCall("read", { path: "nonexistent-file.xyz" }, theme, ctx("c2"));

    renderGroupedToolResult("bash", { content: [{ type: "text", text: "git: 'invalid-cmd' is not a git command" }], isError: true, details: { lineCount: 1 } }, { expanded: false, isPartial: false }, theme, ctx("c1"));
    renderGroupedToolResult("read", { content: [{ type: "text", text: "Error: ENOENT" }], isError: true, details: { lineCount: 1 } }, { expanded: false, isPartial: false }, theme, ctx("c2"));

    const collapsed = render(renderGroupedToolCall("read", { path: "nonexistent-file.xyz" }, theme, ctx("c2", false)), 80);
    console.log("\n=== Combo G: 含 error 的混合组 ===\n" + collapsed);

    // bash(run) + read(inspect) 混合 role → role-counted header
    expect(collapsed).toContain("Ran 1 command, read 1 file");
    expect(collapsed).toContain("├ ");
    expect(collapsed).toContain("└ ");
    // error glyph from shared visual module
    expect(collapsed).toContain("!");
  });

  test("combo H: write_stdin polls/writes merge into parent exec_command meta", () => {
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    // exec_command starts and gets a session_id back.
    renderGroupedToolCall("exec_command", { command: "tail -f log.txt" }, theme, ctx("c1"));
    renderGroupedToolResult(
      "exec_command",
      okResult("session started", { session_id: "abc123" }),
      { expanded: false, isPartial: true },
      theme,
      ctx("c1"),
    );

    // write_stdin polls + a write — these MUST NOT render their own rows.
    renderGroupedToolCall("write_stdin", { session_id: "abc123", chars: "" }, theme, ctx("s1"));
    renderGroupedToolResult("write_stdin", okResult("poll #1", {}), { expanded: false, isPartial: false }, theme, ctx("s1"));
    renderGroupedToolCall("write_stdin", { session_id: "abc123", chars: "" }, theme, ctx("s2"));
    renderGroupedToolResult("write_stdin", okResult("poll #2", {}), { expanded: false, isPartial: false }, theme, ctx("s2"));
    renderGroupedToolCall("write_stdin", { session_id: "abc123", chars: "y\n" }, theme, ctx("s3"));
    renderGroupedToolResult("write_stdin", okResult("write", {}), { expanded: false, isPartial: false }, theme, ctx("s3"));

    // Re-render the parent (final state).
    const out = render(renderGroupedToolCall("exec_command", { command: "tail -f log.txt" }, theme, ctx("c1", false)), 80);
    console.log("\n=== Combo H: stdin merge ===\n" + out);

    // No stdin row, no separate stdin grouping.
    expect(out).not.toContain("stdin");
    expect(out).not.toContain("Ran 4 commands");
    // Parent exec_command row carries the meta.
    expect(out).toContain("tail -f log.txt");
    expect(out).toContain("2 polls");
    expect(out).toContain("1 write");
  });

  test("combo I: write_stdin without parent exec_command is dropped", () => {
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    renderGroupedToolCall("write_stdin", { session_id: "missing", chars: "" }, theme, ctx("s1"));
    renderGroupedToolResult("write_stdin", okResult("poll", {}), { expanded: false, isPartial: false }, theme, ctx("s1"));

    // Add a bash command afterward so we have something to render.
    renderGroupedToolCall("bash", { command: "echo hi" }, theme, ctx("b1"));
    renderGroupedToolResult("bash", okResult("hi", {}), { expanded: false, isPartial: false }, theme, ctx("b1"));

    const out = render(renderGroupedToolCall("bash", { command: "echo hi" }, theme, ctx("b1", false)), 80);
    expect(out).not.toContain("stdin");
    expect(out).toContain("Ran echo hi");
  });

  test("combo J: write tool is not handled by basic-tool grouping", () => {
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    const call = renderGroupedToolCall("write", { path: "notes.md" }, theme, ctx("w1"));
    renderGroupedToolResult("write", okResult("written", {}), { expanded: false, isPartial: false }, theme, ctx("w1"));
    const result = renderGroupedToolCall("write", { path: "notes.md" }, theme, ctx("w1", false));

    expect(render(call)).toBe("");
    expect(render(result)).toBe("");
  });

  test("combo L: pi-fff tools (fffind + ffgrep) render through grouped UI with totalMatched/totalFiles details", () => {
    // Verifies that fffind / ffgrep / fff-multi-grep — registered by @ff-labs/pi-fff,
    // not by us — flow through renderGroupedToolCall / renderGroupedToolResult and
    // produce the same tree-row visuals as our own grep / find. The ToolExecutionComponent
    // prototype patch is what connects them at runtime (see tool-execution-patch.ts);
    // here we exercise the renderer entry points directly.
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    renderGroupedToolCall("fffind", { pattern: "app-server-protocol", path: "references/codex/codex-rs", limit: 30 }, theme, ctx("f1"));
    renderGroupedToolCall("ffgrep", { pattern: "start_control_socket_acceptor", path: "references/codex/codex-rs" }, theme, ctx("f2"));
    renderGroupedToolCall("fff-multi-grep", { patterns: ["submit_op", "legacy_core"], path: "references/codex/codex-rs/tui/src" }, theme, ctx("f3"));

    // Results carry pi-fff's totalMatched / totalFiles so the detail meta reads
    // "N results in M files" instead of the post-compaction "1 lines".
    renderGroupedToolResult(
      "fffind",
      okResult("Find app-server-protocol in references/codex/codex-rs · 883 results in 9070 files", { totalMatched: 883, totalFiles: 9070 }),
      { expanded: false, isPartial: false },
      theme,
      ctx("f1"),
    );
    renderGroupedToolResult(
      "ffgrep",
      okResult("Search start_control_socket_acceptor in references/codex/codex-rs · 9 results in 9070 files", { totalMatched: 9, totalFiles: 9070 }),
      { expanded: false, isPartial: false },
      theme,
      ctx("f2"),
    );
    renderGroupedToolResult(
      "fff-multi-grep",
      okResult("Search submit_op, legacy_core in references/codex/codex-rs/tui/src · 108 results in 9070 files", { totalMatched: 108, totalFiles: 9070 }),
      { expanded: false, isPartial: false },
      theme,
      ctx("f3"),
    );

    const collapsed = render(renderGroupedToolCall("fff-multi-grep", { patterns: ["submit_op", "legacy_core"], path: "references/codex/codex-rs/tui/src" }, theme, ctx("f3", false)), 80);
    console.log("\n=== Combo L: pi-fff tools through grouped UI ===\n" + collapsed);

    // All three roll up under the standard search/inspect group title.
    expect(collapsed).toContain("Explored 3 targets");
    expect(collapsed).toContain("Find app-server-protocol");
    expect(collapsed).toContain("Search start_control_socket_acceptor");
    expect(collapsed).toContain("Search submit_op, legacy_core");
    // Details from pi-fff details.totalMatched / details.totalFiles surface in the meta column.
    expect(collapsed).toContain("883 results in 9070 files");
    expect(collapsed).toContain("9 results in 9070 files");
    expect(collapsed).toContain("108 results in 9070 files");
    // Tree connectors confirm grouping rendered through our shared tree-row helper.
    expect(collapsed).toContain("├ ");
    expect(collapsed).toContain("└ ");
  });

  test("combo M: single pi-fff call renders as one-line action without group title", () => {
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    renderGroupedToolCall("fffind", { pattern: "*.rs", path: "references/codex/codex-rs" }, theme, ctx("f1"));
    renderGroupedToolResult(
      "fffind",
      okResult("Find *.rs in references/codex/codex-rs · 42 results in 9070 files", { totalMatched: 42, totalFiles: 9070 }),
      { expanded: false, isPartial: false },
      theme,
      ctx("f1"),
    );

    const solo = render(renderGroupedToolCall("fffind", { pattern: "*.rs", path: "references/codex/codex-rs" }, theme, ctx("f1", false)), 100);
    console.log("\n=== Combo M: single pi-fff call ===\n" + solo);

    expect(solo).toContain("Find *.rs");
    expect(solo).toContain("42 results in 9070 files");
    expect(solo).not.toContain("Explored 1 targets");
    expect(solo).not.toContain("├ ");
    expect(solo).not.toContain("└ ");
  });

  test("combo K: only the latest slot in a group renders — earlier slots stay empty", () => {
    // Regression for a bug where 9 tool calls in one group produced 4+ duplicated
    // "Used 9 tools" blocks. The root cause: each call's slot returns a fresh
    // BasicToolGroupComponent referencing the same shared group, and the older
    // component slots did not honour item.hidden (only BasicToolItemComponent did).
    resetBasicToolGroupingForTests();
    const theme = plainTheme();

    // Simulate ToolExecutionComponent.updateDisplay re-running renderCall on every
    // refresh — each tool call's slot stores the most recently returned component.
    const slot1 = renderGroupedToolCall("read", { path: "a.md" }, theme, ctx("c1"));
    const slot2 = renderGroupedToolCall("read", { path: "b.md" }, theme, ctx("c2"));
    const slot3 = renderGroupedToolCall("read", { path: "c.md" }, theme, ctx("c3"));

    // After slot3 is created, slot1 and slot2 must render nothing — otherwise the
    // group block appears multiple times in the chat.
    expect(render(slot1)).toBe("");
    expect(render(slot2)).toBe("");

    const latest = render(slot3, 80);
    expect(latest).toContain("Explored 3 targets");
    expect(latest).toContain("Read a.md");
    expect(latest).toContain("Read b.md");
    expect(latest).toContain("Read c.md");
  });
});
