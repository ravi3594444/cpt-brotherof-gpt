import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { streamAnswer } from "../lib/answer.ts";
import { capThinking, MAX_SAVED_THINKING, modelConversation, requestTurns } from "../lib/conversation.ts";
import { ResearchError } from "../lib/research.ts";
import { webResearch } from "../lib/web-research.ts";

// Thinking: the Answer model's own reasoning, streamed to the reader as reasoning parts.

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const finish = (reason = "stop") => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
const textParts = (id, deltas) => [
  { type: "text-start", id },
  ...deltas.map((delta) => ({ type: "text-delta", id, delta })),
  { type: "text-end", id },
];
const reasoningParts = (id, deltas) => [
  { type: "reasoning-start", id },
  ...deltas.map((delta) => ({ type: "reasoning-delta", id, delta })),
  { type: "reasoning-end", id },
];
const step = (...parts) => ({ stream: convertArrayToReadableStream(parts) });
const researchCall = (task) => ({
  type: "tool-call", toolCallId: "call-0", toolName: "web_research", input: JSON.stringify({ task }),
});
function mockModel(steps, decision = "") {
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
const sources = [{ title: "Fern care", url: "https://ferns.example/care", content: "Ferns like shade.", read: true }];
const research = async (task, signal, progress) => {
  progress.update({ phase: "reading", engine: "kernel" });
  return { sources, engine: "kernel" };
};
async function answer(options) {
  const parts = [];
  await streamAnswer({
    messages: [{ role: "user", content: "hey" }],
    question: "hey",
    webEnabled: true,
    research,
    modelName: "Atria",
    photos: 0,
    photosToModel: 0,
    signal: new AbortController().signal,
    writer: { write: (part) => parts.push(part) },
    ...options,
  });
  return parts;
}
const answerText = (parts) => parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");
// Each reasoning part's text, in the order the parts started.
function thoughts(parts) {
  const texts = new Map();
  for (const p of parts) {
    if (p.type === "reasoning-start") {
      assert.ok(!texts.has(p.id), `reasoning part ${p.id} started twice`);
      texts.set(p.id, "");
    } else if (p.type === "reasoning-delta") {
      assert.ok(texts.has(p.id), `reasoning-delta before reasoning-start for ${p.id}`);
      texts.set(p.id, texts.get(p.id) + p.delta);
    }
  }
  return [...texts.values()];
}
// Every reasoning part that started also ended, after its last delta.
function allClosed(parts) {
  const open = new Set();
  for (const p of parts) {
    if (p.type === "reasoning-start") open.add(p.id);
    else if (p.type === "reasoning-delta") assert.ok(open.has(p.id), `delta after end for ${p.id}`);
    else if (p.type === "reasoning-end") open.delete(p.id);
  }
  return open.size === 0;
}
const thinkingMs = (parts) => parts.filter((p) => p.type === "message-metadata").map((p) => p.messageMetadata.thinkingMs);
const toolsUnsupported = () => new APICallError({
  message: "tools is not supported for this model",
  url: "https://api.example.com/v1/chat/completions",
  requestBodyValues: {},
  statusCode: 400,
  isRetryable: false,
});

test("a reasoning model's thinking streams as a reasoning part before its direct answer", async () => {
  const model = mockModel([step(
    ...reasoningParts("r", ["The user says hi.", "\nNo research needed."]),
    ...textParts("t", ["Hi! ", "How can I help?"]),
    finish(),
  )]);
  const parts = await answer({ model });
  assert.deepEqual(thoughts(parts), ["The user says hi.\nNo research needed."]);
  assert.equal(answerText(parts), "Hi! How can I help?");
  assert.ok(allClosed(parts));
  assert.deepEqual(parts.map((p) => p.type), [
    "reasoning-start", "reasoning-delta", "reasoning-delta", "message-metadata", "reasoning-end",
    "text-start", "text-delta", "text-delta", "text-end", "finish",
  ]);
  const [ms] = thinkingMs(parts);
  assert.ok(Number.isFinite(ms) && ms >= 0, String(ms));
  assert.ok(!parts.some((p) => p.type === "data-research"));
});

test("an OpenAI-compatible provider's reasoning_content streams as thinking", async () => {
  const chunk = (delta, finishReason = null) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  const body = [
    chunk({ role: "assistant", reasoning_content: "The user says hi." }),
    chunk({ reasoning_content: " No web needed." }),
    chunk({ content: "Hi! How can I help?" }),
    chunk({}, "stop"),
    "data: [DONE]\n\n",
  ].join("");
  const requests = [];
  const provider = createOpenAICompatible({
    name: "test",
    baseURL: "https://api.example.com/v1",
    apiKey: "k",
    fetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const parts = await answer({ model: provider("m") });
  assert.deepEqual(thoughts(parts), ["The user says hi. No web needed."]);
  assert.equal(answerText(parts), "Hi! How can I help?");
  assert.ok(allClosed(parts));
  assert.equal(requests[0].max_tokens, 16000);
});

test("the answer has room for a reasoning model to think: 16000 output tokens", async () => {
  const model = mockModel([step(...textParts("t", ["Hi!"]), finish())]);
  await answer({ model });
  assert.equal(model.doStreamCalls[0].maxOutputTokens, 16000);
});

test("thinking before and after a research call streams as two reasoning parts around the research", async () => {
  const model = mockModel([
    step(...reasoningParts("reasoning-0", ["The user wants a fern; I should research."]), researchCall("shade ferns"), finish("tool-calls")),
    step(...reasoningParts("reasoning-0", ["The source says ferns like shade."]), ...textParts("t", ["Ferns like shade [1](https://ferns.example/care)."]), finish()),
  ]);
  const parts = await answer({ model, question: "Find a fern for shade" });
  assert.deepEqual(thoughts(parts), ["The user wants a fern; I should research.", "The source says ferns like shade."]);
  assert.ok(allClosed(parts));
  const starts = parts.flatMap((p, i) => (p.type === "reasoning-start" ? [i] : []));
  const research = parts.findIndex((p) => p.type === "data-research");
  const cited = parts.findIndex((p) => p.type === "source-url");
  assert.ok(starts[0] < research, "the first thought comes before the research");
  assert.ok(starts[1] > cited, "the second thought comes after the research found its sources");
  const [first, second] = parts.filter((p) => p.type === "reasoning-start").map((p) => p.id);
  assert.notEqual(first, second, "each thought has its own id, even when the provider reuses one");
  const totals = thinkingMs(parts);
  assert.equal(totals.length, 2);
  assert.ok(totals[1] >= totals[0], JSON.stringify(totals));
  assert.equal(answerText(parts), "Ferns like shade [1](https://ferns.example/care).");
  assert.equal(parts.at(-1).type, "finish");
});

test("the plain-text fallback streams the answer's thinking", async () => {
  const model = mockModel([
    toolsUnsupported(),
    step(...reasoningParts("r", ["Just a greeting."]), ...textParts("t", ["Hello!"]), finish()),
  ], "ANSWER");
  const parts = await answer({ model });
  assert.equal(model.doStreamCalls[1].tools, undefined);
  assert.deepEqual(thoughts(parts), ["Just a greeting."]);
  assert.ok(allClosed(parts));
  assert.equal(answerText(parts), "Hello!");
});

test("with Search the web off, thinking still streams", async () => {
  const model = mockModel([step(...reasoningParts("r", ["A poem about ferns."]), ...textParts("t", ["Ferns unfurl."]), finish())]);
  const parts = await answer({ model, webEnabled: false });
  assert.equal(model.doStreamCalls[0].tools, undefined);
  assert.deepEqual(thoughts(parts), ["A poem about ferns."]);
  assert.equal(answerText(parts), "Ferns unfurl.");
});

test("a <think> block that opens the answer text becomes thinking, even with its tags split across chunks", async () => {
  const model = mockModel([step(
    ...textParts("t", ["<thi", "nk>The user", " says hi.</th", "ink>\n\nHi! ", "How can I help?"]),
    finish(),
  )]);
  const parts = await answer({ model });
  assert.deepEqual(thoughts(parts), ["The user says hi."]);
  assert.equal(answerText(parts), "Hi! How can I help?");
  assert.ok(allClosed(parts));
});

test("a <think> block after leading whitespace, and one in the answer step after research, become thinking", async () => {
  const model = mockModel([
    step(...textParts("t", ["\n", "<think>\nNeeds the web.\n</think>"]), researchCall("ferns"), finish("tool-calls")),
    step(...textParts("t", ["<thinking>Use source 1.</thinking>", "Ferns like shade [1](https://ferns.example/care)."]), finish()),
  ]);
  const parts = await answer({ model });
  assert.deepEqual(thoughts(parts).map((t) => t.trim()), ["Needs the web.", "Use source 1."]);
  assert.equal(answerText(parts), "Ferns like shade [1](https://ferns.example/care).");
});

test("an unterminated <think> block never reaches the answer", async () => {
  const model = mockModel([step(...textParts("t", ["<think>The user", " says hi and I should"]), finish("length"))]);
  const parts = [];
  await assert.rejects(answer({ model, writer: { write: (part) => parts.push(part) } }), ResearchError);
  assert.deepEqual(thoughts(parts), ["The user says hi and I should"]);
  assert.ok(allClosed(parts), "the thought is closed so it shows as finished");
  assert.equal(answerText(parts), "");
});

test("a think tag later in the answer stays in the answer", async () => {
  const model = mockModel([step(...textParts("t", ["Models such as R1 wrap reasoning in `<think>` tags."]), finish())]);
  const parts = await answer({ model });
  assert.deepEqual(thoughts(parts), []);
  assert.equal(answerText(parts), "Models such as R1 wrap reasoning in `<think>` tags.");
});

test("a model that runs out of room while thinking says so", async () => {
  const model = mockModel([step(...reasoningParts("r", ["Thinking a lot"]), finish("length"))]);
  await assert.rejects(answer({ model }), (error) => error instanceof ResearchError && /ran out of room/.test(error.message));
});

// ---- History ----

const reasoning = (text, state = "done") => ({ type: "reasoning", text, state });

test("thinking kept in history is never sent back to the model", () => {
  const history = [
    { id: "1", role: "user", parts: [{ type: "text", text: "Hi" }] },
    { id: "2", role: "assistant", parts: [{ type: "step-start" }, reasoning("The user says hi."), { type: "text", text: "Hello!" }] },
    { id: "3", role: "user", parts: [{ type: "text", text: "Find ferns" }] },
  ];
  const sent = requestTurns(history);
  assert.deepEqual(sent.map((t) => t.parts.map((p) => p.type)), [["text"], ["text"], ["text"]]);
  // Even if a client sends it, the model's view has no thinking.
  const { messages } = modelConversation(history);
  assert.deepEqual(messages, [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!" },
    { role: "user", content: "Find ferns" },
  ]);
  assert.ok(!JSON.stringify(messages).includes("The user says hi"));
});

test("saved thinking is capped per message", () => {
  const long = "a".repeat(15000);
  const message = {
    id: "2",
    role: "assistant",
    metadata: { thinkingMs: 4000 },
    parts: [reasoning(long), { type: "data-research", data: {} }, reasoning("b".repeat(15000)), { type: "text", text: "Answer" }],
  };
  const saved = capThinking(message);
  const texts = saved.parts.filter((p) => p.type === "reasoning").map((p) => p.text);
  assert.equal(texts.join("").length, MAX_SAVED_THINKING);
  assert.equal(MAX_SAVED_THINKING, 20000);
  assert.equal(texts[0], long);
  assert.ok(texts[1].endsWith("…"));
  assert.deepEqual(saved.parts.map((p) => p.type), message.parts.map((p) => p.type), "every part keeps its place");
  assert.equal(saved.parts.at(-1).text, "Answer");
  assert.deepEqual(saved.metadata, message.metadata);
  assert.equal(message.parts[2].text.length, 15000, "the live message is left alone");

  const short = { id: "3", role: "assistant", parts: [reasoning("brief"), { type: "text", text: "Hi" }] };
  assert.equal(capThinking(short), short);
  const over = capThinking({ id: "4", role: "assistant", parts: [reasoning("x".repeat(20000)), reasoning("more")] });
  assert.deepEqual(over.parts.map((p) => p.text.length), [20000, 0]);
});

// ---- Search API query planning ----

test("Search API planning leaves room for a reasoning model and reads the queries after its thinking", async () => {
  const replies = [
    "<think>\nThe user wants shade ferns. Two queries.\n</think>\n[\"ferns for shade\", \"balcony ferns\"]",
    "<think>The user wants shade ferns.",
  ];
  for (const reply of replies) {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: reply }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [],
      }),
    });
    const searched = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (String(url).endsWith("/search")) {
        searched.push(body.query);
        return Response.json({ results: [{ title: "Ferns", url: `https://ferns.example/${searched.length}`, content: "Shade." }] });
      }
      return Response.json({ results: [] });
    };
    try {
      const run = webResearch({ keys: { searchKey: "k", browserUseKey: "", kernelKey: "" }, engine: "tavily", model, conversation: [] });
      await run("Ferns for a shady balcony", new AbortController().signal, { step() {}, update() {} });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.ok(model.doGenerateCalls[0].maxOutputTokens >= 1000, String(model.doGenerateCalls[0].maxOutputTokens));
    if (reply.includes("</think>")) assert.deepEqual(searched.sort(), ["balcony ferns", "ferns for shade"]);
    // Unfinished thinking is not a plan: the task itself is the query.
    else assert.deepEqual(searched, ["Ferns for a shady balcony"]);
  }
});
