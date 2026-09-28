import assert from "node:assert/strict";
import { test } from "node:test";
import { kernelResearch, kernelScript } from "../lib/cloud-research.ts";
import { findPages, researchTask } from "../lib/research.ts";
import { visionAgentResearch } from "../lib/vision-agent.ts";

// How Kernel finds and reads pages. Search engines block cloud browsers (Google, DuckDuckGo) or
// send them results for one word of the query (Bing), so a Search API finds the pages when one is
// connected, and Kernel reads them.

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const long = (words) => `${words} `.repeat(40);
/**
 * Kernel's fixed script, run against a fake browser. `sites` maps an address to what the page
 * shows: its title, its body text, and the text of an article in it.
 */
function fakeBrowser({ results = [], sites = {}, delays = {}, failsWhileRead = [] } = {}) {
  const seen = { searched: [], opened: [], waited: [], open: 0, most: 0, closed: 0 };
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
      const site = () => sites[at] ?? { title: `Title of ${at}`, text: long(`Text of ${at}`) };
      return {
        goto: async (url) => {
          at = url;
          seen.opened.push(url);
          // A page that never loads must not hold the test run open.
          await new Promise((resolve) => setTimeout(resolve, delays[url] ?? 100).unref());
        },
        waitForLoadState: async () => {
          seen.waited.push(at);
          // A page that fills in its text with scripts shows it once it has loaded.
          if (sites[at]?.later) sites[at] = { ...sites[at], text: sites[at].later };
        },
        url: () => at,
        title: async () => site().title,
        // The page's own function runs against a fake document.
        evaluate: async (fn) => {
          const { text, article } = site();
          const saved = globalThis.document;
          globalThis.document = {
            querySelector: (selector) => (selector === "article" && article ? { innerText: article } : null),
            body: { innerText: text },
          };
          try {
            return fn();
          } finally {
            globalThis.document = saved;
            // The browser's own error page replaces one that fails while it is read.
            if (failsWhileRead.includes(at)) at = "chrome-error://chromewebdata/";
          }
        },
        locator: () => ({ first: () => ({ getAttribute: async () => null }) }),
        close: async () => {
          seen.open--;
          seen.closed++;
        },
      };
    },
  };
  return { page, context, seen, run: (code) => new AsyncFunction("page", "context", code)(page, context) };
}
const results = [1, 2, 3, 4, 5].map((n) => ({ url: `https://site${n}.example/ferns`, title: `Ferns guide ${n}` }));

test("without found pages, Kernel searches Bing with the query, never the long task sentence", async () => {
  const browser = fakeBrowser({ results });
  const task = researchTask({ task: "Explain how AI agents search the web and cite what they find", query: "how AI agents search the web" });
  await browser.run(kernelScript(task));
  assert.deepEqual(browser.seen.searched, [`https://www.bing.com/search?setlang=en&q=${encodeURIComponent("how AI agents search the web")}`]);
});

test("Kernel reads its pages side by side, at most four, in the results' order", async () => {
  const browser = fakeBrowser({ results });
  const started = Date.now();
  const out = await browser.run(kernelScript(researchTask("ferns")));
  const took = Date.now() - started;
  assert.ok(took < 300, `four pages of 100 ms each took ${took} ms`);
  assert.equal(browser.seen.most, 4, "all four pages were open at once");
  assert.equal(browser.seen.closed, 4, "every page is closed");
  assert.equal(out.unrelated, false);
  assert.deepEqual(out.pages.map((s) => s.url), results.slice(0, 4).map((r) => r.url));
  assert.deepEqual(Object.keys(out.pages[0]).sort(), ["content", "image", "read", "title", "url"]);
  assert.equal(out.pages[0].read, true);
  assert.equal(out.pages[0].content, long("Text of https://site1.example/ferns").trim());
});

test("a Bing result's redirect link is read as the page it leads to", async () => {
  const address = "https://www.fern-society.example/care?x=1";
  const coded = Buffer.from(address).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const browser = fakeBrowser({ results: [{ url: `https://www.bing.com/ck/a?!&&p=abc&u=a1${coded}&ntb=1`, title: "Fern care" }] });
  const out = await browser.run(kernelScript(researchTask("ferns")));
  assert.deepEqual(browser.seen.opened, [address]);
  assert.deepEqual(out.pages.map((s) => s.url), [address]);
});

