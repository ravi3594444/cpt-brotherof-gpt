import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BROWSER_USE_WINDOW_MS,
  createBrowserUseRun,
  pollBrowserUseWindow,
} from "../lib/cloud-research.ts";
import { ResearchError, researchTask } from "../lib/research.ts";
import { newVisionAgent, openVisionBrowser, visionAgentBatch } from "../lib/vision-agent.ts";

// A Research job's Browser Use run: created once, then polled in windows with no time limit.
const api = "https://api.browser-use.com/api/v4";
const runId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-0000000000aa";
const browserId = "00000000-0000-4000-8000-0000000000bb";
const run = { runId, sessionId };
const output = {
  summary: "Linen shirts rate best.",
  sources: [{ url: "https://us.shein.com/Linen-Shirt-p-1.html", title: "Linen shirt", summary: "Rated 4.8 stars." }],
};
const events = [
  { type: "browser.ready", data: { browser_session_id: browserId } },
  { type: "tool.result", data: { name: "navigate", output: { url: "https://us.shein.com/Men-Shirts-c-1979.html", title: "Men's Shirts" } } },
  { type: "tool.result", data: { name: "extract", output: "Top rated: Manfinity linen shirt, 4.8 stars, $12.99." } },
].map((e, i) => ({ runId, id: i + 1, ...e }));

function fakeCloud({ statusAt, costAt = () => "0.10", events: runEvents = [] }) {
  let now = 0;
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = String(url).replace(api, "");
    calls.push({ method, path, at: now, body: init.body });
    assert.equal(init.headers["X-Browser-Use-API-Key"], "bu-key");
    if (method === "POST" && path === "/runs") return Response.json({ id: runId, sessionId, status: "queued" });
    if (path === `/runs/${runId}/status`) return Response.json({ status: statusAt(now) });
    if (path === `/runs/${runId}`) return Response.json({ id: runId, status: statusAt(now), output, result: null });
    if (path === `/sessions/${sessionId}/cost`) return Response.json({ sessionId, totalCostUsd: costAt(now) });
    if (path.startsWith(`/runs/${runId}/events`)) {
      const after = Number(new URL(url).searchParams.get("after") || 0);
      const page = runEvents.filter((e) => e.id > after);
      return Response.json({ events: page, nextAfter: page.at(-1)?.id ?? null, hasMore: false });
    }
    if (method === "POST" && path === `/runs/${runId}/cancel`) return Response.json({ id: runId, status: "cancelled" });
    if (method === "GET" && path.startsWith("/browsers?")) return Response.json({ items: [{ id: browserId }] });
    if (method === "PATCH" && path === `/browsers/${browserId}`) return Response.json({ id: browserId, status: "stopped" });
    throw new Error(`Unexpected ${method} ${url}`);
  };
  const options = (extra = {}) => ({
    until: now + BROWSER_USE_WINDOW_MS,
    maxCostUsd: 2,
    clock: () => now,
    nap: async (ms, signal) => {
      signal.throwIfAborted();
      now += ms;
    },
    ...extra,
  });
  return { fetcher, calls, options, clock: () => now };
}
const signal = new AbortController().signal;
const cancelled = (calls) => calls.some((c) => c.method === "POST" && c.path === `/runs/${runId}/cancel`);
const stopped = (calls) => calls.some((c) => c.method === "PATCH" && c.path === `/browsers/${browserId}`);
const fresh = { status: "", misses: 0, windows: 0 };

test("a Research job polls a Browser Use run across windows with no time limit until it completes", async () => {
  // Ten minutes: far past the in-request research budget of 200 seconds.
  const cloud = fakeCloud({ statusAt: (now) => (now < 600_000 ? "running" : "completed") });
  const steps = [];
  let poll = fresh;
  let window;
  let windows = 0;
  for (;;) {
    windows++;
    window = await pollBrowserUseWindow(run, "bu-key", signal, cloud.fetcher, (s) => steps.push(s), poll, cloud.options());
    if (window.done) break;
    assert.ok(!cancelled(cloud.calls) && !stopped(cloud.calls), "a run still going is left running between windows");
    poll = window.poll;
  }
  assert.equal(windows, 3);
  assert.equal(poll.windows, 2);
  assert.deepEqual(window.result.sources.map((s) => s.url), ["https://us.shein.com/Linen-Shirt-p-1.html"]);
  assert.match(window.result.warning, /summaries/);
  assert.deepEqual(steps.filter((s) => /visiting pages/.test(s)), ["Browser agent is visiting pages"], "a status change is reported once");
  assert.ok(!cancelled(cloud.calls), "a completed run is not cancelled");
  assert.ok(stopped(cloud.calls), "its browser is stopped before the step returns");
  const polls = cloud.calls.filter((c) => c.path === `/runs/${runId}/status`);
  for (let i = 1; i < polls.length; i++) assert.ok(polls[i].at - polls[i - 1].at >= 3000, "polls about every 3 s");
});

