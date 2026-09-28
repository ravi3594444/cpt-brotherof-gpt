import assert from "node:assert/strict";
import { test } from "node:test";
import { APICallError } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { continueAnswer, streamAnswer } from "../lib/answer.ts";
import { ResearchError } from "../lib/research.ts";
import { writerModel } from "../lib/research-job.ts";
import { serverConfig } from "../lib/server-config.ts";

// The research writer: with a vision model connected, the fast vision model writes the Answer after
// Research; the Answer model still answers directly and decides whether to research.
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
const reply = (text, think) => step(...(think ? thought("w", think) : []), ...textParts("t", [text]), finish("stop"));
const callsResearch = (task, id = "call-0") => step(
  ...thought("r", "This needs the web."),
  { type: "tool-call", toolCallId: id, toolName: "web_research", input: JSON.stringify({ task }) },
  finish("tool-calls"),
);
function mockModel(steps, decision = "RESEARCH") {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const next = steps[i++];
      if (!next) throw new Error("No more model steps");
      if (next instanceof Error) throw next;
      return next;
    },
    doGenerate: async () => ({
      content: [{ type: "text", text: decision }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [],
    }),
  });
}
const apiError = (statusCode, message) => new APICallError({
  message, url: "https://api.example.com/v1/chat/completions", requestBodyValues: {}, statusCode, isRetryable: false,
});
const sources = [{ title: "Fern care", url: "https://ferns.example/care", content: "Ferns like shade.", read: true }];
const ANSWER = "Ferns like shade [1](https://ferns.example/care).";
const common = { webEnabled: true, modelName: "Atria", photos: 0, photosToModel: 0, signal: new AbortController().signal };
async function answer({ question = "Find a fern for shade", research, ...options }) {
  const parts = [];
  await streamAnswer({
    ...common,
    messages: [{ role: "user", content: question }],
    question,
    writer: { write: (part) => parts.push(part) },
    research: research ?? (async () => ({ sources, engine: "kernel" })),
    ...options,
  });
  return parts;
}
const answerText = (parts) => parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");
const researchData = (parts) => parts.findLast((p) => p.type === "data-research")?.data;
const systemOf = (call) => call.prompt.find((m) => m.role === "system")?.content || "";
const writerName = "Sight Fast";

test("after research the fast writer writes the Answer, from the same conversation, tool call and result", async () => {
  const atria = mockModel([callsResearch("Ferns for shade")]);
  const fast = mockModel([reply(ANSWER, "Source 1 covers it.")]);
  const parts = await answer({ model: atria, researchWriter: { model: fast, name: writerName } });
  assert.equal(atria.doStreamCalls.length, 1, "the Answer model only decided to research");
  assert.equal(fast.doStreamCalls.length, 1);
  assert.equal(answerText(parts), ANSWER);
  const [call] = fast.doStreamCalls;
  assert.equal(call.maxOutputTokens, 6000);
  assert.deepEqual(call.toolChoice, { type: "none" });
  assert.deepEqual(call.tools?.map((t) => t.name), ["web_research"], "the tool stays defined next to its call");
  assert.deepEqual(call.prompt.filter((m) => m.role !== "system").map((m) => m.role), ["user", "assistant", "tool"]);
  assert.ok(!call.prompt.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "reasoning")),
    "the Answer model's thinking stays with the Answer model");
  assert.equal(call.prompt.find((m) => m.role === "tool").content[0].output.value[0].url, "https://ferns.example/care");
  assert.match(systemOf(call), /Cite factual statements/);
  assert.match(systemOf(call), /untrusted data/);
  assert.match(systemOf(call), /Never say you will do something later/);
  const data = researchData(parts);
  assert.equal(data.phase, "complete");
  assert.equal(data.steps.at(-1), "Sight Fast is writing the answer from the sources");
  assert.ok(parts.some((p) => p.type === "message-metadata" && p.messageMetadata.writer === writerName));
  // Its thinking shows like the Answer model's.
  assert.deepEqual(parts.filter((p) => p.type === "reasoning-delta").map((p) => p.delta), ["This needs the web.", "Source 1 covers it."]);
  assert.equal(parts.at(-1).type, "finish");
});

test("a direct answer is the Answer model's own, and the writer is never asked", async () => {
  const atria = mockModel([reply("Hi! How can I help?")]);
  const fast = mockModel([]);
  const parts = await answer({ model: atria, question: "hi", researchWriter: { model: fast, name: writerName } });
  assert.equal(answerText(parts), "Hi! How can I help?");
  assert.equal(fast.doStreamCalls.length, 0);
  assert.ok(!parts.some((p) => p.type === "message-metadata" && p.messageMetadata.writer));
});

