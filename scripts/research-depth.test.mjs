import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { streamAnswer } from "../lib/answer.ts";
import { createBrowserUseRun } from "../lib/cloud-research.ts";
import { researchTask } from "../lib/research.ts";

// The Research tool's query and depth: a short search query for the engines, and how far to go.
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
const finish = (reason) => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
const step = (...parts) => ({ stream: convertArrayToReadableStream(parts) });
const call = (input) => ({ type: "tool-call", toolCallId: "call-0", toolName: "web_research", input: JSON.stringify(input) });
const words = (text) => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text }, { type: "text-end", id: "t" }];
function mockModel(steps) {
  let i = 0;
  return new MockLanguageModelV4({ doStream: async () => steps[i++] });
}
const sources = [{ title: "Fern care", url: "https://ferns.example/care", content: "Ferns like shade.", read: true }];
async function research(input) {
  const asked = [];
  const model = mockModel([step(call(input), finish("tool-calls")), step(...words("Ferns [1](https://ferns.example/care)."), finish("stop"))]);
  await streamAnswer({
    model,
    messages: [{ role: "user", content: "q" }],
    question: "q",
    webEnabled: true,
    modelName: "Atria",
    photos: 0,
    photosToModel: 0,
    signal: new AbortController().signal,
    writer: { write() {} },
    research: async (request) => {
      asked.push(request);
      return { sources, engine: "kernel" };
    },
  });
  return { asked, model };
}

test("a task on its own searches for its first twelve words, quickly", () => {
  assert.deepEqual(researchTask("How do AI agents search the web?"),
    { task: "How do AI agents search the web?", query: "How do AI agents search the web?", depth: "quick" });
  const long = "Explain how AI agents search the web, which tools they use, and how they pick sources to trust today";
  assert.equal(researchTask({ task: long }).query, "Explain how AI agents search the web, which tools they use, and");
  assert.deepEqual(researchTask({ task: "Ferns", query: "  shade ferns   balcony ", depth: "deep" }),
    { task: "Ferns", query: "shade ferns balcony", depth: "deep" });
  // Anything else falls back: an empty query, an unknown depth, a query that is really a sentence.
  assert.deepEqual(researchTask({ task: "Ferns for shade", query: " ", depth: "thorough" }),
    { task: "Ferns for shade", query: "Ferns for shade", depth: "quick" });
  assert.equal(researchTask({ task: "x", query: Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ") }).query.split(" ").length, 16);
});

test("the Research tool asks for a short query and a depth that is quick unless the user asks for thorough research", async () => {
  const { model } = await research({ task: "Ferns that suit a shady balcony" });
  const [tool] = model.doStreamCalls[0].tools;
  const { properties, required } = tool.inputSchema;
  assert.deepEqual(Object.keys(properties).sort(), ["depth", "query", "task"]);
  assert.deepEqual(required, ["task"]);
  assert.deepEqual(properties.depth.enum, ["quick", "deep"]);
  assert.equal(properties.depth.default, "quick");
  assert.match(properties.query.description, /short web search query/i);
  assert.match(properties.query.description, /10 words/);
  assert.match(properties.depth.description, /thorough, comprehensive or detailed/);
  assert.match(tool.description, /query/);
  assert.match(tool.description, /deep/);
});

test("research gets the model's query and depth, or the fallbacks when a provider leaves them out", async () => {
  const given = await research({ task: "Compare the best shade ferns in detail", query: "best shade ferns", depth: "deep" });
  assert.deepEqual(given.asked, [{ task: "Compare the best shade ferns in detail", query: "best shade ferns", depth: "deep" }]);
  const omitted = await research({ task: "Ferns that suit a shady balcony" });
  assert.deepEqual(omitted.asked, [{ task: "Ferns that suit a shady balcony", query: "Ferns that suit a shady balcony", depth: "quick" }]);
});

test("a research call with a null query or an unexpected depth still researches, with the fallbacks", async () => {
  const quick = { task: "Ferns for shade", query: "Ferns for shade", depth: "quick" };
  for (const [input, expected] of [
    [{ task: "Ferns for shade", query: null }, quick],
    [{ task: "Ferns for shade", query: null, depth: null }, quick],
    [{ task: "Ferns for shade", query: 42 }, quick],
    [{ task: "Ferns for shade", depth: "thorough" }, quick],
    [{ task: "Ferns for shade", query: "shade ferns", depth: "Deep" }, { ...quick, query: "shade ferns", depth: "deep" }],
  ]) {
    const { asked } = await research(input);
    assert.deepEqual(asked, [expected], JSON.stringify(input));
  }
  assert.equal(researchTask({ task: "Ferns", depth: " DEEP " }).depth, "deep");
});

test("Browser Use Cloud gets the task with a line for its depth", async () => {
  const bodies = [];
  const fetcher = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ id: "00000000-0000-4000-8000-000000000001" });
  };
  const options = { maxCostUsd: 2, timeout: AbortSignal.timeout(30_000) };
  const signal = new AbortController().signal;
  await createBrowserUseRun(researchTask({ task: "Shade ferns", query: "shade ferns" }), "k", signal, fetcher, options);
  await createBrowserUseRun(researchTask({ task: "Shade ferns", query: "shade ferns", depth: "deep" }), "k", signal, fetcher, options);
  assert.match(bodies[0].task, /Shade ferns/);
  assert.match(bodies[0].task, /Finish after a few relevant pages\./);
  assert.doesNotMatch(bodies[0].task, /thorough/);
  assert.match(bodies[1].task, /Be thorough/);
  assert.doesNotMatch(bodies[1].task, /Finish after a few/);
});

