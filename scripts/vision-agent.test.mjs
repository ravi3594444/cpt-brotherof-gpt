import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentAction, visionAgentResearch } from "../lib/vision-agent.ts";
import { ResearchError, researchTask } from "../lib/research.ts";

const signal = new AbortController().signal;
const vision = { baseURL: "https://api.aimlapi.com/v1", apiKey: "aiml-key", model: "deepseek/deepseek-v4.1-flash" };
const page = {
  url: "https://www.bing.com/search?q=ferns",
  title: "ferns - Search",
  elements: [
    { id: 1, role: "link", label: "How to grow ferns" },
    { id: 2, role: "searchbox", label: "Search" },
    { id: 3, role: "password", label: "Password" },
  ],
  text: "Results",
};

test("the agent's reply becomes one checked browser action", () => {
  assert.deepEqual(parseAgentAction('I will open the guide. {"action":"click","element":1}', page), { action: "click", element: 1 });
  assert.deepEqual(parseAgentAction('```json\n{"action":"type","element":2,"text":"fern care","submit":true}\n```', page),
    { action: "type", element: 2, text: "fern care", submit: true });
  assert.deepEqual(parseAgentAction('{"action":"scroll","direction":"down"}', page), { action: "scroll", direction: "down" });
  assert.deepEqual(parseAgentAction('{"action":"open","url":"https://example.com/ferns."}', page), { action: "open", url: "https://example.com/ferns" });
  for (const action of ["read", "back", "finish"])
    assert.deepEqual(parseAgentAction(JSON.stringify({ action }), page), { action });
});

test("the agent cannot click what is not on the page, type into a password box, or open private addresses", () => {
  for (const reply of [
    '{"action":"click","element":9}',
    '{"action":"type","element":3,"text":"hunter2"}',
    '{"action":"type","element":1,"text":"x"}',
    '{"action":"open","url":"http://localhost:8080/admin"}',
    '{"action":"buy","element":1}',
    "I am not sure.",
  ])
    assert.equal(parseAgentAction(reply, page), undefined, reply);
});

