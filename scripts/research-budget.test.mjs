import assert from "node:assert/strict";
import { test } from "node:test";
import { browserUseResearch, kernelResearch } from "../lib/cloud-research.ts";
import { ResearchError } from "../lib/research.ts";

// Browser Use Cloud and Kernel under one research deadline, on a fake clock.
const signal = new AbortController().signal;
const api = "https://api.browser-use.com/api/v4";
const runId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-0000000000aa";
const browserId = "00000000-0000-4000-8000-0000000000bb";
const ts = "2026-09-27T12:00:00Z";
const agentOutput = {
  summary: "Linen shirts rate best.",
  sources: [{ url: "https://us.shein.com/Linen-Shirt-p-1.html", title: "Linen shirt", summary: "Rated 4.8 stars." }],
};
// What the agent had done when time ran out: browser readiness, tool activity, an artifact.
const agentEvents = [
  { type: "run.started", data: {} },
  { type: "browser.ready", data: { browser_session_id: browserId, live_view_url: "https://live.browser-use.com/?wss=secret-token" } },
  { type: "tool.call", data: { name: "navigate", input: { url: "https://www.google.com/search?q=shein+shirts" } } },
  { type: "tool.call", data: { name: "navigate", input: { url: "https://us.shein.com/Men-Shirts-c-1979.html" } } },
  { type: "tool.result", data: { name: "navigate", output: { url: "https://us.shein.com/Men-Shirts-c-1979.html", title: "Men's Shirts | SHEIN USA" } } },
  { type: "tool.result", data: { name: "extract", output: "Top rated: Manfinity linen shirt, 4.8 stars, $12.99; Oxford shirt, 4.6 stars." } },
  { type: "tool.call", data: { name: "navigate", input: { url: "http://127.0.0.1/admin" } } },
  { type: "artifact.created", data: { url: "https://files.s3.amazonaws.com/shot.png?X-Amz-Signature=abc" } },
  { type: "tool.call", data: { name: "navigate", input: { url: "https://us.shein.com/Oxford-Shirt-p-2.html#reviews" } } },
  { type: "tool.call", data: { name: "navigate", input: { url: "https://us.shein.com/Oxford-Shirt-p-2.html" } } },
].map((e, i) => ({ runId, id: i + 1, ts, ...e }));

// A fake Browser Use Cloud: `statusAt(now)` scripts the run; events come two per page.
function fakeCloud({ statusAt, output = agentOutput, events = [], failStatusAt = [], throttled = false }) {
  let now = 0;
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = String(url).replace(api, "");
    calls.push({ method, path, at: now, body: init.body });
    assert.equal(init.headers["X-Browser-Use-API-Key"], "bu-key");
    if (method === "POST" && path === "/runs") return Response.json({ id: runId, sessionId, status: "queued" });
    if (path === `/runs/${runId}/status`) {
      if (throttled) return Response.json({ error: "rate_limited", limit_rps: 25 }, { status: 429 });
      if (failStatusAt.includes(now)) return new Response("busy", { status: 503 });
      return Response.json({ status: statusAt(now) });
    }
    if (path === `/runs/${runId}`) return Response.json({ id: runId, sessionId, status: statusAt(now), output, result: null });
    if (path.startsWith(`/runs/${runId}/events`)) {
      const after = Number(new URL(url).searchParams.get("after") || 0);
      const page = events.filter((e) => e.id > after).slice(0, 2);
      const last = page.at(-1)?.id ?? after;
      return Response.json({ events: page, nextAfter: page.length ? last : null, hasMore: events.some((e) => e.id > last) });
    }
    if (method === "POST" && path === `/runs/${runId}/cancel`) return Response.json({ id: runId, status: "cancelled" });
    if (method === "GET" && path.startsWith("/browsers?"))
      return Response.json({ items: [{ id: browserId, status: "active" }], totalItems: 1, pageNumber: 1, pageSize: 10 });
    if (method === "PATCH" && path === `/browsers/${browserId}`) return Response.json({ id: browserId, status: "stopped" });
    throw new Error(`Unexpected ${method} ${url}`);
  };
  const time = { deadline: 190_000, clock: () => now, nap: async (ms) => { now += ms; } };
  return { fetcher, calls, time, advance: (ms) => { now += ms; } };
}
// Cancelling a run and stopping its browser happen in the background.
async function eventually(check) {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  return check();
}
const stopped = (calls) => calls.some((c) => c.method === "PATCH" && c.path === `/browsers/${browserId}` &&
  JSON.parse(c.body).action === "stop");
