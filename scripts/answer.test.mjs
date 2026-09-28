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
// OpenAI's reply when a request with tools runs past the context window: it mentions functions but is not about tool support.
const CONTEXT_LENGTH_MESSAGE =
  "This model's maximum context length is 128000 tokens. However, your messages resulted in 130211 tokens (129800 in the messages, 411 in the functions). Please reduce the length of the messages or functions.";
const contextLengthError = () => new APICallError({
  message: CONTEXT_LENGTH_MESSAGE,
  url: "https://api.example.com/v1/chat/completions",
  requestBodyValues: {},
  statusCode: 400,
  responseBody: JSON.stringify({
    error: { message: CONTEXT_LENGTH_MESSAGE, type: "invalid_request_error", param: "messages", code: "context_length_exceeded" },
  }),
  isRetryable: false,
});

const sources = [
  { title: "Fern care", url: "https://ferns.example/care", content: "Ferns like shade and damp soil.", read: true },
  { title: "Balcony plants", url: "https://plants.example/balcony", content: "Many ferns grow well on shady balconies." },
];
function fakeResearch(outcome = { sources, engine: "kernel" }) {
  const tasks = [];
  const research = async (request, signal, progress) => {
    tasks.push(request.task);
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
  assert.equal(data.steps.at(-1), "Atria is writing the answer from the sources");
  assert.deepEqual(data.sources.map((s) => s.url), sources.map((s) => s.url));
  assert.deepEqual(
    parts.filter((p) => p.type === "source-url"),
    sources.map((s, i) => ({ type: "source-url", sourceId: String(i + 1), url: s.url, title: s.title })),
  );

  const [first, second] = model.doStreamCalls;
  assert.equal(model.doStreamCalls.length, 2);
  assert.deepEqual(first.tools.map((t) => t.name), ["web_research"]);
  // The tool stays defined next to its call and result, which some providers require, but cannot be chosen.
  assert.deepEqual(second.tools?.map((t) => t.name), ["web_research"]);
  assert.deepEqual(second.toolChoice, { type: "none" }, "the answer step cannot call tools");
  assert.deepEqual(toolOutputs(second), [[
    { number: 1, title: "Fern care", url: "https://ferns.example/care", content: "Ferns like shade and damp soil.", kind: "page content" },
    { number: 2, title: "Balcony plants", url: "https://plants.example/balcony", content: "Many ferns grow well on shady balconies.", kind: "search excerpt" },
  ]]);

  // The words before the call streamed, then moved into Thinking; the Answer is what came after research.
  const reset = parts.findIndex((p) => p.type === "reset-step");
  assert.ok(reset > 0);
  const replay = parts.slice(reset + 1);
  assert.deepEqual(replay.filter((p) => p.type === "reasoning-delta").map((p) => p.delta), ["Let me look that up."]);
  assert.equal(answerText(replay), "Most ferns like shade [1](https://ferns.example/care).");
  assert.equal(replay.filter((p) => p.type === "text-start").length, 1);
  assert.equal(replay.filter((p) => p.type === "text-end").length, 1);
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
  assert.deepEqual(model.doStreamCalls[1].toolChoice, { type: "none" });
});

