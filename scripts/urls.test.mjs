import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPublicUrls } from "../lib/research.ts";
import { kernelResearch, parseAgentSources } from "../lib/cloud-research.ts";

test("drops sentence punctuation after a pasted link", () => {
  assert.deepEqual(extractPublicUrls("Summarize https://example.com/article."), ["https://example.com/article"]);
  assert.deepEqual(extractPublicUrls("Is https://example.com/a?b=1 good?!"), ["https://example.com/a?b=1"]);
  assert.deepEqual(
    extractPublicUrls("Compare https://a.example.com/x, https://b.example.com/y; thanks"),
    ["https://a.example.com/x", "https://b.example.com/y"],
  );
});

test("drops a closing bracket that wraps a link but keeps balanced ones in the URL", () => {
  assert.deepEqual(extractPublicUrls("(see https://example.com/page)."), ["https://example.com/page"]);
  assert.deepEqual(extractPublicUrls("[docs](https://example.com/docs)"), ["https://example.com/docs"]);
  assert.deepEqual(
    extractPublicUrls("Read https://en.wikipedia.org/wiki/Mercury_(planet)."),
    ["https://en.wikipedia.org/wiki/Mercury_(planet)"],
  );
});

test("keeps only public links, once each, in the order written", () => {
  assert.deepEqual(
    extractPublicUrls("http://localhost:3000/x then https://example.com/b and https://example.com/a and https://example.com/b"),
    ["https://example.com/b", "https://example.com/a"],
  );
  assert.deepEqual(extractPublicUrls("no links here"), []);
});

test("Kernel opens a pasted link without its trailing full stop", async () => {
  let code = "";
  const fetcher = async (url, init) => {
    if (init.method === "DELETE") return Response.json({});
    if (url.endsWith("/browsers")) return Response.json({ session_id: "session-12345678" });
    code = JSON.parse(init.body).code;
    return Response.json({ success: true, result: [{ url: "https://example.com/article", title: "A", content: "Text", read: true }] });
  };
  await kernelResearch("Summarize https://example.com/article.", "key", new AbortController().signal, fetcher);
  assert.match(code, /const direct = "https:\/\/example\.com\/article";/);
});

test("links recovered from an agent's prose keep balanced parentheses", () => {
  const sources = parseAgentSources(null, "I read https://en.wikipedia.org/wiki/Mercury_(planet).");
  assert.deepEqual(sources.map((s) => s.url), ["https://en.wikipedia.org/wiki/Mercury_(planet)"]);
});
