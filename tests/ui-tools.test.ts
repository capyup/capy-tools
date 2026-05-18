import { describe, expect, test } from "bun:test";
import askUserExtension from "../extensions/ask-user.ts";
import askQuestionExtension from "../extensions/ask-question.ts";
import askQuestionnaireExtension from "../extensions/ask-questionnaire.ts";
import recapExtension from "../extensions/recap.ts";
import { createDialogUi, createExtensionHost, createQuestionnaireUi } from "./extension-host.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";

function plainTheme() {
  return {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function renderComponent(component: { render: (width: number) => string[] }) {
  return component.render(200).map((line) => line.trimEnd()).join("\n");
}

describe("ask_user", () => {
  test("asks one free-form question", async () => {
    const ui = createDialogUi({ inputAnswers: ["Use a compact renderer"] });
    const host = createExtensionHost({ ui });
    askUserExtension(host.api as any);

    const result = await host.runTool("ask_user", {
      question: "What should we optimize?",
      context: "We are improving tool output.",
    });

    expect(result.content[0].text).toBe("User answered: Use a compact renderer");
    expect(result.details).toMatchObject({ answer: "Use a compact renderer", cancelled: false });

    const tool = host.getTool("ask_user");
    expect(renderComponent(tool.renderCall({}, plainTheme(), {}))).toBe("");
    const collapsed = renderComponent(tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme(), {}));
    expect(collapsed).toBe("ask user answered (to expand)");
    const expanded = renderComponent(tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme(), {}));
    expect(expanded).toContain("Use a compact renderer");
  });

  test("reports cancellation without inventing an answer", async () => {
    const ui = createDialogUi({ inputAnswers: [undefined] });
    const host = createExtensionHost({ ui });
    askUserExtension(host.api as any);

    const result = await host.runTool("ask_user", { question: "What now?" });

    expect(result.content[0].text).toBe("User cancelled.");
    expect(result.details).toMatchObject({ cancelled: true });
  });
});

describe("ask_question", () => {
  test("returns the selected option when choices are provided", async () => {
    const ui = createDialogUi({ selectAnswers: ["Ship it"] });
    const host = createExtensionHost({ ui });
    askQuestionExtension(host.api as any);

    const result = await host.runTool("ask_question", {
      question: "What should we do?",
      context: "A release decision is required.",
      options: ["Ship it", "Hold"],
      allowFreeText: false,
    });

    expect(result.content[0].text).toBe("User answered: Ship it");
    expect(result.details.answer).toBe("Ship it");
  });

  test("allows custom answers through the dialog UI", async () => {
    const ui = createDialogUi({ selectAnswers: ["Other / custom answer"], inputAnswers: ["Run more tests"] });
    const host = createExtensionHost({ ui });
    askQuestionExtension(host.api as any);

    const result = await host.runTool("ask_question", {
      question: "What next?",
      options: ["Ship it", "Hold"],
      allowFreeText: true,
    });

    expect(result.content[0].text).toBe("User answered: Run more tests");
    expect(result.details.answer).toBe("Run more tests");
  });

  test("reports cancellation without inventing an answer", async () => {
    const ui = createDialogUi({ selectAnswers: [undefined] });
    const host = createExtensionHost({ ui });
    askQuestionExtension(host.api as any);

    const result = await host.runTool("ask_question", {
      question: "Continue?",
      options: ["Yes", "No"],
    });

    expect(result.content[0].text).toBe("User cancelled the question.");
    expect(result.details).toBeUndefined();
  });
});