test("a failed run keeps the pages it reached, and is not cancelled", async () => {
  const cloud = fakeCloud({ statusAt: (now) => (now < 30_000 ? "running" : "failed"), events });
  const window = await pollBrowserUseWindow(run, "bu-key", signal, cloud.fetcher, undefined, fresh, cloud.options());
  assert.equal(window.done, true);
  assert.equal(window.result.warning, "The browser agent stopped early; these are the pages it had reached");
  assert.deepEqual(window.result.sources.map((s) => s.url), ["https://us.shein.com/Men-Shirts-c-1979.html"]);
  assert.ok(!cancelled(cloud.calls));
  assert.ok(stopped(cloud.calls));
});

test("a run that reaches the cost cap is cancelled and keeps the pages it reached", async () => {
  const cloud = fakeCloud({ statusAt: () => "running", costAt: (now) => (now < 120_000 ? "0.80" : "2.05"), events });
  const steps = [];
  const window = await pollBrowserUseWindow(run, "bu-key", signal, cloud.fetcher, (s) => steps.push(s), fresh, cloud.options());
  assert.equal(window.done, true);
  assert.match(window.result.warning, /cost limit/);
  assert.equal(window.result.sources.length, 1);
  assert.ok(steps.includes("Browser Use Cloud reached the $2 research cost limit"));
  assert.ok(cancelled(cloud.calls) && stopped(cloud.calls));
  const costReads = cloud.calls.filter((c) => c.path === `/sessions/${sessionId}/cost`);
  for (let i = 1; i < costReads.length; i++) assert.ok(costReads[i].at - costReads[i - 1].at >= 60_000, "the cost is read about once a minute");
});

test("a run that reaches the cost cap with nothing usable is a research error that is not retried", async () => {
  const cloud = fakeCloud({ statusAt: () => "running", costAt: () => "3.00" });
  await assert.rejects(
    pollBrowserUseWindow(run, "bu-key", signal, cloud.fetcher, undefined, fresh, cloud.options({ maxCostUsd: 2.5 })),
    (error) => error instanceof ResearchError && !error.retryable && /\$2\.5 research cost limit/.test(error.message),
  );
  assert.ok(cancelled(cloud.calls) && stopped(cloud.calls));
});

test("a stopped job cancels the run and stops its browser before the step returns", async () => {
  const controller = new AbortController();
  const cloud = fakeCloud({ statusAt: () => "running" });
  const options = cloud.options();
  const nap = options.nap;
  options.nap = async (ms, s) => {
    await nap(ms, s);
    if (cloud.clock() >= 9000) controller.abort(new DOMException("The job was cancelled", "AbortError"));
    s.throwIfAborted();
  };
  await assert.rejects(
    pollBrowserUseWindow(run, "bu-key", controller.signal, cloud.fetcher, undefined, fresh, options),
    { name: "AbortError" },
  );
  assert.ok(cancelled(cloud.calls) && stopped(cloud.calls), "released, and awaited, before the step returns");
});

test("the safety net stops a run after too many windows, and logs it", async () => {
  const cloud = fakeCloud({ statusAt: () => "running", events });
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const window = await pollBrowserUseWindow(run, "bu-key", signal, cloud.fetcher, undefined,
      { status: "running", misses: 0, windows: 2 }, cloud.options({ maxWindows: 2 }));
    assert.equal(window.done, true);
    assert.match(window.result.warning, /stopped early/);
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /after 2 poll windows/);
  assert.ok(cancelled(cloud.calls) && stopped(cloud.calls));
  assert.ok(!cloud.calls.some((c) => c.path === `/runs/${runId}/status`), "it does not poll again");
});

test("a Research job's run is created with the configured cost cap", async () => {
  const cloud = fakeCloud({ statusAt: () => "queued" });
  const created = await createBrowserUseRun("shirts", "bu-key", signal, cloud.fetcher, {
    maxCostUsd: 5, timeout: AbortSignal.timeout(30_000),
  });
  assert.deepEqual(created, run);
  assert.equal(JSON.parse(cloud.calls[0].body).maxCostUsd, 5);
});

