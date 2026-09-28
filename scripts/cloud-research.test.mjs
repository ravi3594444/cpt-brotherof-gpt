import assert from "node:assert/strict";
import {
  browserUseResearch,
  kernelResearch,
  jevChooseEngine,
  jevService,
  parseAgentSources,
} from "../lib/cloud-research.ts";

const signal = new AbortController().signal;
const runId = "00000000-0000-4000-8000-000000000001";
const events = [];
let polls = 0;
const browserFetch = async (url, init) => {
  assert.equal(init.headers["X-Browser-Use-API-Key"], "browser-test-key");
  if (url.endsWith("/runs")) {
    const body = JSON.parse(init.body);
    assert.equal(body.maxCostUsd, 2);
    assert.equal(body.outputSchema.properties.sources.type, "array");
    return Response.json({ id: runId });
  }
  if (url.endsWith("/status")) {
    polls++;
    return Response.json({ status: "completed" });
  }
  assert.equal(url, `https://api.browser-use.com/api/v4/runs/${runId}`);
  return Response.json({
    status: "completed",
    output: {
      sources: [
        {
          url: "https://example.com/shoe",
          title: "Example shoe",
          summary: "A page observed by the browser agent.",
          image: "https://example.com/shoe.jpg",
        },
        { url: "http://127.0.0.1/private", title: "Private host", summary: "Never expose" },
      ],
    },
  });
};
const browser = await browserUseResearch("find something", "browser-test-key", signal, browserFetch, (step) => events.push(step));
assert.equal(polls, 1);
assert.equal(browser.sources.length, 1);
assert.equal(browser.sources[0].image, "https://example.com/shoe.jpg");
assert.match(events.join(" "), /managed browser.*collected 1 source/s);

const kernelCalls = [];
const kernelFetch = async (url, init) => {
  kernelCalls.push({ url, method: init.method });
  assert.equal(init.headers.Authorization, "Bearer kernel-test-key");
  if (init.method === "DELETE") return Response.json({});
  if (url.endsWith("/browsers")) return Response.json({ session_id: "session-12345678" });
  assert.match(JSON.parse(init.body).code, /return out/);
  return Response.json({
    success: true,
    result: [{ title: "A page", url: "https://example.com/article", content: "The page text", read: true }],
  });
};
const kernel = await kernelResearch("test topic", "kernel-test-key", signal, kernelFetch);
assert.equal(kernel.sources[0].read, true);
assert.equal(kernelCalls.at(-1).method, "DELETE");
assert.equal(kernelCalls.length, 3);

const jevFetch = async (_url, init) => {
  assert.equal(init.headers.Authorization, "Bearer jev-test-key");
  assert.equal(JSON.parse(init.body).questions.route.type, "choice");
  return Response.json({ answers: { route: { choice: "kernel", confidence: 0.88 } } });
};
assert.equal(await jevChooseEngine("open this link", jevService({ typesafeKey: "jev-test-key" }), signal, jevFetch), "kernel");
assert.equal(
  parseAgentSources(null, '{"sources":[{"url":"https://example.com/page","title":"Title","summary":"Evidence"}]}').length,
  1,
);
assert.equal(parseAgentSources(null, "No source links were given").length, 0);
console.log("Passed: Browser Use run and source image, Kernel lifecycle cleanup, JEV choice, source validation.");