describe("ask_questionnaire", () => {
  test("submits a recommended option using the real questionnaire component path", async () => {
    const ui = createQuestionnaireUi((component) => {
      component.handleInput(ENTER);
    });
    const host = createExtensionHost({ ui });
    askQuestionnaireExtension(host.api as any);

    const result = await host.runTool("ask_questionnaire", {
      questions: [
        {
          id: "release",
          question: "Release now?",
          context: "The recommended option should be selected initially.",
          options: ["No", "Yes"],
          recommended: 1,
        },
      ],
    });

    expect(result.details.cancelled).toBe(false);
    expect(result.details.answers).toEqual([{ id: "release", question: "Release now?", answer: "Yes", wasCustom: false }]);
    expect(result.content[0].text).toContain("**A:** Yes");
  });

  test("collects a custom free-text answer", async () => {
    const ui = createQuestionnaireUi((component) => {
      for (const ch of "custom answer") component.handleInput(ch);
      component.handleInput(ENTER);
    });
    const host = createExtensionHost({ ui });
    askQuestionnaireExtension(host.api as any);

    const result = await host.runTool("ask_questionnaire", {
      questions: [{ id: "notes", question: "Any notes?" }],
    });

    expect(result.details.cancelled).toBe(false);
    expect(result.details.answers[0]).toMatchObject({ id: "notes", answer: "custom answer", wasCustom: true });
  });

  test("handles multi-question navigation, duplicate ids, and final submit", async () => {
    const ui = createQuestionnaireUi((component) => {
      component.handleInput(ENTER);
      component.handleInput(DOWN);
      component.handleInput(ENTER);
      component.handleInput(ENTER);
    });
    const host = createExtensionHost({ ui });
    askQuestionnaireExtension(host.api as any);

    const result = await host.runTool("ask_questionnaire", {
      questions: [
        { id: "choice", question: "First?", options: ["A", "B"] },
        { id: "choice", question: "Second?", options: ["C", "D"] },
      ],
    });

    expect(result.details.cancelled).toBe(false);
    expect(result.details.answers.map((answer: any) => answer.id)).toEqual(["choice", "choice-2"]);
    expect(result.details.answers.map((answer: any) => answer.answer)).toEqual(["A", "D"]);
  });

  test("reports non-interactive mode as cancelled", async () => {
    const host = createExtensionHost();
    askQuestionnaireExtension(host.api as any);
    const result = await host.runTool(
      "ask_questionnaire",
      { questions: [{ id: "q", question: "Question?" }] },
      { hasUI: false },
    );

    expect(result.content[0].text).toContain("UI not available");
    expect(result.details.cancelled).toBe(true);
  });

  test("returns a dismissed result on escape", async () => {
    const ui = createQuestionnaireUi((component) => {
      component.handleInput(ESC);
    });
    const host = createExtensionHost({ ui });
    askQuestionnaireExtension(host.api as any);
    const result = await host.runTool("ask_questionnaire", { questions: [{ id: "q", question: "Question?", options: ["A"] }] });

    expect(result.content[0].text).toBe("(questionnaire dismissed)");
    expect(result.details.cancelled).toBe(true);
  });
});

