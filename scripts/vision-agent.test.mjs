import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentAction, visionAgentResearch } from "../lib/vision-agent.ts";
import { ResearchError } from "../lib/research.ts";

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
      return Response.json({ success: true, result: pages[Math.min(p++, pages.length - 1)] });
    }
    calls.vision.push(JSON.parse(init.body));
    const reply = replies[Math.min(r++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return Response.json({ choices: [{ message: { content: reply } }] });
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
  const { fetcher, calls } = fakeServices([article], [new TypeError("network down")]);
  await assert.rejects(() => visionAgentResearch("Q?", { kernelKey: "k", vision }, signal, fetcher));
  assert.equal(calls.deleted, true);
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