test("results for one word of the query are not read, and the script says they were unrelated", async () => {
  // What Bing gave a cloud browser for this query.
  const junk = [
    { url: "https://www.merriam-webster.com/dictionary/best", title: "BEST Definition & Meaning" },
    { url: "https://www.bestbuy.com/", title: "Best Buy | Official Online Store" },
  ];
  const browser = fakeBrowser({ results: junk });
  const out = await browser.run(kernelScript(researchTask({ task: "Best budget phone", query: "best budget phone under 20000" })));
  assert.deepEqual(browser.seen.opened, []);
  assert.deepEqual(out, { pages: [], unrelated: true });
  // A result that shares two of the query's words is relevant.
  const good = fakeBrowser({ results: [...junk, { url: "https://gadgets.example/budget-phones", title: "Best budget phones of 2026" }] });
  const read = await good.run(kernelScript(researchTask({ task: "Best budget phone", query: "best budget phone under 20000" })));
  assert.deepEqual(read.pages.map((s) => s.url), ["https://gadgets.example/budget-phones"]);
});

test("found pages are read without a search; one that cannot be read keeps the search's snippet", async () => {
  const found = [
    { url: "https://a.example/ferns", title: "Ferns A", content: "Snippet A" },
    { url: "https://b.example/ferns", title: "Ferns B", content: "Snippet B" },
    { url: "https://c.example/ferns", title: "Ferns C" },
  ];
  const browser = fakeBrowser({ delays: { "https://b.example/ferns": 60_000, "https://c.example/ferns": 60_000 } });
  const out = await browser.run(kernelScript(researchTask("ferns"), undefined, { found, pageMs: 300 }));
  assert.deepEqual(browser.seen.searched, [], "no search engine");
  assert.deepEqual(out.pages.map((s) => [s.url, s.read]), [["https://a.example/ferns", true], ["https://b.example/ferns", false]]);
  assert.equal(out.pages[1].content, "Snippet B");
  assert.equal(out.unrelated, false);
});

test("once two pages are read, a slow one gets a few seconds more, then its snippet counts", async () => {
  const found = [1, 2, 3, 4].map((n) => ({ url: `https://f${n}.example/ferns`, title: `Ferns ${n}`, content: `Snippet ${n}` }));
  const browser = fakeBrowser({ delays: { "https://f3.example/ferns": 5000, "https://f4.example/ferns": 5000 } });
  const started = Date.now();
  const out = await browser.run(kernelScript(researchTask("ferns"), undefined, { found, graceMs: 200 }));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  assert.deepEqual(out.pages.map((s) => [s.url, s.read]), [
    ["https://f1.example/ferns", true], ["https://f2.example/ferns", true],
    ["https://f3.example/ferns", false], ["https://f4.example/ferns", false],
  ]);
  assert.equal(browser.seen.closed, 4, "every tab is closed");
});

test("a page that never loads is left out after its own time limit, and the others still count", async () => {
  const browser = fakeBrowser({ results, delays: { "https://site2.example/ferns": 60_000 } });
  const started = Date.now();
  const out = await browser.run(kernelScript(researchTask("ferns"), undefined, { pageMs: 300 }));
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(out.pages.map((s) => s.url), ["https://site1.example/ferns", "https://site3.example/ferns", "https://site4.example/ferns"]);
  assert.equal(browser.seen.closed, 4);
});

test("an error page, a bot check, or an empty app shell is not a source; an article's text is preferred", async () => {
  const browser = fakeBrowser({
    results,
    failsWhileRead: ["https://site1.example/ferns"],
    sites: {
      "https://site2.example/ferns": { title: "Just a moment...", text: long("Checking your browser") },
      "https://site3.example/ferns": { title: "App", text: "Loading" },
      "https://site4.example/ferns": { title: "Fern care", text: long("menu") + long("fern care"), article: long("how to care for ferns") },
    },
  });
  const out = await browser.run(kernelScript(researchTask("ferns")));
  assert.deepEqual(out.pages.map((s) => s.url), ["https://site4.example/ferns"]);
  assert.equal(out.pages[0].content, long("how to care for ferns").trim());
  const reddit = fakeBrowser({ results: results.slice(0, 1), sites: {
    "https://site1.example/ferns": { title: "", text: `You've been blocked by network security. ${long("Log in to continue")}` },
  } });
  assert.deepEqual((await reddit.run(kernelScript(researchTask("ferns")))).pages, []);
  // A long article about captchas is not a bot check.
  const article = fakeBrowser({ results: results.slice(0, 1), sites: {
    "https://site1.example/ferns": { title: "How CAPTCHA tests work", text: long("A captcha tells people from bots; this article explains how the tests work.") },
  } });
  assert.equal((await article.run(kernelScript(researchTask("ferns")))).pages.length, 1);
  // A marked-out article too short to be the whole story leaves the page's text.
  const short = fakeBrowser({ results: results.slice(0, 1), sites: { "https://site1.example/ferns": { title: "Ferns", text: long("fern body"), article: "Teaser" } } });
  assert.equal((await short.run(kernelScript(researchTask("ferns")))).pages[0].content, long("fern body").trim());
});

