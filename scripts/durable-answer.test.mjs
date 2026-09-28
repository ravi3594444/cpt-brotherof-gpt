import assert from "node:assert/strict";
import { test } from "node:test";
import { APICallError } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { continueAnswer, newAnswerState, streamAnswer } from "../lib/answer.ts";
import { ResearchError } from "../lib/research.ts";

// Durable research: the request hands the turn to a Research job at the research call, and the
// job's answer step carries on from the saved state.
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
const reply = (...deltas) => ({ stream: convertArrayToReadableStream([...textParts("t", deltas), finish("stop")]) });
const callsResearch = (tasks, { before, think } = {}) => ({
  stream: convertArrayToReadableStream([
    ...(think ? thought("r", think) : []),
    ...(before ? textParts("p", [before]) : []),
    ...tasks.map((task, i) => ({
      type: "tool-call", toolCallId: `call-${i}`, toolName: "web_research", input: JSON.stringify({ task }),
    })),
    finish("tool-calls"),
  ]),
});
function mockModel(steps, decision) {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[i++];
      if (!step) throw new Error("No more model steps");
      if (step instanceof Error) throw step;
      return step;
    },
    doGenerate: async () => ({
      content: [{ type: "text", text: decision ?? "" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [],
    }),
  });
}
const sources = [
  { title: "Fern care", url: "https://ferns.example/care", content: "Ferns like shade and damp soil.", read: true },
  { title: "Balcony plants", url: "https://plants.example/balcony", content: "Many ferns grow well on shady balconies." },
];
const common = {
  webEnabled: true,
  modelName: "Atria",
  photos: 0,
  photosToModel: 0,
  signal: new AbortController().signal,
};
// The request's side: returns what it streamed and the hand-off it made.
async function request({ question = "Find a fern for my shady balcony", model, research, ...options }) {
  const parts = [];
  let handoff;
  await streamAnswer({
    ...common,
    messages: [{ role: "user", content: question }],
    question,
    model,
    research: research ?? (async () => assert.fail("durable mode never researches in the request")),
    writer: { write: (part) => parts.push(part) },
    handoff: async (h) => {
      handoff = structuredClone(h);
    },
    ...options,
  });
  return { parts, handoff };
}
// The job's answer step.
async function jobAnswer({ handoff, result, model, question = "Find a fern for my shady balcony", textId = "answer-1", ...options }) {
  const parts = [];
  const next = await continueAnswer({
    ...common,
    model,
    messages: [{ role: "user", content: question }],
    mode: handoff.mode,
    calls: handoff.calls,
    responseMessages: handoff.responseMessages,
    state: handoff.state,
    result,
    textId,
    writer: { write: (part) => parts.push(part) },
    ...options,
  });
  return { parts, next };
}
const answerText = (parts) => parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");
const researchData = (parts) => parts.findLast((p) => p.type === "data-research")?.data;
const toolOutputs = (call) =>
  call.prompt.filter((m) => m.role === "tool").flatMap((m) => m.content).map((p) => p.output.value);

test("in durable mode a research call hands the rest of the turn to the job, without researching in the request", async () => {
  const model = mockModel([callsResearch(["Ferns that suit a shady balcony"], { think: "They want a plant." })]);
  const { parts, handoff } = await request({ model });
  assert.equal(model.doStreamCalls.length, 1);
  assert.equal(handoff.mode, "tool");
  assert.equal(handoff.task, "Ferns that suit a shady balcony");
  assert.deepEqual(handoff.calls, [
    { toolCallId: "call-0", task: "Ferns that suit a shady balcony", query: "Ferns that suit a shady balcony", depth: "quick" },
  ]);
  assert.equal(handoff.query, "Ferns that suit a shady balcony");
  assert.equal(handoff.depth, "quick");
  assert.deepEqual(handoff.responseMessages.map((m) => m.role), ["assistant"]);
  assert.ok(handoff.responseMessages[0].content.some((p) => p.type === "tool-call" && p.toolCallId === "call-0"));
  // The request streamed the thinking and the start of research, and no finish: the job writes that.
  assert.deepEqual(parts.map((p) => p.type), [
    "reasoning-start", "reasoning-delta", "message-metadata", "reasoning-end", "data-research",
  ]);
  const data = researchData(parts);
  assert.equal(data.phase, "searching");
  assert.deepEqual(data.steps, ["Atria started research: “Ferns that suit a shady balcony”"]);
  assert.equal(handoff.state.attempts, 1);
  assert.equal(handoff.state.thoughts, 1);
  assert.deepEqual(handoff.state.data, data);
});

test("in durable mode a message that needs no research is answered in the request and never handed off", async () => {
  const model = mockModel([reply("Hi! ", "How can I help?")]);
  const { parts, handoff } = await request({ model, question: "hi" });
  assert.equal(handoff, undefined);
  assert.equal(answerText(parts), "Hi! How can I help?");
  assert.equal(parts.at(-1).type, "finish");
  assert.ok(!parts.some((p) => p.type === "data-research"));
});

