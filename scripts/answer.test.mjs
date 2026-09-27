import assert from "node:assert/strict";
import { test } from "node:test";
import { APICallError, UnsupportedFunctionalityError } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { streamAnswer, toolsRejected, wantsResearch } from "../lib/answer.ts";
import { ResearchError } from "../lib/research.ts";

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
// One model step that writes text, or calls web_research (after optional text).
const reply = (...deltas) => ({ stream: convertArrayToReadableStream([...textParts("t", deltas), finish("stop")]) });
const callsResearch = (tasks, before) => ({
  stream: convertArrayToReadableStream([
    ...(before ? textParts("p", [before]) : []),
    ...tasks.map((task, i) => ({
      type: "tool-call", toolCallId: `call-${i}`, toolName: "web_research", input: JSON.stringify({ task }),
    })),
    finish("tool-calls"),
  ]),
});
const generated = (text) => ({
  content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [],
});
// A mock Answer model: each stream call takes the next step; an Error step is thrown.
function mockModel(steps, decision) {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const step = steps[i++];
      if (!step) throw new Error("No more model steps");
      if (step instanceof Error) throw step;
      return step;
    },
    doGenerate: async () => {
      if (decision instanceof Error) throw decision;
      return generated(decision ?? "");
    },
  });
}
const toolsUnsupported = () => new APICallError({
  message: "tools is not supported for this model",
  url: "https://api.example.com/v1/chat/completions",
  requestBodyValues: {},
  statusCode: 400,
  responseBody: '{"error":{"message":"tools is not supported for this model"}}',
  isRetryable: false,
});