const cancelled = (calls) => calls.some((c) => c.method === "POST" && c.path === `/runs/${runId}/cancel`);

test("a Browser Use run that needs 150 seconds succeeds, polled on the status endpoint", { timeout: 5000 }, async () => {
  const cloud = fakeCloud({ statusAt: (now) => (now < 150_000 ? "running" : "completed") });
  const steps = [];
  const result = await browserUseResearch("best shirts on shein", "bu-key", signal, cloud.fetcher, (s) => steps.push(s), cloud.time);
  assert.deepEqual(result.sources.map((s) => s.url), ["https://us.shein.com/Linen-Shirt-p-1.html"]);
  assert.equal(result.sources[0].read, false);
  assert.match(result.warning, /summaries/);
  const polls = cloud.calls.filter((c) => c.path === `/runs/${runId}/status`);
  assert.ok(polls.length >= 70 && polls.length <= 80, `${polls.length} status polls`);
  for (let i = 1; i < polls.length; i++) assert.ok(polls[i].at - polls[i - 1].at >= 2000, "polls about every 2 s");
  const full = cloud.calls.filter((c) => c.path === `/runs/${runId}`);
  assert.equal(full.length, 1, "the full run is read once, after it completes");
  assert.ok(full[0].at >= 150_000);
  assert.ok(!cancelled(cloud.calls), "a completed run is not cancelled");
  assert.match(steps.join(" | "), /visiting pages.*collected 1 source/);
});

test("the cloud browser is stopped after a normal completion", { timeout: 5000 }, async () => {
  const cloud = fakeCloud({ statusAt: (now) => (now < 4000 ? "running" : "completed") });
  await browserUseResearch("q", "bu-key", signal, cloud.fetcher, undefined, cloud.time);
  assert.ok(await eventually(() => stopped(cloud.calls)), JSON.stringify(cloud.calls.map((c) => `${c.method} ${c.path}`)));
  assert.ok(cloud.calls.some((c) => c.path === `/browsers?agentSessionId=${sessionId}&filterBy=active`));
});

test("when time runs out, the pages the agent reached become sources and the run is released", { timeout: 5000 }, async () => {
  const cloud = fakeCloud({ statusAt: () => "running", events: agentEvents });
  const steps = [];
  const result = await browserUseResearch("best shirts on shein", "bu-key", signal, cloud.fetcher, (s) => steps.push(s), cloud.time);
  assert.equal(result.warning, "The browser agent ran out of time; these are the pages it had reached");
  assert.deepEqual(result.sources.map((s) => [s.url, s.title, s.read]), [
    ["https://us.shein.com/Men-Shirts-c-1979.html", "Men's Shirts | SHEIN USA", false],
    ["https://us.shein.com/Oxford-Shirt-p-2.html", "us.shein.com", false],
  ]);
  assert.match(result.sources[0].content, /Manfinity linen shirt, 4\.8 stars/);
  const text = JSON.stringify(result);
  assert.ok(!/secret-token|127\.0\.0\.1|X-Amz|google\.com/.test(text), text);
  // Every event page is read with the previous cursor, and research ends by its deadline.
  const reads = cloud.calls.filter((c) => c.path.startsWith(`/runs/${runId}/events`));
  assert.deepEqual(reads.map((c) => new URL(api + c.path).searchParams.get("after")), ["0", "2", "4", "6", "8"]);
  assert.ok(cloud.calls.every((c) => c.at <= cloud.time.deadline), "no request after the deadline");
  assert.ok(await eventually(() => cancelled(cloud.calls) && stopped(cloud.calls)));
  // The browser came from the run's own browser.ready event.
  assert.ok(!cloud.calls.some((c) => c.path.startsWith("/browsers?")));
  assert.match(steps.join(" | "), /Kept 2 pages the browser agent had reached/);
});