test("text before the research call moves into Thinking at the hand-off, and the job's answer starts clean", async () => {
  const { parts, handoff } = await request({ model: mockModel([callsResearch(["ferns"], { before: "Let me look that up." })]) });
  const reset = parts.findIndex((p) => p.type === "reset-step");
  assert.ok(reset > 0, "the words that streamed are taken back");
  assert.ok(!parts.slice(reset).some((p) => p.type.startsWith("text-")));
  assert.deepEqual(parts.slice(reset).filter((p) => p.type === "reasoning-delta").map((p) => p.delta), ["Let me look that up."]);
  assert.equal(handoff.state.written, "");
  const model = mockModel([reply("Most ferns like shade [1](https://ferns.example/care).")]);
  const job = await jobAnswer({ handoff, model, result: { finding: { sources, engine: "kernel" } } });
  assert.equal(job.next, undefined);
  assert.deepEqual(job.parts.filter((p) => p.type.startsWith("text-")).map((p) => [p.type, p.id]),
    [["text-start", "answer-1"], ["text-delta", "answer-1"], ["text-end", "answer-1"]]);
  assert.equal(answerText(job.parts), "Most ferns like shade [1](https://ferns.example/care).");
});

test("the job's answer step gives the model the evidence for its call and cannot research again after success", async () => {
  const { handoff } = await request({ model: mockModel([callsResearch(["ferns"])]) });
  const model = mockModel([reply("Most ferns like shade [1](https://ferns.example/care).")]);
  const { parts, next } = await jobAnswer({ handoff, model, result: { finding: { sources, engine: "kernel" } } });
  assert.equal(next, undefined);
  const [call] = model.doStreamCalls;
  assert.deepEqual(call.tools?.map((t) => t.name), ["web_research"], "the tool stays defined next to its call");
  assert.deepEqual(call.toolChoice, { type: "none" });
  assert.match(call.prompt.find((m) => m.role === "system").content, /Never say you will do something later/);
  assert.deepEqual(call.prompt.filter((m) => m.role !== "system").map((m) => m.role), ["user", "assistant", "tool"]);
  assert.deepEqual(toolOutputs(call)[0].map((s) => [s.number, s.url, s.kind]), [
    [1, "https://ferns.example/care", "page content"],
    [2, "https://plants.example/balcony", "search excerpt"],
  ]);
  const data = researchData(parts);
  assert.equal(data.phase, "complete");
  assert.equal(data.engine, "kernel");
  assert.equal(data.steps.at(-1), "Atria is writing the answer from the sources");
  assert.deepEqual(parts.filter((p) => p.type === "source-url").map((p) => p.url), sources.map((s) => s.url));
  assert.deepEqual(parts.at(-1), { type: "finish", finishReason: "stop" });
});

test("two research calls in one step: the job researches once and the second call is told research is already running", async () => {
  const { handoff } = await request({ model: mockModel([callsResearch(["ferns", "more ferns"])]) });
  assert.equal(handoff.calls.length, 2);
  const model = mockModel([reply("Ferns [1](https://ferns.example/care).")]);
  await jobAnswer({ handoff, model, result: { finding: { sources, engine: "kernel" } } });
  const [evidence, again] = toolOutputs(model.doStreamCalls[0]);
  assert.equal(evidence.length, 2);
  assert.match(again.error, /already/);
});

test("in the job a quick failure may be retried once, with no time limit, and the retry call goes back to the job", async () => {
  const timedOut = new ResearchError("Browser Use Cloud stopped responding. Try again or choose Kernel.");
  const { handoff } = await request({ model: mockModel([callsResearch(["shirts on shein"])]) });
  const retryModel = mockModel([callsResearch(["linen shirts on shein.com"], { think: "Try a narrower task." })]);
  const first = await jobAnswer({
    handoff, model: retryModel, result: { error: { message: timedOut.message, retryable: true } },
  });
  const [failure] = toolOutputs(retryModel.doStreamCalls[0]);
  assert.equal(failure.error, timedOut.message);
  assert.equal(failure.canRetry, true);
  assert.equal("secondsLeft" in failure, false, "a Research job has no ceiling to count down to");
  assert.deepEqual(retryModel.doStreamCalls[0].toolChoice, { type: "auto" });
  assert.equal(first.next.task, "linen shirts on shein.com");
  assert.deepEqual(first.next.calls, [{ toolCallId: "call-0", task: "linen shirts on shein.com", query: "linen shirts on shein.com", depth: "quick" }]);
  assert.deepEqual(first.next.responseMessages.map((m) => m.role), ["assistant", "tool", "assistant"]);
  assert.ok(!first.parts.some((p) => p.type === "finish"));
  const retried = researchData(first.parts);
  assert.equal(retried.phase, "searching");
  assert.deepEqual(retried.queries, ["shirts on shein", "linen shirts on shein.com"]);
  assert.equal(retried.steps.at(-1), "Atria started research again: “linen shirts on shein.com”");
  assert.equal(first.next.state.attempts, 2);

  const model = mockModel([reply("The linen shirt rates best [1](https://ferns.example/care).")]);
  const second = await jobAnswer({
    handoff: first.next, model, textId: "answer-2", result: { finding: { sources, engine: "kernel" } },
  });
  assert.equal(second.next, undefined);
  assert.deepEqual(model.doStreamCalls[0].toolChoice, { type: "none" });
  assert.deepEqual(model.doStreamCalls[0].prompt.filter((m) => m.role !== "system").map((m) => m.role),
    ["user", "assistant", "tool", "assistant", "tool"]);
  assert.equal(researchData(second.parts).phase, "complete");
  assert.equal(second.parts.at(-1).type, "finish");
});

