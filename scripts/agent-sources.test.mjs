import assert from "node:assert/strict";
import { test } from "node:test";
import { browserUseResearch, parseAgentSources } from "../lib/cloud-research.ts";

const sourcesJson = JSON.stringify({
  summary: "Both pages agree.",
  sources: [
    { url: "https://example.com/a", title: "Page A", summary: "A says the sky is blue." },
    { url: "https://example.com/b", title: "Page B", summary: "B says the sea is blue." },
  ],
});
const expectAB = (sources) => {
  assert.deepEqual(
    sources.map(({ url, title, content }) => ({ url, title, content })),
    [
      { url: "https://example.com/a", title: "Page A", content: "A says the sky is blue." },
      { url: "https://example.com/b", title: "Page B", content: "B says the sea is blue." },
    ],
  );
};

test("reads sources from a prose answer that ends with a fenced JSON block", () => {
  expectAB(parseAgentSources(null, `Here is a short synthesis of what I found.\n\n\`\`\`json\n${sourcesJson}\n\`\`\``));
});

test("reads sources from prose followed by a bare JSON object", () => {
  expectAB(parseAgentSources(null, `Short synthesis: both pages agree. ${sourcesJson}`));
});

test("still reads a result that is only JSON", () => {
  expectAB(parseAgentSources(null, sourcesJson));
});

test("never labels a browser agent's summary as page content read", async () => {
  const runId = "00000000-0000-4000-8000-000000000002";
  const fetcher = async (url) =>
    url.endsWith("/runs")
      ? Response.json({ id: runId })
      : Response.json({
          status: "completed",
          output: { sources: [{ url: "https://example.com/a", title: "A", summary: "Agent summary", read: true }] },
        });
  const { sources } = await browserUseResearch("q", "key", new AbortController().signal, fetcher);
  assert.equal(sources[0].read, false);
});