describe("recap", () => {
  test("echoes the prose passed in as `text` via execute()", async () => {
    const host = createExtensionHost();
    recapExtension(host.api as any);

    const prose = "I've mapped the repo; now checking the renderer.";
    const result = await host.runTool("recap", { text: prose });

    expect(result.content[0].text).toBe(prose);
    expect(result.details?.text).toBe(prose);
  });

  test("trims surrounding whitespace from the prose", async () => {
    const host = createExtensionHost();
    recapExtension(host.api as any);

    const result = await host.runTool("recap", { text: "  hello world  \n" });
    expect(result.content[0].text).toBe("hello world");
  });

  test("is framed as a soft habit, not a hard rule", async () => {
    const host = createExtensionHost();
    recapExtension(host.api as any);
    const handlers = host.handlers.get("before_agent_start") ?? [];
    const result = await handlers[0]({});
    const prompt = result.systemPrompt;

    // Soft framing: no "must", no "Do not".
    expect(prompt).not.toMatch(/\bmust\b/i);
    expect(prompt).not.toMatch(/\bdo not\b/i);
  });

  test("injects a discipline-style system prompt that scopes `recap` as the narration channel", async () => {
    const host = createExtensionHost();
    recapExtension(host.api as any);
    const handlers = host.handlers.get("before_agent_start") ?? [];

    expect(handlers.length).toBe(1);
    const result = await handlers[0]({});
    const prompt = result.systemPrompt;

    // Header matches the `Todo discipline` style — short, imperative, condition-based.
    expect(prompt).toContain("Recap discipline:");

    // Core mechanic: the model passes prose AS A TOOL ARGUMENT. The prompt
    // does not need to explain rendering to the agent; it explains WHEN to
    // call the tool and what `text` should contain.
    expect(prompt).toContain("Call the `recap` tool");
    expect(prompt).toContain("`text`");

    // The prompt does not leak any rendering-level concept; the agent does
    // not need to know how we render its prose.
    expect(prompt).not.toMatch(/visible inline text/i);
    expect(prompt).not.toMatch(/visible prose/i);
    expect(prompt).not.toMatch(/thinking trace/i);

    // Concrete imperative triggers (when X, call Y) rather than descriptive
    // explanations — modelled after `Todo discipline` so models recognise it
    // as standard practice, not optional flavour.
    expect(prompt).toMatch(/immediately before each batch of related tool calls/i);
    expect(prompt).toMatch(/between work segments/i);
    expect(prompt).toMatch(/first tool in the parallel batch/i);

    // Explicit length budget.
    expect(prompt).toContain("8-12 words");

    // One-preamble-per-batch rule preserved.
    expect(prompt).toMatch(/one preamble per batch/i);

    // Narrow skip clause — only for a single trivial action.
    expect(prompt).toMatch(/single trivial action/i);

    // Tone phrase preserved.
    expect(prompt).toContain("light, friendly, and curious");
    expect(prompt).toContain("coding partner handing off work");

    // Concrete examples shown as actual `recap({ text: ... })` call sites,
    // including at least one parallel-batch shape that pairs `recap` with
    // another tool in the same message.
    expect(prompt).toContain("recap({ text:");
    expect(prompt).toMatch(/Example parallel batch/i);
    expect(prompt).toContain("Finished the renderer audit");

    // No `---` divider mandate anywhere in the prompt.
    expect(prompt).not.toContain("`---`");
  });

  test("renders the prose argument via renderCall, with an empty renderResult", () => {
    const host = createExtensionHost();
    recapExtension(host.api as any);
    const tool = host.getTool("recap");
    const theme = {
      fg: (_name: string, text: string) => text,
      italic: (text: string) => `*${text}*`,
      bold: (text: string) => text,
    };

    const prose = "checking how the renderer hooks into basic-tool grouping";
    const call = tool.renderCall({ text: prose }, theme, {});
    const callLines = call.render(120).join("\n");

    // The prose is what the user sees, with italic styling applied.
    expect(callLines).toContain(prose);
    expect(callLines).toContain(`*${prose}*`);

    // Result component is intentionally empty (renders to zero lines) so the
    // tool block doesn't duplicate the prose underneath.
    const result = { content: [{ type: "text", text: prose }] };
    const resultComponent = tool.renderResult(result, { expanded: false, isPartial: false }, theme, {});
    expect(resultComponent.render(120)).toEqual([]);
  });

  test("renderCall on empty text yields no visual output", () => {
    const host = createExtensionHost();
    recapExtension(host.api as any);
    const tool = host.getTool("recap");
    const theme = { fg: (_n: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t };

    const emptyCall = tool.renderCall({ text: "" }, theme, {});
    expect(emptyCall.render(120)).toEqual([]);

    const whitespaceCall = tool.renderCall({ text: "   " }, theme, {});
    expect(whitespaceCall.render(120)).toEqual([]);
  });
});

describe("recap + todo injection co-existence", () => {
  test("both extensions register a before_agent_start handler that contributes a systemPrompt", async () => {
    const todoExtension = (await import("../extensions/todo/index.ts")).default;
    const host = createExtensionHost();
    recapExtension(host.api as any);
    todoExtension(host.api as any);
    const handlers = host.handlers.get("before_agent_start") ?? [];
    expect(handlers.length).toBe(2);

    const prompts: string[] = [];
    for (const handler of handlers) {
      const result = await (handler as any)({});
      prompts.push(result.systemPrompt);
    }
    const recapPrompt = prompts.find((p) => p.includes("Recap discipline:"));
    const todoPrompt = prompts.find((p) => p.includes("Todo discipline:"));
    expect(recapPrompt).toBeDefined();
    expect(todoPrompt).toBeDefined();
    expect(recapPrompt).not.toContain("Todo discipline:");
    expect(todoPrompt).not.toContain("Recap discipline:");
  });
});