// A fake Kernel browser plus vision model, scripted step by step.
function fakeServices(pages, replies) {
  const calls = { kernel: [], vision: [], deleted: false };
  let p = 0;
  let r = 0;
  const fetcher = async (url, init) => {
    if (url.startsWith("https://api.onkernel.com/browsers")) {
      if (init.method === "DELETE") {
        calls.deleted = true;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/browsers")) return Response.json({ session_id: "session-12345678" });
      calls.kernel.push(JSON.parse(init.body).code);
      // null: a step Kernel could not carry out.
      const next = pages[Math.min(p++, pages.length - 1)];
      return Response.json(next === null ? { success: false, error: "Timeout 6000ms exceeded" } : { success: true, result: next });
    }
    calls.vision.push(JSON.parse(init.body));
    const reply = replies[Math.min(r++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    // A number: the vision model's service answers with that HTTP status.
    if (typeof reply === "number") return new Response("busy", { status: reply });
    return Response.json({ choices: [{ message: { content: reply, ...(!reply && { reasoning_content: "Thinking about the page" }) } }] });
  };
  return { fetcher, calls };
}
const article = {
  url: "https://example.com/ferns",
  title: "How to grow ferns",
  elements: [{ id: 1, role: "link", label: "Home" }],
  text: "Ferns like shade and damp soil.",
  image: "https://example.com/fern.jpg",
  screenshot: "U0NSRUVO",
};

test("the agent searches, clicks, reads, and finishes; Atria gets the pages it read", async () => {
  const { fetcher, calls } = fakeServices(
    [{ ...page, screenshot: "UkVTVUxUUw==" }, article],
    ['{"action":"click","element":1}', '{"action":"read"}', '{"action":"finish"}'],
  );
  const steps = [];
  const { sources } = await visionAgentResearch("How do I grow ferns?", { kernelKey: "k", vision }, signal, fetcher, (s) => steps.push(s));
  assert.deepEqual(sources, [{
    url: "https://example.com/ferns",
    title: "How to grow ferns",
    content: "Ferns like shade and damp soil.",
    read: true,
    image: "https://example.com/fern.jpg",
  }]);
  assert.match(calls.kernel[0], /bing\.com\/search\?q=How%20do%20I%20grow%20ferns/);
  assert.match(calls.kernel[1], /"action":"click","element":1/);
  assert.deepEqual(calls.vision[0].messages.at(-1).content.at(-1), { type: "image_url", image_url: { url: "data:image/jpeg;base64,UkVTVUxUUw==" } });
  assert.match(steps.join(" | "), /Clicked “How to grow ferns”.*Read “How to grow ferns”/);
  assert.equal(calls.deleted, true);
});

test("a pasted link is where the agent starts", async () => {
  const { fetcher, calls } = fakeServices([article], ['{"action":"read"}', '{"action":"finish"}']);
  await visionAgentResearch("Summarize https://example.com/ferns.", { kernelKey: "k", vision }, signal, fetcher);
  assert.match(calls.kernel[0], /const start = "https:\/\/example\.com\/ferns";/);
});

test("the agent stops at its step limit and keeps the page it ended on", async () => {
  const { fetcher, calls } = fakeServices([article], ['{"action":"scroll","direction":"down"}']);
  const { sources, warning } = await visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, fetcher, undefined, { maxSteps: 3 });
  assert.equal(calls.vision.length, 3);
  assert.equal(sources[0].url, "https://example.com/ferns");
  assert.match(warning, /step limit/);
  assert.equal(calls.deleted, true);
});

test("the agent stops when research time runs out and keeps what it read", async () => {
  const { fetcher: services, calls } = fakeServices([article],
    ['{"action":"read"}', '{"action":"scroll","direction":"down"}', '{"action":"scroll","direction":"down"}']);
  // Each vision model reply takes 20 s on this clock; research must end 50 s in.
  let now = 0;
  const fetcher = async (url, init) => {
    if (!url.startsWith("https://api.onkernel.com")) now += 20_000;
    return services(url, init);
  };
  const { sources, warning } = await visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, fetcher, undefined,
    { deadline: 50_000, clock: () => now });
  assert.equal(calls.vision.length, 3);
  assert.deepEqual(sources.map((s) => s.url), ["https://example.com/ferns"]);
  assert.match(warning, /ran out of time/);
  assert.equal(calls.deleted, true);
});

test("the agent does not open a browser it has no time to use", async () => {
  const { fetcher: services } = fakeServices([article], ['{"action":"finish"}']);
  const urls = [];
  const fetcher = async (url, init) => {
    urls.push(url);
    return services(url, init);
  };
  await assert.rejects(
    visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, fetcher, undefined, { deadline: 30_000, clock: () => 0 }),
    (error) => error instanceof ResearchError && /not enough time/.test(error.message),
  );
  assert.deepEqual(urls, []);
});

test("closing the browser is handed to the platform, so it finishes after the response ends", async () => {
  const { fetcher, calls } = fakeServices([article], ['{"action":"read"}', '{"action":"finish"}']);
  const kept = [];
  await visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, fetcher, undefined, { keepAlive: (work) => kept.push(work) });
  assert.equal(kept.length, 1);
  await kept[0];
  assert.equal(calls.deleted, true);
});

test("the cloud browser is closed even when the vision model fails", async () => {
  // On a search page, with nothing to keep, the failure fails the run.
  const { fetcher, calls } = fakeServices([page], [new TypeError("network down")]);
  await assert.rejects(() => visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, fetcher), /network down/);
  assert.equal(calls.deleted, true);
  // On a readable page, the run ends with that page.
  const onArticle = fakeServices([article], [new TypeError("network down")]);
  const { sources, warning } = await visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, onArticle.fetcher);
  assert.deepEqual(sources.map((s) => s.url), ["https://example.com/ferns"]);
  assert.match(warning, /stopped early after an error/);
  assert.equal(onArticle.calls.deleted, true);
});

test("an agent that never reaches a readable public page says so plainly", async () => {
  const { fetcher } = fakeServices([{ ...page, text: "" }], ['{"action":"finish"}']);
  await assert.rejects(() => visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, fetcher), ResearchError);
});

test("every browser step Scout sends is valid JavaScript", async () => {
  const { fetcher, calls } = fakeServices([page, article],
    ['{"action":"type","element":2,"text":"fern \\"care\\"\\n</script>","submit":true}', '{"action":"click","element":1}',
      '{"action":"scroll","direction":"up"}', '{"action":"back"}', '{"action":"open","url":"https://example.com/x"}', '{"action":"finish"}']);
  await visionAgentResearch("Q with `backticks` and ${braces}?", { kernelKey: "k", vision }, signal, fetcher).catch(() => {});
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  assert.equal(calls.kernel.length, 6);
  for (const code of calls.kernel) assert.doesNotThrow(() => new AsyncFunction("page", "context", code));
});