// A fake Kernel browser plus vision model; each vision model reply takes 20 s on the clock, and each
// browser action `actionMs`. A null page is a step Kernel could not carry out; a number reply, an HTTP status.
function fakeVision(pages, replies, { replyMs = 20_000, actionMs = 0 } = {}) {
  let now = 0;
  const calls = { kernel: [], vision: [], deleted: 0, created: [] };
  let p = 0;
  let r = 0;
  const fetcher = async (url, init) => {
    if (url.startsWith("https://api.onkernel.com/browsers")) {
      if (init.method === "DELETE") {
        calls.deleted++;
        return new Response(null, { status: 204 });
      }
      if (url.endsWith("/browsers")) {
        calls.created.push(JSON.parse(init.body));
        return Response.json({ session_id: "session-12345678" });
      }
      const code = JSON.parse(init.body).code;
      calls.kernel.push(code);
      if (!code.includes("const action = null;")) now += actionMs;
      const next = pages[Math.min(p++, pages.length - 1)];
      return Response.json(next === null ? { success: false } : { success: true, result: next });
    }
    now += replyMs;
    calls.vision.push(JSON.parse(init.body));
    const reply = replies[Math.min(r++, replies.length - 1)];
    if (typeof reply === "number") return new Response("busy", { status: reply });
    return Response.json({ choices: [{ message: { content: reply } }] });
  };
  return { fetcher, calls, clock: () => now };
}
const vision = { baseURL: "https://api.aimlapi.com/v1", apiKey: "aiml-key", model: "deepseek/deepseek-v4.1-flash" };
const article = {
  url: "https://example.com/ferns",
  title: "How to grow ferns",
  elements: [{ id: 1, role: "link", label: "Home" }],
  text: "Ferns like shade and damp soil.",
  screenshot: "U0NSRUVO",
};
const keys = { kernelKey: "k", vision };

test("a Research job's vision agent opens its browser with a Kernel timeout as a backstop", async () => {
  const services = fakeVision([article], []);
  assert.equal(await openVisionBrowser("k", signal, services.fetcher, undefined, 120), "session-12345678");
  assert.deepEqual(services.calls.created, [{ timeout_seconds: 120 }]);
});

test("a Research job's vision agent takes its turns in batches that fit a step, with plain state and no screenshots", async () => {
  const scrolls = Array.from({ length: 9 }, () => '{"action":"scroll","direction":"down"}');
  const services = fakeVision([article], [...scrolls, '{"action":"read"}', '{"action":"finish"}']);
  let agent = newVisionAgent("session-12345678", researchTask({ task: "How do I grow ferns?", depth: "deep" }));
  const steps = [];
  const batches = [];
  for (;;) {
    const batch = await visionAgentBatch(agent, keys, signal, services.fetcher, (s) => steps.push(s),
      { until: services.clock() + 240_000, clock: services.clock });
    batches.push(batch.agent.turns);
    assert.ok(!/screenshot|U0NSRUVO/.test(JSON.stringify(batch.agent)), "screenshots never leave the step");
    agent = batch.agent;
    if (batch.done) {
      assert.deepEqual(batch.result.sources.map((s) => s.url), ["https://example.com/ferns"]);
      assert.equal(batch.result.warning, undefined);
      break;
    }
  }
  // A turn starts only while more than 140 s of the 240 s window are left: 5 turns 20 s apart.
  assert.deepEqual(batches, [5, 10, 11]);
  assert.match(services.calls.kernel[0], /bing\.com\/search/);
  assert.ok(services.calls.kernel.some((code) => code.includes('const start = "";\nconst action = null;')),
    "a later batch looks at the page again before its first turn");
  assert.equal(services.calls.deleted, 0, "the job closes the browser itself after the last batch");
  assert.ok(steps.includes("Read “How to grow ferns”"));
});

test("a Research job's vision agent may take up to 10 turns for quick research and 40 for deep", async () => {
  for (const [depth, turns] of [["quick", 10], ["deep", 40]]) {
    const services = fakeVision([article], ['{"action":"scroll","direction":"down"}']);
    const batch = await visionAgentBatch(newVisionAgent("session-12345678", researchTask({ task: "Q?", depth })), keys, signal,
      services.fetcher, undefined, { until: Infinity, clock: services.clock });
    assert.equal(batch.done, true);
    assert.equal(batch.agent.turns, turns, depth);
    assert.equal(services.calls.vision.length, turns);
    assert.match(batch.result.warning, /step limit/);
    assert.equal(batch.result.sources[0].url, "https://example.com/ferns");
  }
});

