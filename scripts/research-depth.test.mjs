import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import { streamAnswer } from "../lib/answer.ts";
import { createBrowserUseRun, kernelResearch, kernelScript } from "../lib/cloud-research.ts";
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

// Kernel's fixed script, run against a fake browser: search results, then pages that take a while.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function fakeBrowser({ results, delays = {}, failsWhileRead = [] }) {
  const seen = { searched: [], opened: [], open: 0, most: 0, closed: 0 };
  const page = {
    goto: async (url) => {
      seen.searched.push(url);
    },
    locator: () => ({ evaluateAll: async () => results }),
  };
  const context = {
    newPage: async () => {
      let at = "";
      seen.open++;
      seen.most = Math.max(seen.most, seen.open);
      return {
        goto: async (url) => {
          at = url;
          seen.opened.push(url);
          await new Promise((resolve) => setTimeout(resolve, delays[url] ?? 100));
        },
        url: () => at,
        title: async () => `Title of ${at}`,
        locator: (selector) => ({
          first: () => ({
            innerText: async () => {
              const text = `Text of ${at}`;
              // The browser's own error page replaces one that fails while it is read.
              if (failsWhileRead.includes(at)) at = "chrome-error://chromewebdata/";
              return text;
            },
            getAttribute: async () => (selector.includes("og:image") ? null : ""),
          }),
        }),
        close: async () => {
          seen.open--;
          seen.closed++;
        },
      };
    },
  };
  return { page, context, seen };
}
const results = [1, 2, 3, 4, 5].map((n) => ({ url: `https://site${n}.example/page`, title: `Result ${n}` }));

test("Kernel searches with the query, never the long task sentence", async () => {
  const browser = fakeBrowser({ results });
  const task = researchTask({ task: "Explain how AI agents search the web and cite what they find", query: "how AI agents search the web" });
  await new AsyncFunction("page", "context", kernelScript(task))(browser.page, browser.context);
  assert.equal(browser.seen.searched[0], `https://www.google.com/search?q=${encodeURIComponent("how AI agents search the web")}`);
  assert.ok(!browser.seen.searched.some((url) => url.includes("Explain")));
});

test("Kernel reads its pages side by side, at most four, and keeps the output shape", async () => {
  const browser = fakeBrowser({ results });
  const started = Date.now();
  const out = await new AsyncFunction("page", "context", kernelScript(researchTask("ferns")))(browser.page, browser.context);
  const took = Date.now() - started;
  assert.ok(took < 300, `four pages of 100 ms each took ${took} ms`);
  assert.equal(browser.seen.most, 4, "all four pages were open at once");
  assert.equal(browser.seen.closed, 4, "every page is closed");
  assert.deepEqual(out.map((s) => s.url), results.slice(0, 4).map((r) => r.url), "in the search results' order");
  assert.deepEqual(Object.keys(out[0]).sort(), ["content", "image", "read", "title", "url"]);
  assert.equal(out[0].read, true);
  assert.equal(out[0].content, "Text of https://site1.example/page");
});

test("a page that never loads is left out after its own time limit, and the others still count", async () => {
  const browser = fakeBrowser({ results, delays: { "https://site2.example/page": 60_000 } });
  const started = Date.now();
  const out = await new AsyncFunction("page", "context", kernelScript(researchTask("ferns"), undefined, { pageMs: 300 }))(browser.page, browser.context);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(out.map((s) => s.url), ["https://site1.example/page", "https://site3.example/page", "https://site4.example/page"]);
  assert.equal(browser.seen.closed, 4);
});

test("a page that turns into the browser's error page while it is read is left out", async () => {
  const browser = fakeBrowser({ results, failsWhileRead: ["https://site3.example/page"] });
  const out = await new AsyncFunction("page", "context", kernelScript(researchTask("ferns")))(browser.page, browser.context);
  assert.deepEqual(out.map((s) => s.url), ["https://site1.example/page", "https://site2.example/page", "https://site4.example/page"]);
});

test("a pasted link opens directly, and the script stays valid JavaScript for any task", async () => {
  const browser = fakeBrowser({ results });
  const out = await new AsyncFunction("page", "context", kernelScript(researchTask("Summarize https://example.com/a"), "https://example.com/a"))(browser.page, browser.context);
  assert.deepEqual(browser.seen.searched, [], "no search for a pasted link");
  assert.deepEqual(out.map((s) => s.url), ["https://example.com/a"]);
  for (const task of ["Q with `backticks` and ${braces}?", 'quotes " and \\ and </script>', "line\nbreak"])
    assert.doesNotThrow(() => new AsyncFunction("page", "context", kernelScript(researchTask({ task, query: task }))));
});

test("Kernel sends the script with the query and says what it searched for", async () => {
  let code = "";
  const steps = [];
  const fetcher = async (url, init) => {
    if (init.method === "DELETE") return Response.json({});
    if (url.endsWith("/browsers")) return Response.json({ session_id: "session-12345678" });
    code = JSON.parse(init.body).code;
    return Response.json({ success: true, result: [{ url: "https://example.com/a", title: "A", content: "Text", read: true }] });
  };
  await kernelResearch(researchTask({ task: "A long task sentence about ferns", query: "shade ferns" }), "k", new AbortController().signal, fetcher, (s) => steps.push(s));
  assert.match(code, /const query = "shade ferns";/);
  assert.ok(steps.includes("Kernel is searching for “shade ferns” and reading public pages"), steps.join(" | "));
});
