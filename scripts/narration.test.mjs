import assert from "node:assert/strict";
import { test } from "node:test";
import { readUIMessageStream } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { continueAnswer, streamAnswer } from "../lib/answer.ts";
import { compactChunks } from "../lib/job-stream.ts";
import { ResearchError } from "../lib/research.ts";

// Narration: what the Answer model writes before it calls the Research tool ("I'll research…",
// "Let me retry…") is not the Answer. It moves into Thinking; the Answer is what comes after research.
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const finish = (reason) => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
const textParts = (id, deltas) => [
  { type: "text-start", id },
  ...deltas.map((delta) => ({ type: "text-delta", id, delta })),
  { type: "text-end", id },
];
const thought = (id, text) => [
  { type: "reasoning-start", id },
  { type: "reasoning-delta", id, delta: text },
  { type: "reasoning-end", id },
];
const step = (...parts) => ({ stream: convertArrayToReadableStream(parts) });
// A research call as providers stream it: the call's input starts, then the whole call.
const researchCall = (task, id = "call-0") => [
  { type: "tool-input-start", id, toolName: "web_research" },
  { type: "tool-input-delta", id, delta: JSON.stringify({ task }) },
  { type: "tool-input-end", id },
  { type: "tool-call", toolCallId: id, toolName: "web_research", input: JSON.stringify({ task }) },
];
function mockModel(steps) {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const next = steps[i++];
      if (!next) throw new Error("No more model steps");
      return next;
    },
  });
}
const sources = [{ title: "Fern care", url: "https://ferns.example/care", content: "Ferns like shade.", read: true }];
const common = {
  webEnabled: true,
  modelName: "Atria",
  photos: 0,
  photosToModel: 0,
  signal: new AbortController().signal,
};
async function answer({ question = "How do AI agents search the web?", ...options }) {
  const parts = [];
  let handoff;
  await streamAnswer({
    ...common,
    messages: [{ role: "user", content: question }],
    question,
    writer: { write: (part) => parts.push(part) },
    research: async () => ({ sources, engine: "kernel" }),
    ...options,
    ...(options.handoff && { handoff: async (h) => { handoff = structuredClone(h); } }),
  });
  return { parts, handoff };
}
/** The message the app ends up with, as the AI SDK's own client builds it from the chunks. */
async function shown(parts, before = []) {
  let message;
  const stream = convertArrayToReadableStream([{ type: "start", messageId: "m" }, ...before, ...parts]);
  for await (const snapshot of readUIMessageStream({ stream, terminateOnError: true })) message = snapshot;
  return {
    text: message.parts.filter((p) => p.type === "text").map((p) => p.text).join(""),
    thinking: message.parts.filter((p) => p.type === "reasoning").map((p) => p.text),
    types: message.parts.map((p) => p.type),
    message,
  };
}
const NARRATION = "I'll research the current landscape of how AI agents search the web.";
const ANSWER = "Agents search with a browser [1](https://ferns.example/care).";

test("text before a research call becomes Thinking, and the Answer holds only what was written after research", async () => {
  const model = mockModel([
    step(...thought("r", "The user wants current facts."), ...textParts("t", ["I'll research ", "the current landscape of how AI agents search the web."]),
      ...researchCall("How AI agents search the web"), finish("tool-calls")),
    step(...textParts("t", [ANSWER]), finish("stop")),
  ]);
  const { parts } = await answer({ model });
  const view = await shown(parts);
  assert.equal(view.text, ANSWER);
  assert.deepEqual(view.thinking, ["The user wants current facts.", NARRATION]);
  // Thinking stays above the research panel, and the answer's words come after it.
  assert.deepEqual(view.types.filter((t) => t !== "source-url"), ["reasoning", "reasoning", "data-research", "text"]);
  assert.equal(view.message.parts.find((p) => p.type === "data-research").data.phase, "complete");
  assert.ok(parts.some((p) => p.type === "reset-step"), "the narration that already streamed is taken back");
  assert.equal(parts.at(-1).type, "finish");
  // The next turn never sees the narration as the Answer.
  const [, second] = model.doStreamCalls;
  assert.ok(second.prompt.some((m) => m.role === "tool"));
});

test("a direct answer streams as it comes, with nothing taken back", async () => {
  const model = mockModel([step(...textParts("t", ["Hi! ", "How can I help?"]), finish("stop"))]);
  const { parts } = await answer({ model, question: "hi" });
  assert.deepEqual(parts.map((p) => p.type), ["text-start", "text-delta", "text-delta", "text-end", "finish"]);
  assert.equal((await shown(parts)).text, "Hi! How can I help?");
});