test("when the writer fails before writing anything, the Answer model writes the Answer instead, once", async () => {
  const atria = mockModel([callsResearch("Ferns for shade"), reply(ANSWER)]);
  const fast = mockModel([apiError(503, "Service unavailable")]);
  const errors = console.error;
  console.error = () => {};
  let parts;
  try {
    parts = await answer({ model: atria, researchWriter: { model: fast, name: writerName } });
  } finally {
    console.error = errors;
  }
  assert.equal(fast.doStreamCalls.length, 1);
  assert.equal(atria.doStreamCalls.length, 2);
  assert.deepEqual(atria.doStreamCalls[1].toolChoice, { type: "none" });
  assert.equal(atria.doStreamCalls[1].maxOutputTokens, 16000);
  assert.equal(answerText(parts), ANSWER);
  const data = researchData(parts);
  assert.ok(data.steps.includes("Sight Fast could not write the answer, so Atria is writing it"), data.steps.join(" | "));
  assert.equal(parts.findLast((p) => p.type === "message-metadata" && p.messageMetadata.writer).messageMetadata.writer, "Atria");

  // An empty reply is a failure before writing too.
  const quiet = mockModel([step(finish("stop"))]);
  const fallback = mockModel([callsResearch("Ferns for shade"), reply(ANSWER)]);
  assert.equal(answerText(await answer({ model: fallback, researchWriter: { model: quiet, name: writerName } })), ANSWER);
});

test("a writer that fails after it started writing fails the Answer, with no second writer", async () => {
  const atria = mockModel([callsResearch("Ferns for shade"), reply("never reached")]);
  const fast = mockModel([step({ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Ferns like" },
    { type: "error", error: apiError(500, "Server error") })]);
  const errors = console.error;
  console.error = () => {};
  try {
    await assert.rejects(answer({ model: atria, researchWriter: { model: fast, name: writerName } }));
  } finally {
    console.error = errors;
  }
  assert.equal(atria.doStreamCalls.length, 1);
});

test("a writer whose output cap is lower gets the answer with the smaller limit", async () => {
  const atria = mockModel([callsResearch("Ferns for shade")]);
  const fast = mockModel([apiError(400, "Invalid max_tokens value, the valid range of max_tokens is [1, 4096]"), reply(ANSWER)]);
  const parts = await answer({ model: atria, researchWriter: { model: fast, name: writerName } });
  assert.deepEqual(fast.doStreamCalls.map((c) => c.maxOutputTokens), [6000, 4096]);
  assert.equal(answerText(parts), ANSWER);
});

test("after a failure the Answer model decides whether to retry, and the writer writes once research succeeds", async () => {
  let tries = 0;
  const research = async () => {
    if (!tries++) throw new ResearchError("Kernel could not read these pages.");
    return { sources, engine: "kernel" };
  };
  const atria = mockModel([callsResearch("ferns"), callsResearch("shade ferns", "call-1")]);
  const fast = mockModel([reply(ANSWER)]);
  const parts = await answer({ model: atria, research, researchWriter: { model: fast, name: writerName } });
  assert.equal(atria.doStreamCalls.length, 2);
  assert.deepEqual(atria.doStreamCalls[1].toolChoice, { type: "auto" }, "the Answer model may retry");
  assert.equal(fast.doStreamCalls.length, 1);
  assert.deepEqual(fast.doStreamCalls[0].prompt.filter((m) => m.role !== "system").map((m) => m.role),
    ["user", "assistant", "tool", "assistant", "tool"]);
  assert.equal(answerText(parts), ANSWER);
});

test("a failure that cannot be retried is explained by the writer", async () => {
  const research = async () => {
    throw new ResearchError("Kernel has insufficient credit.", { retryable: false });
  };
  const atria = mockModel([callsResearch("ferns")]);
  const fast = mockModel([reply("Research could not run, so this is not from sources.")]);
  const parts = await answer({ model: atria, research, researchWriter: { model: fast, name: writerName } });
  assert.equal(atria.doStreamCalls.length, 1);
  assert.equal(fast.doStreamCalls[0].prompt.find((m) => m.role === "tool").content[0].output.value.canRetry, false);
  assert.equal(researchData(parts).failed, true);
  assert.equal(answerText(parts), "Research could not run, so this is not from sources.");
});

test("in the plain-text fallback the writer answers from the evidence", async () => {
  const toolsUnsupported = new APICallError({
    message: "tools is not supported for this model", url: "https://api.example.com/v1/chat/completions",
    requestBodyValues: {}, statusCode: 400, isRetryable: false,
  });
  const atria = mockModel([toolsUnsupported], "RESEARCH");
  const fast = mockModel([reply(ANSWER)]);
  const parts = await answer({ model: atria, researchWriter: { model: fast, name: writerName } });
  assert.equal(fast.doStreamCalls[0].tools, undefined);
  assert.match(systemOf(fast.doStreamCalls[0]), /Retrieved evidence/);
  assert.match(systemOf(fast.doStreamCalls[0]), /https:\/\/ferns\.example\/care/);
  assert.equal(answerText(parts), ANSWER);
  // ANSWER is a direct answer: the Answer model writes it.
  const direct = mockModel([toolsUnsupported, reply("Hello!")], "ANSWER");
  const unused = mockModel([]);
  assert.equal(answerText(await answer({ model: direct, researchWriter: { model: unused, name: writerName } })), "Hello!");
  assert.equal(unused.doStreamCalls.length, 0);
});

const handoffState = () => ({
  attempts: 1, canRetry: false, researched: false, written: "", thoughts: 1, thinkingMs: 10, maxOutputTokens: 16000,
  data: { phase: "searching", queries: ["ferns"], sources: [], demo: false, steps: ["Atria started research: “ferns”"] },
});
const jobTurn = {
  mode: "tool",
  calls: [{ toolCallId: "c", task: "ferns", query: "ferns", depth: "quick" }],
  responseMessages: [{ role: "assistant", content: [
    { type: "reasoning", text: "Needs the web." },
    { type: "tool-call", toolCallId: "c", toolName: "web_research", input: { task: "ferns" } },
  ] }],
};
async function jobAnswer({ model, researchWriter, result = { finding: { sources, engine: "kernel" } }, mode = "tool" }) {
  const parts = [];
  const next = await continueAnswer({
    ...common,
    ...jobTurn,
    mode,
    ...(mode === "evidence" && { calls: [], responseMessages: [] }),
    model,
    researchWriter,
    messages: [{ role: "user", content: "Find a fern for shade" }],
    writer: { write: (part) => parts.push(part) },
    textId: "answer-1",
    state: handoffState(),
    result,
    finishMetadata: { job: { end: "done" } },
  });
  return { parts, next };
}

test("a Research job's answer step is written by the writer, and a retry decision stays with the Answer model", async () => {
  const atria = mockModel([]);
  const fast = mockModel([reply(ANSWER)]);
  const { parts, next } = await jobAnswer({ model: atria, researchWriter: { model: fast, name: writerName } });
  assert.equal(next, undefined);
  assert.equal(atria.doStreamCalls.length, 0);
  assert.equal(answerText(parts), ANSWER);
  assert.ok(!fast.doStreamCalls[0].prompt.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "reasoning")));
  assert.equal(researchData(parts).steps.at(-1), "Sight Fast is writing the answer from the sources");
  assert.deepEqual(parts.at(-1), { type: "finish", finishReason: "stop", messageMetadata: { job: { end: "done" } } });

  const retrying = mockModel([callsResearch("shade ferns", "call-1")]);
  const unused = mockModel([]);
  const retry = await jobAnswer({
    model: retrying, researchWriter: { model: unused, name: writerName },
    result: { error: { message: "Kernel could not read these pages.", retryable: true } },
  });
  assert.equal(retry.next.task, "shade ferns");
  assert.equal(unused.doStreamCalls.length, 0);

  const evidence = mockModel([reply(ANSWER)]);
  const fromEvidence = await jobAnswer({ model: mockModel([]), researchWriter: { model: evidence, name: writerName }, mode: "evidence" });
  assert.equal(answerText(fromEvidence.parts), ANSWER);
  assert.match(systemOf(evidence.doStreamCalls[0]), /Retrieved evidence/);
});