const articleAt = (n) => ({ ...article, url: `https://site${n}.example/ferns`, title: `Fern guide ${n}` });
const openSite = (n) => JSON.stringify({ action: "open", url: `https://site${n}.example/ferns` });
const userText = (call) => call.messages.at(-1).content[0].text;

test("the agent starts its search with the query, not the long task sentence", async () => {
  const { fetcher, calls } = fakeServices([article], ['{"action":"read"}', '{"action":"finish"}']);
  const task = researchTask({ task: "Explain how to grow ferns on a shady balcony, with watering and soil tips", query: "grow ferns shady balcony" });
  await visionAgentResearch(task, { kernelKey: "k", vision }, signal, fetcher);
  assert.match(calls.kernel[0], /const start = "https:\/\/www\.bing\.com\/search\?q=grow%20ferns%20shady%20balcony";/);
  assert.ok(!calls.kernel[0].includes("Explain"));
});

test("the agent's prompt says how deep to go and how many pages to keep", async () => {
  const quick = fakeServices([article], ['{"action":"finish"}']);
  await visionAgentResearch(researchTask("Q?"), { kernelKey: "k", vision }, signal, quick.fetcher);
  assert.match(quick.calls.vision[0].messages[0].content, /Keep about 3 good pages/);
  assert.match(userText(quick.calls.vision[0]), /Research depth: quick/);
  const deep = fakeServices([article], ['{"action":"finish"}']);
  await visionAgentResearch(researchTask({ task: "Q?", depth: "deep" }), { kernelKey: "k", vision }, signal, deep.fetcher);
  assert.match(deep.calls.vision[0].messages[0].content, /Be thorough: keep up to 6 good pages/);
  assert.match(userText(deep.calls.vision[0]), /Research depth: deep/);
});

test("the agent finishes by itself once it has kept enough pages: 3 for quick research, 6 for deep", async () => {
  const sites = [page, ...Array.from({ length: 8 }, (_, i) => articleAt(i + 1))];
  const browse = [openSite(1), '{"action":"read"}', openSite(2), '{"action":"read"}', openSite(3), '{"action":"read"}',
    openSite(4), '{"action":"read"}', openSite(5), '{"action":"read"}', openSite(6), '{"action":"read"}', openSite(7), '{"action":"read"}'];
  const quick = fakeServices(sites, browse);
  const found = await visionAgentResearch(researchTask("Ferns?"), { kernelKey: "k", vision }, signal, quick.fetcher);
  assert.equal(quick.calls.vision.length, 6, "no model call after the third page");
  assert.deepEqual(found.sources.map((s) => s.title), ["Fern guide 1", "Fern guide 2", "Fern guide 3"]);
  assert.equal(found.warning, undefined);
  const deep = fakeServices(sites, browse);
  const thorough = await visionAgentResearch(researchTask({ task: "Ferns?", depth: "deep" }), { kernelKey: "k", vision }, signal, deep.fetcher);
  assert.equal(deep.calls.vision.length, 12);
  assert.equal(thorough.sources.length, 6);
  assert.equal(thorough.warning, undefined);
});

test("in the request the agent takes up to 8 steps for quick research and 16 for deep", async () => {
  for (const [depth, steps] of [["quick", 8], ["deep", 16]]) {
    const { fetcher, calls } = fakeServices([article], ['{"action":"scroll","direction":"down"}']);
    const { warning } = await visionAgentResearch(researchTask({ task: "Q?", depth }), { kernelKey: "k", vision }, signal, fetcher);
    assert.equal(calls.vision.length, steps, depth);
    assert.match(warning, /step limit/);
  }
});

test("each step's vision reply has room to think", async () => {
  const { fetcher, calls } = fakeServices([article], ['{"action":"finish"}']);
  await visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, fetcher);
  assert.equal(calls.vision[0].max_tokens, 1200);
});