test("text after research in a step that cannot research again stays the Answer, even next to a stray call", async () => {
  const model = mockModel([
    step(...researchCall("ferns"), finish("tool-calls")),
    step(...textParts("t", [ANSWER]), ...researchCall("more ferns", "call-1"), finish("tool-calls")),
  ]);
  const { parts } = await answer({ model });
  assert.equal((await shown(parts)).text, ANSWER);
  assert.ok(!parts.some((p) => p.type === "reset-step"));
});

test("a retry's narration becomes Thinking too, and the failed research stays in the panel", async () => {
  let tries = 0;
  const research = async () => {
    if (!tries++) throw new ResearchError("Kernel could not read these pages.");
    return { sources, engine: "kernel" };
  };
  const model = mockModel([
    step(...textParts("t", [NARRATION]), ...researchCall("AI agents web search"), finish("tool-calls")),
    step(...thought("r", "Try a narrower task."), ...textParts("t", ["The research hit a technical error. Let me retry with a narrower focus."]),
      ...researchCall("AI agent browsing tools", "call-1"), finish("tool-calls")),
    step(...textParts("t", [ANSWER]), finish("stop")),
  ]);
  const { parts } = await answer({ model, research });
  const view = await shown(parts);
  assert.equal(view.text, ANSWER);
  assert.deepEqual(view.thinking, [NARRATION, "Try a narrower task.", "The research hit a technical error. Let me retry with a narrower focus."]);
  const data = view.message.parts.find((p) => p.type === "data-research").data;
  assert.equal(data.phase, "complete");
  assert.ok(data.steps.some((s) => s.startsWith("Research did not finish")));
  assert.equal(view.types.filter((t) => t === "data-research").length, 1);
});

test("in durable mode the narration is Thinking in what the job sends again, and the job's answer starts clean", async () => {
  const model = mockModel([step(...textParts("t", [NARRATION]), ...researchCall("How AI agents search the web"), finish("tool-calls"))]);
  const { parts, handoff } = await answer({ model, handoff: true });
  assert.equal(handoff.state.written, "");
  const prefix = compactChunks(parts);
  assert.ok(!prefix.some((c) => c.type === "reset-step" || c.type.startsWith("text-")), JSON.stringify(prefix.map((c) => c.type)));
  assert.deepEqual((await shown(prefix)).thinking, [NARRATION]);
  assert.deepEqual(await shown(prefix).then((v) => v.types), (await shown(parts)).types, "the replay shows what the app showed");

  const job = [];
  await continueAnswer({
    ...common,
    model: mockModel([step(...textParts("t", [ANSWER]), finish("stop"))]),
    messages: [{ role: "user", content: "How do AI agents search the web?" }],
    writer: { write: (part) => job.push(part) },
    textId: "answer-1",
    mode: handoff.mode,
    calls: handoff.calls,
    responseMessages: handoff.responseMessages,
    state: handoff.state,
    result: { finding: { sources, engine: "kernel" } },
  });
  const view = await shown([{ type: "start-step" }, ...job], prefix);
  assert.equal(view.text, ANSWER, "no blank line where the narration was");
  assert.deepEqual(view.thinking, [NARRATION]);
});

test("in a Research job a retry's narration becomes Thinking, and the research so far stays", async () => {
  const model = mockModel([step(...textParts("t", ["Let me retry with a narrower focus."]), ...researchCall("AI agent browsing tools"), finish("tool-calls"))]);
  const job = [];
  const before = [
    { type: "data-research", id: "research", data: { phase: "searching", queries: ["q"], sources: [], demo: false, steps: ["Atria started research: “q”"] } },
    { type: "start-step" },
  ];
  const next = await continueAnswer({
    ...common,
    model,
    messages: [{ role: "user", content: "q" }],
    writer: { write: (part) => job.push(part) },
    textId: "answer-1",
    mode: "tool",
    calls: [{ toolCallId: "c", task: "q", query: "q", depth: "quick" }],
    responseMessages: [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "web_research", input: { task: "q" } }] }],
    state: {
      attempts: 1, canRetry: false, researched: false, written: "", thoughts: 0, thinkingMs: 0, maxOutputTokens: 16000,
      data: before[0].data,
    },
    result: { error: { message: "Kernel could not read these pages.", retryable: true } },
  });
  assert.equal(next.task, "AI agent browsing tools");
  assert.equal(next.state.written, "");
  const view = await shown(job, before);
  assert.equal(view.text, "");
  assert.deepEqual(view.thinking, ["Let me retry with a narrower focus."]);
  const data = view.message.parts.find((p) => p.type === "data-research").data;
  assert.deepEqual(data.queries, ["q", "AI agent browsing tools"]);
});