test("a page is read as soon as its document is parsed; one still nearly empty gets a moment to load", async () => {
  const browser = fakeBrowser({
    results: results.slice(0, 2),
    sites: { "https://site2.example/ferns": { title: "App", text: "Loading", later: long("fern app text") } },
  });
  const out = await browser.run(kernelScript(researchTask("ferns")));
  assert.deepEqual(browser.seen.waited, ["https://site2.example/ferns"], "only the empty page waits for load");
  assert.deepEqual(out.pages.map((s) => s.content), [long("Text of https://site1.example/ferns").trim(), long("fern app text").trim()]);
});

test("a pasted link opens directly, and the script stays valid JavaScript for any task", async () => {
  const browser = fakeBrowser({ results });
  const out = await browser.run(kernelScript(researchTask("Summarize https://example.com/a"), "https://example.com/a"));
  assert.deepEqual(browser.seen.searched, [], "no search for a pasted link");
  assert.deepEqual(out.pages.map((s) => s.url), ["https://example.com/a"]);
  for (const task of ["Q with `backticks` and ${braces}?", 'quotes " and \\ and </script>', "line\nbreak"]) {
    const found = [{ url: "https://a.example/x", title: task, content: task }];
    assert.doesNotThrow(() => new AsyncFunction("page", "context", kernelScript(researchTask({ task, query: task }), undefined, { found })));
  }
});

// Kernel and the Search API, faked at the network.
function services({ tavily = [], tavilyStatus = 200, pages } = {}) {
  const calls = { tavily: [], code: "", order: [] };
  const fetcher = async (url, init) => {
    if (url === "https://api.tavily.com/search") {
      calls.order.push("search");
      calls.tavily.push(JSON.parse(init.body));
      return tavilyStatus === 200 ? Response.json({ results: tavily }) : new Response("no", { status: tavilyStatus });
    }
    if (init.method === "DELETE") return Response.json({});
    if (url.endsWith("/browsers")) {
      calls.order.push("browser");
      return Response.json({ session_id: "session-12345678" });
    }
    calls.code = JSON.parse(init.body).code;
    return Response.json({ success: true, result: pages ?? { pages: [{ url: "https://example.com/a", title: "A", content: "Text", read: true }], unrelated: false } });
  };
  return { fetcher, calls };
}
const tavily = [
  { url: "https://guide.example/shade-ferns", title: "Shade ferns guide", content: "Ferns for shade." },
  { url: "http://localhost/private", title: "Private" },
];

test("with a Search API key, the Search API finds the pages while Kernel opens its browser, and Kernel reads them", async () => {
  const { fetcher, calls } = services({ tavily });
  const steps = [];
  await kernelResearch(researchTask({ task: "A long task sentence about ferns", query: "shade ferns" }), "k", new AbortController().signal,
    fetcher, (s) => steps.push(s), {}, "tavily-key");
  assert.deepEqual(calls.order, ["search", "browser"], "the search starts before the browser is ready");
  assert.equal(calls.tavily[0].query, "shade ferns");
  assert.equal(calls.tavily[0].search_depth, "basic", "the fastest search, one credit");
  assert.match(calls.code, /const found = \[\{"url":"https:\/\/guide\.example\/shade-ferns","title":"Shade ferns guide","content":"Ferns for shade\."\}\];/);
  assert.ok(!calls.code.includes("localhost/private"), "only public pages");
  assert.ok(steps.includes("Search API found 1 page for “shade ferns”; Kernel is reading it"), steps.join(" | "));
});