const sources = [
  { title: "Fern care", url: "https://ferns.example/care", content: "Ferns like shade and damp soil.", read: true },
  { title: "Balcony plants", url: "https://plants.example/balcony", content: "Many ferns grow well on shady balconies." },
];
function fakeResearch(outcome = { sources, engine: "kernel" }) {
  const tasks = [];
  const research = async (task, signal, progress) => {
    tasks.push(task);
    progress.step("Selected Kernel");
    progress.update({ phase: "reading", engine: "kernel" });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { tasks, research };
}

async function answer({ question = "hey", ...options }) {
  const parts = [];
  await streamAnswer({
    messages: [{ role: "user", content: question }],
    question,
    webEnabled: true,
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
const researchData = (parts) => parts.findLast((p) => p.type === "data-research")?.data;
const hasResearch = (parts) => parts.some((p) => p.type === "data-research" || p.type === "source-url");
const systemOf = (call) => call.prompt.find((m) => m.role === "system")?.content || "";
const toolOutputs = (call) =>
  call.prompt.filter((m) => m.role === "tool").flatMap((m) => m.content).map((p) => p.output.value);

test("a message that needs no research gets a direct answer with no research trail", async () => {
  const model = mockModel([reply("Hi! ", "How can I help?")]);
  const { tasks, research } = fakeResearch();
  const parts = await answer({ model, research });
  assert.deepEqual(tasks, []);
  assert.equal(answerText(parts), "Hi! How can I help?");
  assert.ok(!hasResearch(parts));
  assert.deepEqual(parts.map((p) => p.type), ["text-start", "text-delta", "text-delta", "text-end", "finish"]);
  const call = model.doStreamCalls[0];
  assert.deepEqual(call.tools.map((t) => t.name), ["web_research"]);
  assert.deepEqual(call.toolChoice, { type: "auto" });
  assert.match(systemOf(call), /web_research/);
  assert.match(systemOf(call), /never claim to have searched/);
});

test("when the model calls the research tool, research runs once with its task and the answer uses the evidence", async () => {
  const model = mockModel([
    callsResearch(["Ferns that suit a shady balcony"], "Let me look that up."),
    reply("Most ferns like shade [1](https://ferns.example/care)."),
  ]);
  const { tasks, research } = fakeResearch();
  const parts = await answer({ model, research, question: "Find me a fern for my shady balcony" });
  assert.deepEqual(tasks, ["Ferns that suit a shady balcony"]);

  const data = researchData(parts);
  assert.equal(data.phase, "complete");
  assert.equal(data.engine, "kernel");
  assert.deepEqual(data.queries, ["Ferns that suit a shady balcony"]);
  assert.equal(data.steps[0], "Atria started research: “Ferns that suit a shady balcony”");
  assert.ok(data.steps.includes("Selected Kernel"));
  assert.equal(data.steps.at(-1), "Atria is writing an answer from the sources");
  assert.deepEqual(data.sources.map((s) => s.url), sources.map((s) => s.url));
  assert.deepEqual(
    parts.filter((p) => p.type === "source-url"),
    sources.map((s, i) => ({ type: "source-url", sourceId: String(i + 1), url: s.url, title: s.title })),
  );

  const [first, second] = model.doStreamCalls;
  assert.equal(model.doStreamCalls.length, 2);
  assert.deepEqual(first.tools.map((t) => t.name), ["web_research"]);
  assert.equal(second.tools, undefined, "the answer step has no tools");
  assert.deepEqual(toolOutputs(second), [[
    { number: 1, title: "Fern care", url: "https://ferns.example/care", content: "Ferns like shade and damp soil.", kind: "page content" },
    { number: 2, title: "Balcony plants", url: "https://plants.example/balcony", content: "Many ferns grow well on shady balconies.", kind: "search excerpt" },
  ]]);

  assert.equal(answerText(parts), "Let me look that up.\n\nMost ferns like shade [1](https://ferns.example/care).");
  assert.equal(parts.filter((p) => p.type === "text-start").length, 1);
  assert.equal(parts.filter((p) => p.type === "text-end").length, 1);
  assert.equal(parts.at(-1).type, "finish");
});

test("a model that asks for research twice in one step gets research once", async () => {
  const model = mockModel([callsResearch(["ferns", "more ferns"]), reply("Ferns [1](https://ferns.example/care).")]);
  const { tasks, research } = fakeResearch();
  const parts = await answer({ model, research });
  assert.deepEqual(tasks, ["ferns"]);
  const [evidence, again] = toolOutputs(model.doStreamCalls[1]);
  assert.equal(evidence.length, 2);
  assert.match(again.error, /already/);
  assert.equal(answerText(parts), "Ferns [1](https://ferns.example/care).");
});

test("the answer step cannot research again", async () => {
  const model = mockModel([callsResearch(["ferns"]), callsResearch(["more ferns"]), reply("never reached")]);
  const { tasks, research } = fakeResearch();
  await assert.rejects(answer({ model, research }), ResearchError);
  assert.deepEqual(tasks, ["ferns"]);
  assert.equal(model.doStreamCalls.length, 2);
});

test("a failed research goes back to the model as an error, and the answer still finishes", async () => {
  const model = mockModel([callsResearch(["ferns"]), reply("I couldn't research that just now.")]);
  const { research } = fakeResearch(new ResearchError("Kernel could not read these pages. Try Browser Use Cloud."));
  const parts = await answer({ model, research });
  assert.deepEqual(toolOutputs(model.doStreamCalls[1]), [{ error: "Kernel could not read these pages. Try Browser Use Cloud." }]);
  const data = researchData(parts);
  assert.equal(data.warning, "Kernel could not read these pages. Try Browser Use Cloud.");
  assert.notEqual(data.phase, "complete");
  assert.deepEqual(data.sources, []);
  assert.ok(!parts.some((p) => p.type === "source-url"));
  assert.equal(answerText(parts), "I couldn't research that just now.");
  assert.equal(parts.at(-1).type, "finish");
});

test("an unexpected research failure gets a plain message, not the raw error", async () => {
  const model = mockModel([callsResearch(["ferns"]), reply("Research failed.")]);
  const { research } = fakeResearch(new TypeError("fetch failed: ECONNRESET 10.0.0.1"));
  const parts = await answer({ model, research });
  const [output] = toolOutputs(model.doStreamCalls[1]);
  assert.ok(output.error && !/ECONNRESET/.test(output.error), JSON.stringify(output));
  assert.equal(researchData(parts).warning, output.error);
});

test("a request abort during research stops everything", async () => {
  const controller = new AbortController();
  const model = mockModel([callsResearch(["ferns"]), reply("never reached")]);
  const research = async (task, signal) => {
    controller.abort(new DOMException("The user stopped", "AbortError"));
    signal.throwIfAborted();
  };
  await assert.rejects(answer({ model, research, signal: controller.signal }), { name: "AbortError" });
  assert.equal(model.doStreamCalls.length, 1);
});

test("with Search the web off, the model gets no tools and the web-off prompt", async () => {
  const model = mockModel([reply("Here is a poem.")]);
  const { tasks, research } = fakeResearch();
  const parts = await answer({ model, research, webEnabled: false });
  assert.deepEqual(tasks, []);
  assert.equal(model.doStreamCalls[0].tools, undefined);
  assert.match(systemOf(model.doStreamCalls[0]), /Web search is OFF/);
  assert.ok(!hasResearch(parts));
  assert.equal(answerText(parts), "Here is a poem.");
});

test("a provider that rejects tools: the model decides RESEARCH in plain text, then answers from the evidence", async () => {
  const model = mockModel([toolsUnsupported(), reply("Ferns like shade [1](https://ferns.example/care).")], "RESEARCH");
  const { tasks, research } = fakeResearch();
  const turns = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` }));
  const parts = await answer({ model, research, question: "turn 7", messages: turns.slice(0, 7).concat({ role: "user", content: "turn 7" }) });
  assert.deepEqual(tasks, ["turn 7"]);
  const decision = model.doGenerateCalls[0];
  assert.match(systemOf(decision), /RESEARCH or ANSWER/);
  assert.equal(decision.tools, undefined);
  assert.deepEqual(decision.prompt.filter((m) => m.role !== "system").map((m) => m.content[0].text),
    ["turn 2", "turn 3", "turn 4", "turn 5", "turn 6", "turn 7"]);
  const answerCall = model.doStreamCalls[1];
  assert.equal(answerCall.tools, undefined);
  assert.match(systemOf(answerCall), /https:\/\/ferns\.example\/care/);
  assert.equal(researchData(parts).phase, "complete");
  assert.equal(parts.filter((p) => p.type === "source-url").length, 2);
  assert.equal(answerText(parts), "Ferns like shade [1](https://ferns.example/care).");
});

test("a provider that rejects tools: ANSWER means a direct answer with no research", async () => {
  const model = mockModel([toolsUnsupported(), reply("Hello!")], "ANSWER");
  const { tasks, research } = fakeResearch();
  const parts = await answer({ model, research });
  assert.deepEqual(tasks, []);
  assert.ok(!hasResearch(parts));
  assert.equal(model.doStreamCalls[1].tools, undefined);
  assert.match(systemOf(model.doStreamCalls[1]), /did not research the web/);
  assert.equal(answerText(parts), "Hello!");
});

test("a provider that rejects tools: an unclear or failed decision means research", async () => {
  for (const decision of ["Hmm, maybe?", "", new Error("decision failed")]) {
    const model = mockModel([toolsUnsupported(), reply("Answer [1](https://ferns.example/care).")], decision);
    const { tasks, research } = fakeResearch();
    const parts = await answer({ model, research, question: "ferns" });
    assert.deepEqual(tasks, ["ferns"], String(decision));
    assert.equal(researchData(parts).phase, "complete");
  }
});

test("other provider errors fail the answer as before, without the plain-text fallback", async () => {
  const unauthorized = new APICallError({
    message: "Invalid API key", url: "https://api.example.com/v1/chat/completions", requestBodyValues: {},
    statusCode: 401, isRetryable: false,
  });
  const model = mockModel([unauthorized], "RESEARCH");
  const { tasks, research } = fakeResearch();
  await assert.rejects(answer({ model, research }), (error) => APICallError.isInstance(error) && error.statusCode === 401);
  assert.equal(model.doGenerateCalls.length, 0);
  assert.deepEqual(tasks, []);
});

test("an empty answer is an error", async () => {
  const model = mockModel([reply()]);
  await assert.rejects(answer({ model, research: fakeResearch().research }), ResearchError);
});

test("the vision model's photo description is noted in the research trail", async () => {
  const model = mockModel([callsResearch(["red shoes like these"]), reply("Here are some [1](https://ferns.example/care).")]);
  const parts = await answer({ model, research: fakeResearch().research, photos: 1, photosToModel: 0 });
  assert.ok(researchData(parts).steps.includes("Vision model described the photo"));
  assert.match(systemOf(model.doStreamCalls[0]), /which you cannot see/);
});

test("recognises a provider turning tools away", () => {
  const apiError = (statusCode, message, responseBody) =>
    new APICallError({ message, url: "https://api.example.com/v1/chat/completions", requestBodyValues: {}, statusCode, responseBody });
  assert.equal(toolsRejected(toolsUnsupported()), true);
  assert.equal(toolsRejected(apiError(404, "No endpoints found that support tool use.")), true);
  assert.equal(toolsRejected(apiError(422, "Unprocessable", '{"detail":"function calling is not enabled"}')), true);
  assert.equal(toolsRejected(apiError(400, "Invalid value for tool_choice")), true);
  assert.equal(toolsRejected(new UnsupportedFunctionalityError({ functionality: "tools" })), true);
  assert.equal(toolsRejected(apiError(400, "This model's maximum context length is 8192 tokens")), false);
  assert.equal(toolsRejected(apiError(500, "tool server crashed")), false);
  assert.equal(toolsRejected(apiError(401, "Invalid API key")), false);
  assert.equal(toolsRejected(new Error("tools is not supported")), false);
});

test("reads the model's one-word decision; anything unclear means research", () => {
  for (const reply of ["ANSWER", "answer.", "**ANSWER**", " Answer\nThe user said hello."])
    assert.equal(wantsResearch(reply), false, reply);
  for (const reply of ["RESEARCH", "Research.", "I would ANSWER", "", "???"])
    assert.equal(wantsResearch(reply), true, reply);
});