test("a failed research goes back to the model as an error, and the answer still finishes", async () => {
  const model = mockModel([callsResearch(["ferns"]), reply("I couldn't research that just now.")]);
  const { research } = fakeResearch(new ResearchError("Kernel could not read these pages. Try Browser Use Cloud."));
  const parts = await answer({ model, research });
  const [output] = toolOutputs(model.doStreamCalls[1]);
  assert.equal(output.error, "Kernel could not read these pages. Try Browser Use Cloud.");
  assert.equal(output.canRetry, true);
  assert.match(output.retry, /once more/);
  const data = researchData(parts);
  assert.equal(data.warning, "Kernel could not read these pages. Try Browser Use Cloud.");
  assert.equal(data.failed, true, "the model was told, so the panel says Research incomplete");
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

// Research outcomes in order, each taking `took` ms on a fake clock that starts with the request.
function timedResearch(outcomes) {
  const clock = { now: 1_000_000 };
  const calls = [];
  const research = async (request, signal, progress, deadline) => {
    const outcome = outcomes[calls.length];
    calls.push({ task: request.task, deadline, at: clock.now });
    progress.step(`Selected ${outcome.engine === "browser_use" ? "Browser Use Cloud" : "Kernel"}`);
    progress.update({ phase: "reading", engine: outcome.engine || "kernel" });
    clock.now += outcome.took;
    if (outcome.error) throw outcome.error;
    return outcome.finding;
  };
  return { research, calls, clock: () => clock.now, startedAt: clock.now };
}
const timedOut = new ResearchError("The browser agent ran out of time before it reached a usable page. Try a narrower question or choose Kernel.");
const shirts = [
  { title: "Linen shirt", url: "https://us.shein.com/linen", content: "Rated 4.8 stars." },
  { title: "Oxford shirt", url: "https://us.shein.com/oxford", content: "Rated 4.6 stars." },
];

test("a quick research failure lets the model try once more, and the answer cites the second attempt", async () => {
  const model = mockModel([
    callsResearch(["best shirts on shein"]),
    callsResearch(["top rated men's linen shirts on shein.com"]),
    reply("The linen shirt rates best [1](https://us.shein.com/linen)."),
  ]);
  const timed = timedResearch([
    { took: 20_000, error: timedOut, engine: "browser_use" },
    { took: 40_000, finding: { sources: shirts, engine: "kernel" } },
  ]);
  const parts = await answer({ model, ...timed, question: "find me some best shirts on shein" });
  assert.deepEqual(timed.calls.map((c) => c.task), ["best shirts on shein", "top rated men's linen shirts on shein.com"]);
  // The first research ends 200 s into the request; a second one leaves the answer 60 s of the 280.
  assert.deepEqual(timed.calls.map((c) => c.deadline - timed.startedAt), [200_000, 220_000]);

  const [first, retry, final] = model.doStreamCalls;
  assert.equal(model.doStreamCalls.length, 3);
  assert.deepEqual(first.toolChoice, { type: "auto" });
  assert.deepEqual(retry.toolChoice, { type: "auto" }, "the model may research again after a quick failure");
  const [failure] = toolOutputs(retry);
  assert.equal(failure.error, timedOut.message);
  assert.equal(failure.canRetry, true);
  assert.equal(failure.secondsLeft, 260);
  assert.deepEqual(final.tools?.map((t) => t.name), ["web_research"]);
  assert.deepEqual(final.toolChoice, { type: "none" });
  assert.deepEqual(toolOutputs(final)[1].map((s) => s.url), shirts.map((s) => s.url));

  const data = researchData(parts);
  assert.equal(data.phase, "complete");
  assert.equal(data.failed, undefined);
  assert.equal(data.warning, undefined);
  assert.deepEqual(data.queries, ["best shirts on shein", "top rated men's linen shirts on shein.com"]);
  assert.deepEqual(data.steps, [
    "Atria started research: “best shirts on shein”",
    "Selected Browser Use Cloud",
    `Research did not finish: ${timedOut.message}`,
    "Atria started research again: “top rated men's linen shirts on shein.com”",
    "Selected Kernel",
    "Atria is writing the answer from the sources",
  ]);
  assert.deepEqual(data.sources.map((s) => s.url), shirts.map((s) => s.url));
  assert.deepEqual(parts.filter((p) => p.type === "source-url").map((p) => p.url), shirts.map((s) => s.url));
  assert.equal(answerText(parts), "The linen shirt rates best [1](https://us.shein.com/linen).");
});

test("a research failure with little time left cannot be retried, and the next step cannot call the tool", async () => {
  const model = mockModel([callsResearch(["best shirts on shein"]), reply("The research ran out of time, so this is general knowledge.")]);
  const timed = timedResearch([{ took: 195_000, error: timedOut, engine: "browser_use" }]);
  const parts = await answer({ model, ...timed });
  assert.equal(timed.calls.length, 1);
  const [failure] = toolOutputs(model.doStreamCalls[1]);
  assert.equal(failure.canRetry, false);
  assert.equal(failure.secondsLeft, 85);
  assert.equal(failure.error, timedOut.message);
  assert.deepEqual(model.doStreamCalls[1].tools?.map((t) => t.name), ["web_research"]);
  assert.deepEqual(model.doStreamCalls[1].toolChoice, { type: "none" });
  const data = researchData(parts);
  assert.equal(data.failed, true);
  assert.equal(data.warning, timedOut.message);
  assert.notEqual(data.phase, "complete");
});

test("research that returns no sources counts as a failure the model may retry", async () => {
  const model = mockModel([callsResearch(["a"]), callsResearch(["b"]), reply("Found it [1](https://us.shein.com/linen).")]);
  const timed = timedResearch([
    { took: 5_000, finding: { sources: [], engine: "kernel" } },
    { took: 5_000, finding: { sources: shirts, engine: "kernel" } },
  ]);
  await answer({ model, ...timed });
  assert.equal(timed.calls.length, 2);
  assert.equal(toolOutputs(model.doStreamCalls[1])[0].canRetry, true);
});

test("a third research call never runs", async () => {
  const model = mockModel([
    callsResearch(["a"]),
    callsResearch(["b"]),
    callsResearch(["c"], "Research failed twice, so this is from what I know."),
    reply("never reached"),
  ]);
  const timed = timedResearch([
    { took: 5_000, error: timedOut },
    { took: 5_000, error: timedOut },
    { took: 5_000, error: timedOut },
  ]);
  const parts = await answer({ model, ...timed });
  assert.deepEqual(timed.calls.map((c) => c.task), ["a", "b"]);
  assert.equal(model.doStreamCalls.length, 3);
  assert.equal(toolOutputs(model.doStreamCalls[2])[1].canRetry, false);
  assert.deepEqual(model.doStreamCalls[2].toolChoice, { type: "none" });
  assert.equal(answerText(parts), "Research failed twice, so this is from what I know.");
  assert.equal(researchData(parts).failed, true);
});

test("while the model may still try again, the panel records the failure and does not say an answer is being written", async () => {
  const model = mockModel([callsResearch(["a"]), callsResearch(["b"]), reply("Found it [1](https://us.shein.com/linen).")]);
  const timed = timedResearch([
    { took: 20_000, error: timedOut, engine: "browser_use" },
    { took: 5_000, finding: { sources: shirts, engine: "kernel" } },
  ]);
  const parts = await answer({ model, ...timed });
  const afterFailure = parts.filter((p) => p.type === "data-research").map((p) => p.data).find((d) => d.failed);
  assert.notEqual(afterFailure.phase, "writing");
  assert.equal(afterFailure.warning, timedOut.message);
  assert.equal(afterFailure.steps.at(-1), `Research did not finish: ${timedOut.message}`);
  assert.equal(researchData(parts).steps.filter((s) => s.startsWith("Research did not finish")).length, 1);
});

test("a failure with no retry is recorded in the steps too", async () => {
  const model = mockModel([callsResearch(["a"]), reply("The research ran out of time, so this is general knowledge.")]);
  const timed = timedResearch([{ took: 195_000, error: timedOut, engine: "browser_use" }]);
  const data = researchData(await answer({ model, ...timed }));
  assert.equal(data.phase, "writing");
  assert.equal(data.steps.at(-1), `Research did not finish: ${timedOut.message}`);
});

test("a failure that would happen again, such as no credit, cannot be retried", async () => {
  const model = mockModel([callsResearch(["shirts"]), reply("Browser Use Cloud has no credit, so this is not from sources.")]);
  const { research } = fakeResearch(new ResearchError("Browser Use Cloud has insufficient credit.", { retryable: false }));
  await answer({ model, research });
  const [output] = toolOutputs(model.doStreamCalls[1]);
  assert.equal(output.canRetry, false);
  assert.match(output.retry, /cannot run again/);
  assert.deepEqual(model.doStreamCalls[1].toolChoice, { type: "none" });
});

test("partial results reach the model with their warning, and a page with no text is marked as such", async () => {
  const partial = {
    engine: "browser_use",
    warning: "The browser agent ran out of time; these are the pages it had reached",
    sources: [
      { title: "Men's Shirts | SHEIN USA", url: "https://us.shein.com/Men-Shirts-c-1979.html", content: "Top rated: a linen shirt, 4.8 stars.", read: false },
      { title: "us.shein.com", url: "https://us.shein.com/Oxford-Shirt-p-2.html", content: "", read: false },
    ],
  };
  const model = mockModel([callsResearch(["shirts"]), reply("A linen shirt rates best [1](https://us.shein.com/Men-Shirts-c-1979.html).")]);
  await answer({ model, research: fakeResearch(partial).research });
  const [output] = toolOutputs(model.doStreamCalls[1]);
  assert.equal(output.warning, partial.warning);
  assert.deepEqual(output.sources.map((s) => [s.number, s.url, s.kind]), [
    [1, partial.sources[0].url, "browser agent observation (verify against original page)"],
    [2, partial.sources[1].url, "page reached with no text recorded; do not cite it for facts"],
  ]);
  assert.match(systemOf(model.doStreamCalls[0]), /sources come with a warning, such as partial results/);
});

test("the model is told never to promise research it is not doing in the same reply", async () => {
  const model = mockModel([reply("Hi!")]);
  await answer({ model, research: fakeResearch().research });
  const system = systemOf(model.doStreamCalls[0]);
  assert.match(system, /Never say you will do something later, such as “let me try again” or “I will search”, unless you call web_research in this same reply/);
  assert.match(system, /cannot retry, say in one sentence what happened/);
  assert.match(system, /clear caveat that it is not from sources/);
  assert.match(system, /suggest how to narrow the question/);
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
  const tooLong = contextLengthError();
  for (const error of [unauthorized, tooLong]) {
    const model = mockModel([error], "RESEARCH");
    const { tasks, research } = fakeResearch();
    await assert.rejects(answer({ model, research }), (thrown) => thrown === error, error.message);
    assert.equal(model.doGenerateCalls.length, 0, error.message);
    assert.deepEqual(tasks, [], error.message);
  }
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
  assert.equal(toolsRejected(contextLengthError()), false);
  assert.equal(toolsRejected(apiError(400, CONTEXT_LENGTH_MESSAGE)), false);
  assert.equal(toolsRejected(apiError(400, "Bad Request", '{"error":{"code":"context_length_exceeded","message":"Too many tokens in the functions"}}')), false);
  assert.equal(toolsRejected(apiError(500, "tool server crashed")), false);
  assert.equal(toolsRejected(apiError(401, "Invalid API key")), false);
  assert.equal(toolsRejected(new Error("tools is not supported")), false);
});

test("reads the model's one-word decision; anything unclear means research", () => {
  for (const reply of [
    "ANSWER", "answer.", "**ANSWER**", " Answer\nThe user said hello.",
    "<think>\nThe user says hey, so no web is needed.\n</think>\n\nANSWER",
    "<thinking>Small talk.</thinking>Answer",
  ])
    assert.equal(wantsResearch(reply), false, reply);
  for (const reply of [
    "RESEARCH", "Research.", "I would ANSWER", "", "???",
    "<think>\nThe user wants today's prices.\n</think>\nRESEARCH",
    "<think>\nThe user says hey, so I should ANSWER",
  ])
    assert.equal(wantsResearch(reply), true, reply);
});

test("the plain-text decision leaves a reasoning model room to think before its word", async () => {
  const model = mockModel([toolsUnsupported(), reply("Hello!")], "<think>\nThe user says hey. No web needed.\n</think>\nANSWER");
  const { tasks, research } = fakeResearch();
  const parts = await answer({ model, research });
  assert.deepEqual(tasks, []);
  assert.ok(!hasResearch(parts));
  assert.ok(model.doGenerateCalls[0].maxOutputTokens >= 256, String(model.doGenerateCalls[0].maxOutputTokens));
});