test("a Research job's vision agent keeps its query and depth as plain data, and starts with the query", async () => {
  const agent = newVisionAgent("session-12345678", researchTask({ task: "A long sentence about growing ferns", query: "fern care", depth: "deep" }));
  assert.equal(agent.query, "fern care");
  assert.equal(agent.depth, "deep");
  assert.deepEqual(structuredClone(agent), agent);
  const services = fakeVision([article], ['{"action":"finish"}']);
  await visionAgentBatch(agent, keys, signal, services.fetcher, undefined, { until: Infinity, clock: services.clock });
  assert.match(services.calls.kernel[0], /bing\.com\/search\?q=fern%20care"/);
});

test("a stopped job closes the vision agent's browser in the batch it stopped", async () => {
  const services = fakeVision([article], ['{"action":"scroll","direction":"down"}']);
  const controller = new AbortController();
  controller.abort(new DOMException("The job was cancelled", "AbortError"));
  await assert.rejects(visionAgentBatch({ ...newVisionAgent("session-12345678", "Q?"), started: true }, keys,
    controller.signal, services.fetcher, undefined, { until: Infinity, clock: services.clock }), { name: "AbortError" });
  assert.equal(services.calls.deleted, 1);
});

test("a Research job's vision agent ends with the pages it kept when the vision model or a browser step fails", async () => {
  const cases = [
    [fakeVision([article], ['{"action":"read"}', 503]), /HTTP 503/],
    [fakeVision([article, null], ['{"action":"read"}', '{"action":"click","element":1}']), /could not carry out that step/],
  ];
  for (const [services, why] of cases) {
    const batch = await visionAgentBatch(newVisionAgent("session-12345678", "How do I grow ferns?"), keys, signal,
      services.fetcher, undefined, { until: Infinity, clock: services.clock });
    assert.equal(batch.done, true);
    assert.deepEqual(batch.result.sources.map((s) => s.url), ["https://example.com/ferns"]);
    assert.match(batch.result.warning, /stopped early after an error/);
    assert.match(batch.result.warning, why);
    assert.equal(services.calls.deleted, 0, "the job closes the browser after the last batch");
  }
});

test("a later batch whose first look at the page fails keeps the pages the earlier batches read", async () => {
  const first = fakeVision([article], ['{"action":"read"}', '{"action":"scroll","direction":"down"}']);
  const before = await visionAgentBatch(newVisionAgent("session-12345678", "How do I grow ferns?"), keys, signal,
    first.fetcher, undefined, { until: 150_000, clock: first.clock });
  assert.equal(before.done, false);
  assert.equal(before.agent.kept.length, 1);
  const later = fakeVision([null], ['{"action":"finish"}']);
  const batch = await visionAgentBatch(before.agent, keys, signal, later.fetcher, undefined, { until: Infinity, clock: later.clock });
  assert.equal(batch.done, true);
  assert.deepEqual(batch.result.sources.map((s) => s.url), ["https://example.com/ferns"]);
  assert.match(batch.result.warning, /stopped early after an error/);
  assert.equal(later.calls.vision.length, 0);
});

test("a Research job's vision agent with nothing kept still fails with the cause", async () => {
  const services = fakeVision([{ ...article, url: "https://www.bing.com/search?q=ferns" }], [402]);
  await assert.rejects(visionAgentBatch(newVisionAgent("session-12345678", "Q?"), keys, signal, services.fetcher, undefined,
    { until: Infinity, clock: services.clock }), (error) => error instanceof ResearchError && /insufficient credit/.test(error.message));
});

test("a batch never runs past its window, even when a turn asks the vision model twice and then steps", async () => {
  // The slowest turn: an unusable reply and the shorter ask again, 45 s each, then a 50 s browser step.
  const replies = ['{"action":"read"}', '{"action":"read"}', '{"action":"read"}',
    ...Array.from({ length: 6 }, (_, i) => (i % 2 ? '{"action":"scroll","direction":"down"}' : "Let me think."))];
  const services = fakeVision([article], replies, { replyMs: 45_000, actionMs: 50_000 });
  const until = services.clock() + 240_000;
  const batch = await visionAgentBatch(newVisionAgent("session-12345678", "Q?"), keys, signal, services.fetcher, undefined,
    { until, clock: services.clock });
  assert.equal(batch.done, false);
  assert.ok(services.clock() <= until, `the batch ended ${services.clock() - until} ms past its window`);
});