test("without a Search API key, or when it fails, Kernel searches by itself and says so", async () => {
  const plain = services();
  const steps = [];
  await kernelResearch(researchTask({ task: "A long task sentence about ferns", query: "shade ferns" }), "k", new AbortController().signal,
    plain.fetcher, (s) => steps.push(s));
  assert.deepEqual(plain.calls.tavily, []);
  assert.match(plain.calls.code, /const query = "shade ferns";/);
  assert.match(plain.calls.code, /const found = \[\];/);
  assert.ok(steps.includes("Kernel is searching for “shade ferns” and reading public pages"), steps.join(" | "));

  const failing = services({ tavilyStatus: 429 });
  const said = [];
  await kernelResearch("shade ferns", "k", new AbortController().signal, failing.fetcher, (s) => said.push(s), {}, "tavily-key");
  assert.match(failing.calls.code, /const found = \[\];/);
  assert.ok(said.some((s) => s.startsWith("Search API failed (The search service has reached its limit")), said.join(" | "));
  assert.ok(said.includes("Kernel is searching for “shade ferns” and reading public pages"));
});

test("unrelated Bing results fail Kernel's research with a reason, so another engine can try", async () => {
  const { fetcher } = services({ pages: { pages: [], unrelated: true } });
  await assert.rejects(kernelResearch("best budget phone", "k", new AbortController().signal, fetcher),
    /Bing gave the cloud browser results unrelated to the question\. A Search API key finds better pages\./);
});

test("Kernel still reads a script result in the old shape, a plain list of pages", async () => {
  const { fetcher } = services({ pages: [{ url: "https://example.com/a", title: "A", content: "Text", read: true }] });
  const { sources } = await kernelResearch("ferns", "k", new AbortController().signal, fetcher);
  assert.deepEqual(sources.map((s) => s.url), ["https://example.com/a"]);
});

test("a pasted link skips the Search API", async () => {
  const { fetcher, calls } = services({ tavily });
  await kernelResearch("Summarize https://example.com/a", "k", new AbortController().signal, fetcher, undefined, {}, "tavily-key");
  assert.deepEqual(calls.tavily, []);
});

test("finding pages never throws: no key, a failure, or a stop give none", async () => {
  const { fetcher } = services({ tavilyStatus: 500 });
  assert.deepEqual(await findPages("ferns", "", new AbortController().signal, fetcher), []);
  assert.deepEqual(await findPages("ferns", "key", new AbortController().signal, fetcher), []);
  const stop = new AbortController();
  stop.abort();
  const said = [];
  assert.deepEqual(await findPages("ferns", "key", stop.signal, async () => { throw new DOMException("stop", "AbortError"); }, (s) => said.push(s)), []);
  assert.deepEqual(said, [], "a stop is not reported as a failure");
});

test("the vision agent starts on the first page the Search API found, and sees the others", async () => {
  const kernel = [];
  const prompts = [];
  const fetcher = async (url, init) => {
    if (url === "https://api.tavily.com/search")
      return Response.json({ results: [
        { url: "https://found.example/ferns", title: "Fern guide", content: "..." },
        { url: "https://other.example/ferns", title: "More ferns", content: "..." },
      ] });
    if (url.startsWith("https://api.onkernel.com/browsers")) {
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/browsers")) return Response.json({ session_id: "session-12345678" });
      kernel.push(JSON.parse(init.body).code);
      return Response.json({ success: true, result: { url: "https://found.example/ferns", title: "Fern guide", elements: [], text: "Ferns like shade." } });
    }
    prompts.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: '{"action":"read"}' } }] });
  };
  const vision = { baseURL: "https://api.aimlapi.com/v1", apiKey: "aiml-key", model: "deepseek/deepseek-v4.1-flash" };
  const steps = [];
  const { sources } = await visionAgentResearch(researchTask({ task: "Ferns for shade", query: "shade ferns" }),
    { kernelKey: "k", vision, searchKey: "tavily-key" }, new AbortController().signal, fetcher, (s) => steps.push(s), { maxSteps: 1 });
  assert.ok(kernel[0].includes('"https://found.example/ferns"'), "the first step opens the found page");
  assert.ok(!kernel[0].includes("bing.com"));
  assert.ok(steps.includes("Vision agent opened “Fern guide”, the first of 2 pages the Search API found"), steps.join(" | "));
  const text = prompts[0].messages[1].content[0].text;
  assert.match(text, /Pages a web search found \(open any of them\):\n1\. Fern guide — https:\/\/found\.example\/ferns\n2\. More ferns — https:\/\/other\.example\/ferns/);
  assert.deepEqual(sources.map((s) => s.url), ["https://found.example/ferns"]);
});