test("without a writer the Answer model writes after research, as before", async () => {
  const atria = mockModel([]);
  const { parts } = await jobAnswer({ model: mockModel([reply(ANSWER)]) });
  assert.equal(answerText(parts), ANSWER);
  assert.equal(atria.doStreamCalls.length, 0);
  assert.equal(researchData(parts).steps.at(-1), "Atria is writing the answer from the sources");
});

test("the writer is the connected vision model, unless RESEARCH_WRITER=answer, and never in test mode", () => {
  const env = { MODEL_ID: "m", VISION_MODEL_ID: "vision/sight-fast-2.1", AIMLAPI_API_KEY: "aiml" };
  const writer = writerModel(serverConfig(env));
  assert.equal(writer.name, "Sight Fast 2.1");
  assert.equal(writer.model.modelId, "vision/sight-fast-2.1");
  assert.equal(serverConfig(env).researchWriter, "vision");
  for (const off of ["answer", "Answer", " answer "]) {
    assert.equal(serverConfig({ ...env, RESEARCH_WRITER: off }).researchWriter, "answer");
    assert.equal(writerModel(serverConfig({ ...env, RESEARCH_WRITER: off })), undefined, off);
  }
  assert.equal(writerModel(serverConfig({ MODEL_ID: "m", AIMLAPI_API_KEY: "aiml" })), undefined, "no vision model");
  assert.equal(writerModel(serverConfig({ ...env, SCOUT_TEST_MODE: "1" })), undefined);
  assert.equal(writerModel(serverConfig({ ...env, VISION_MODEL_BASE_URL: "http://insecure.example.com/v1" })), undefined);
});