test("an empty reply is asked again with a shorter prompt, and a second empty reply finishes with the pages kept", async () => {
  const scrolls = Array.from({ length: 7 }, () => '{"action":"scroll","direction":"down"}');
  const { fetcher, calls } = fakeServices([article], ['{"action":"read"}', ...scrolls, "", ""]);
  const steps = [];
  const { sources, warning } = await visionAgentResearch("How do I grow ferns?", { kernelKey: "k", vision }, signal, fetcher, (s) => steps.push(s), { maxSteps: 12 });
  assert.equal(calls.vision.length, 10);
  assert.deepEqual(sources.map((s) => s.url), ["https://example.com/ferns"]);
  assert.match(warning, /stopped replying/);
  const [full, retry] = calls.vision.slice(-2).map(userText);
  assert.ok(retry.length < full.length, "the second ask is shorter");
  assert.equal((full.match(/Scrolled down/g) || []).length, 7);
  assert.equal((retry.match(/Scrolled down/g) || []).length, 5, "it keeps only the last few actions");
  assert.match(retry, /Reply with only one JSON action/);
  assert.equal(calls.deleted, true);
});

test("a reply that is not an allowed action is asked again once in the same step", async () => {
  const { fetcher, calls } = fakeServices([article], ["Let me look at this page first.", '{"action":"read"}', '{"action":"finish"}']);
  const { sources, warning } = await visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, fetcher, undefined, { maxSteps: 2 });
  assert.equal(calls.vision.length, 3);
  assert.equal(sources.length, 1);
  assert.equal(warning, undefined, "the agent finished within its two steps");
});

test("an agent whose vision model stops replying before it read anything fails plainly", async () => {
  const { fetcher, calls } = fakeServices([{ ...page, text: "Results" }], ["", ""]);
  await assert.rejects(visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, fetcher),
    (error) => error instanceof ResearchError && /empty reply/.test(error.message));
  assert.equal(calls.vision.length, 2);
  assert.equal(calls.deleted, true);
});

test("a vision model error after a page was kept ends the run with the pages kept", async () => {
  const { fetcher, calls } = fakeServices([article], ['{"action":"read"}', 503]);
  const { sources, warning } = await visionAgentResearch("How do I grow ferns?", { kernelKey: "k", vision }, signal, fetcher);
  assert.deepEqual(sources.map((s) => s.url), ["https://example.com/ferns"]);
  assert.match(warning, /stopped early after an error/);
  assert.match(warning, /HTTP 503/);
  assert.equal(calls.vision.length, 2, "a failed request is not asked again");
  assert.equal(calls.deleted, true);
});

test("a browser step that fails after a page was kept ends the run with the pages kept", async () => {
  const { fetcher, calls } = fakeServices([article, null], ['{"action":"read"}', '{"action":"click","element":1}']);
  const { sources, warning } = await visionAgentResearch("How do I grow ferns?", { kernelKey: "k", vision }, signal, fetcher);
  assert.deepEqual(sources.map((s) => s.url), ["https://example.com/ferns"]);
  assert.match(warning, /stopped early after an error.*could not carry out that step/);
  assert.equal(calls.kernel.length, 2);
  assert.equal(calls.deleted, true);
});

test("a failure on a readable page keeps that page, and a failure with nothing to keep still fails with its cause", async () => {
  const onArticle = fakeServices([article], [503]);
  const found = await visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, onArticle.fetcher);
  assert.deepEqual(found.sources.map((s) => s.url), ["https://example.com/ferns"]);
  assert.match(found.warning, /HTTP 503/);
  const onSearch = fakeServices([page], [429]);
  await assert.rejects(visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, onSearch.fetcher),
    (error) => error instanceof ResearchError && /rate limited/.test(error.message) && !error.retryable);
  const stepFails = fakeServices([page, null], ['{"action":"click","element":1}']);
  await assert.rejects(visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, stepFails.fetcher),
    (error) => error instanceof ResearchError && /could not carry out that step/.test(error.message));
  assert.equal(stepFails.calls.deleted, true);
});

test("a stop mid-run still stops the agent, whatever it kept", async () => {
  const controller = new AbortController();
  const { fetcher: services } = fakeServices([article], ['{"action":"read"}', '{"action":"scroll","direction":"down"}']);
  let asked = 0;
  const fetcher = async (url, init) => {
    if (!url.startsWith("https://api.onkernel.com") && ++asked === 2) {
      controller.abort(new DOMException("Stopped", "AbortError"));
      throw controller.signal.reason;
    }
    return services(url, init);
  };
  await assert.rejects(visionAgentResearch("Q?", { kernelKey: "k", vision }, controller.signal, fetcher), { name: "AbortError" });
});