test("in the job a failure that would repeat is not retried, and a second failure is final", async () => {
  const { handoff } = await request({ model: mockModel([callsResearch(["shirts"])]) });
  const model = mockModel([reply("Browser Use Cloud has no credit, so this is not from sources.")]);
  const { parts } = await jobAnswer({
    handoff, model, result: { error: { message: "Browser Use Cloud has insufficient credit.", retryable: false } },
  });
  const [output] = toolOutputs(model.doStreamCalls[0]);
  assert.equal(output.canRetry, false);
  assert.match(output.retry, /cannot run again/);
  assert.deepEqual(model.doStreamCalls[0].toolChoice, { type: "none" });
  assert.equal(researchData(parts).failed, true);
  assert.equal(parts.at(-1).type, "finish");
});

test("an unexpected research failure in the job gets the plain message", async () => {
  const { handoff } = await request({ model: mockModel([callsResearch(["ferns"])]) });
  const model = mockModel([reply("Research failed.")]);
  await jobAnswer({ handoff, model, result: { error: { retryable: true } } });
  assert.equal(toolOutputs(model.doStreamCalls[0])[0].error, "Research could not be completed. Please try again.");
});

test("the job keeps the request's Thinking numbering and time", async () => {
  const { parts: before, handoff } = await request({ model: mockModel([callsResearch(["ferns"], { think: "A plant." })]) });
  const ms = before.find((p) => p.type === "message-metadata").messageMetadata.thinkingMs;
  const model = mockModel([{
    stream: convertArrayToReadableStream([...thought("x", "Now the answer."), ...textParts("t", ["Ferns."]), finish("stop")]),
  }]);
  const { parts } = await jobAnswer({ handoff, model, result: { finding: { sources, engine: "kernel" } } });
  assert.deepEqual(parts.filter((p) => p.type === "reasoning-start").map((p) => p.id), ["thinking-2"]);
  assert.ok(parts.find((p) => p.type === "message-metadata").messageMetadata.thinkingMs >= ms);
});

test("a provider that rejects tools: durable mode hands off in evidence mode, and the job answers without tools", async () => {
  const toolsUnsupported = new APICallError({
    message: "tools is not supported for this model",
    url: "https://api.example.com/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: '{"error":{"message":"tools is not supported for this model"}}',
    isRetryable: false,
  });
  const { handoff } = await request({ model: mockModel([toolsUnsupported], "RESEARCH"), question: "ferns for shade" });
  assert.equal(handoff.mode, "evidence");
  assert.equal(handoff.task, "ferns for shade");
  assert.deepEqual(handoff.calls, []);
  const model = mockModel([reply("Ferns like shade [1](https://ferns.example/care).")]);
  const { parts } = await jobAnswer({ handoff, model, question: "ferns for shade", result: { finding: { sources, engine: "kernel" } } });
  const [call] = model.doStreamCalls;
  assert.equal(call.tools, undefined);
  assert.match(call.prompt.find((m) => m.role === "system").content, /Retrieved evidence/);
  assert.equal(researchData(parts).phase, "complete");
});

test("an empty answer in the job is an error, like in the request", async () => {
  const { handoff } = await request({ model: mockModel([callsResearch(["ferns"])]) });
  const model = mockModel([{ stream: convertArrayToReadableStream([finish("stop")]) }]);
  await assert.rejects(jobAnswer({ handoff, model, result: { finding: { sources, engine: "kernel" } } }), ResearchError);
});

test("the job's answer can finish with extra message metadata", async () => {
  const { handoff } = await request({ model: mockModel([callsResearch(["ferns"])]) });
  const { parts } = await jobAnswer({
    handoff, model: mockModel([reply("Ferns.")]), result: { finding: { sources, engine: "kernel" } },
    finishMetadata: { job: { end: "done" } },
  });
  assert.deepEqual(parts.at(-1), { type: "finish", finishReason: "stop", messageMetadata: { job: { end: "done" } } });
});

test("a fresh answer state starts with no research and the full output limit", () => {
  assert.deepEqual(newAnswerState(), {
    attempts: 0, canRetry: false, researched: false, written: "", thoughts: 0, thinkingMs: 0, maxOutputTokens: 16000,
  });
});