test("a run that reached nothing usable by the deadline is a plain research error", { timeout: 5000 }, async () => {
  const cloud = fakeCloud({ statusAt: () => "running", events: agentEvents.slice(0, 3) });
  await assert.rejects(
    browserUseResearch("q", "bu-key", signal, cloud.fetcher, undefined, cloud.time),
    (error) => error instanceof ResearchError && /ran out of time/.test(error.message),
  );
  assert.ok(await eventually(() => cancelled(cloud.calls) && stopped(cloud.calls)));
});

test("a failed run keeps the pages it reached", { timeout: 5000 }, async () => {
  const cloud = fakeCloud({ statusAt: (now) => (now < 30_000 ? "running" : "failed"), events: agentEvents });
  const result = await browserUseResearch("q", "bu-key", signal, cloud.fetcher, undefined, cloud.time);
  assert.equal(result.sources.length, 2);
  assert.equal(result.warning, "The browser agent stopped early; these are the pages it had reached");
  assert.ok(await eventually(() => stopped(cloud.calls)));
  assert.ok(!cancelled(cloud.calls), "a failed run needs no cancel");
});

test("a failed run with nothing reached says the run did not complete", { timeout: 5000 }, async () => {
  const cloud = fakeCloud({ statusAt: (now) => (now < 6000 ? "running" : "failed") });
  await assert.rejects(browserUseResearch("q", "bu-key", signal, cloud.fetcher, undefined, cloud.time), /did not complete/);
});

test("one slow status poll does not end the run", { timeout: 5000 }, async () => {
  const cloud = fakeCloud({ statusAt: (now) => (now < 8000 ? "running" : "completed"), failStatusAt: [2000] });
  const result = await browserUseResearch("q", "bu-key", signal, cloud.fetcher, undefined, cloud.time);
  assert.equal(result.sources.length, 1);
});

test("status polls that keep failing end the run with their reason, after backing off", { timeout: 5000 }, async () => {
  const cloud = fakeCloud({ statusAt: () => "running", throttled: true });
  await assert.rejects(browserUseResearch("q", "bu-key", signal, cloud.fetcher, undefined, cloud.time), /rate limited/);
  const polls = cloud.calls.filter((c) => c.path === `/runs/${runId}/status`);
  assert.deepEqual(polls.map((c) => c.at), [0, 5000, 10_000]);
  assert.ok(await eventually(() => cancelled(cloud.calls) && stopped(cloud.calls)));
});

test("a stopped request cancels the run and stops its browser", { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const cloud = fakeCloud({ statusAt: () => "running" });
  const nap = async (ms, s) => {
    cloud.advance(ms);
    if (cloud.time.clock() >= 10_000) controller.abort(new DOMException("The user stopped", "AbortError"));
    s.throwIfAborted();
  };
  await assert.rejects(
    browserUseResearch("q", "bu-key", controller.signal, cloud.fetcher, undefined, { ...cloud.time, nap }),
    { name: "AbortError" },
  );
  assert.ok(await eventually(() => cancelled(cloud.calls) && stopped(cloud.calls)));
});

// A fake Kernel that records its requests.
function fakeKernel() {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (init.method === "DELETE") return Response.json({});
    if (url.endsWith("/browsers")) return Response.json({ session_id: "session-12345678" });
    return Response.json({ success: true, result: [{ title: "A page", url: "https://example.com/a", content: "Text", read: true }] });
  };
  return { fetcher, calls };
}

test("Kernel fits its page reading into the time research has left", async () => {
  const kernel = fakeKernel();
  await kernelResearch("q", "k", signal, kernel.fetcher, undefined, { deadline: 30_000, clock: () => 0 });
  const execute = JSON.parse(kernel.calls.find((c) => c.url.endsWith("/playwright/execute")).body);
  assert.ok(execute.timeout_sec <= 23 && execute.timeout_sec >= 15, String(execute.timeout_sec));
  assert.equal(kernel.calls.at(-1).method, "DELETE");

  const roomy = fakeKernel();
  await kernelResearch("q", "k", signal, roomy.fetcher, undefined, { deadline: 600_000, clock: () => 0 });
  assert.equal(JSON.parse(roomy.calls[1].body).timeout_sec, 58);
});

test("Kernel does not open a browser it has no time to use", async () => {
  const kernel = fakeKernel();
  await assert.rejects(
    kernelResearch("q", "k", signal, kernel.fetcher, undefined, { deadline: 10_000, clock: () => 0 }),
    ResearchError,
  );
  assert.equal(kernel.calls.length, 0);
});
