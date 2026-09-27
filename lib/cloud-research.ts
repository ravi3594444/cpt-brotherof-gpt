import type { ResearchSource } from "./chat-types";
import { extractPublicUrls, isSearchPage, publicUrl, ResearchError } from "./research.ts";

export type BrowserEngine = "browser_use" | "kernel" | "vision_agent";
export type ResearchEngine = "auto" | BrowserEngine | "tavily";
type Fetcher = typeof fetch;
type BrowserResult = { sources: ResearchSource[]; warning?: string };
type Progress = (description: string) => void;
/** When research must end (epoch ms), and the clock it runs on; tests pass a fake clock. */
export type ResearchTime = {
  deadline?: number;
  clock?: () => number;
  nap?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const browserUseApi = "https://api.browser-use.com/api/v4";
const browserUseBase = `${browserUseApi}/runs`;
const UUID = /^[0-9a-f-]{36}$/i;
// Status reads have their own rate bucket. Polling stops this long before the
// deadline, to read the run's events for the pages the agent reached.
const POLL_MS = 2000;
const SALVAGE_MS = 8000;
const OUT_OF_TIME = "The browser agent ran out of time; these are the pages it had reached";
const STOPPED_EARLY = "The browser agent stopped early; these are the pages it had reached";
export const kernelBase = "https://api.onkernel.com/browsers";
export const ENGINE_LABELS: Record<Exclude<ResearchEngine, "auto">, string> = {
  browser_use: "Browser Use Cloud",
  kernel: "Kernel",
  vision_agent: "Vision agent",
  tavily: "Search API",
};
// What JEV weighs for each engine it may choose.
const JEV_CRITERIA: Record<BrowserEngine, string> = {
  kernel: "Read a public page URL or quickly search and extract a few straightforward public pages.",
  browser_use: "Navigate complex websites, compare many pages, interact with dynamic pages, or resolve uncertain steps with a browser agent.",
  vision_agent: "Look at pages to find things: visual or image-heavy pages, products, layouts, charts, or clicking through a site's own menus and search.",
};
const nap = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });

export async function jsonResponse<T>(response: Response, service: string): Promise<T> {
  if (!response.ok)
    throw new ResearchError(
      response.status === 401 || response.status === 403
        ? `${service} rejected its server key. Check the workspace connection.`
        : response.status === 402
          ? `${service} has insufficient credit.`
          : response.status === 429
            ? `${service} is rate limited. Try again later.`
            : `${service} could not complete this request (HTTP ${response.status}).`,
    );
  try {
    return (await response.json()) as T;
  } catch {
    throw new ResearchError(`${service} returned an unreadable response.`);
  }
}

function sourceFromUnknown(value: unknown): ResearchSource | undefined {
  if (!value || typeof value !== "object") return;
  const s = value as Record<string, unknown>;
  const url = typeof s.url === "string" && publicUrl(s.url);
  if (!url) return;
  return {
    url,
    title: typeof s.title === "string" && s.title.trim()
      ? s.title.slice(0, 220)
      : new URL(url).hostname,
    content: typeof s.summary === "string"
      ? s.summary.slice(0, 6000)
      : typeof s.content === "string"
        ? s.content.slice(0, 6000)
        : "",
    read: s.read === true,
    image: typeof s.image === "string" && s.image.startsWith("https:")
      ? publicUrl(s.image)
      : undefined,
  };
}

// Browser Use v4 may ignore outputSchema and return text: pure JSON, a fenced
// JSON block after prose, or prose followed by a bare object.
export function jsonIn(text: string): unknown {
  const candidates = [text, ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1])];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // Try the next candidate; prose falls back to explicit public links below.
    }
  }
}

export function parseAgentSources(output: unknown, result: string | null): ResearchSource[] {
  const value = output || (result ? jsonIn(result) : undefined);
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { sources?: unknown }).sources)
      ? (value as { sources: unknown[] }).sources
      : [];
  // An agent's summary is never page text Scout read itself, whatever the agent claims.
  const sources: ResearchSource[] = entries
    .map(sourceFromUnknown)
    .filter((s): s is ResearchSource => !!s)
    .map((s) => ({ ...s, read: false }));
  if (!sources.length && result) {
    for (const url of extractPublicUrls(result))
      sources.push({
        title: new URL(url).hostname,
        url,
        content: result.slice(0, 2500),
      });
  }
  return [...new Map(sources.map((s) => [s.url, s])).values()].slice(0, 6);
}

// Run event shapes vary by tool, so Scout reads any object with a page address,
// with its title and the text the agent extracted or noted there.
const EVENT_URL = /^(url|page_?url|current_?url|href)$/i;
const EVENT_TITLE = /^(title|page_?title)$/i;
const EVENT_TEXT = /^(extracted_?content|extracted|content|text|summary|notes?|memory|result|output|observation|findings?)$/i;
// Prompts and live browser links are never evidence.
const EVENT_SKIP = /^(messages|prompt|system|task|instructions|live_?view_?url|cdp_?url|screenshot)$/i;

/** A public page worth keeping: not a search page, Browser Use itself, or a signed file link. */
function agentPageUrl(value: string): string | undefined {
  const url = publicUrl(value);
  if (!url) return;
  const { hostname, search } = new URL(url);
  if (isSearchPage(url) || /(^|\.)browser-use\.com$/.test(hostname) || /[?&](x-amz-|signature=|sig=|token=|expires=)/i.test(search))
    return;
  return url;
}

/** The pages a browser agent reached, from its run events. They are its observations, never Read. */
function pagesFromEvents(events: unknown[]): ResearchSource[] {
  const pages = new Map<string, { title?: string; notes: string[] }>();
  // Text without an address belongs to the page the agent is on.
  let current: string | undefined;
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 4) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) visit(item, depth + 1);
      return;
    }
    const entries = Object.entries(value).filter(([key]) => !EVENT_SKIP.test(key));
    const address = entries.find(([key, v]) => EVENT_URL.test(key) && typeof v === "string")?.[1] as string | undefined;
    const url = address === undefined ? undefined : agentPageUrl(address);
    if (address !== undefined) current = url;
    if (url && !pages.has(url)) pages.set(url, { notes: [] });
    for (const [key, v] of entries) {
      if (typeof v !== "string") visit(v, depth + 1);
      else if (url && EVENT_TITLE.test(key) && v.trim()) pages.get(url)!.title ??= v.trim().slice(0, 220);
      else if (current && EVENT_TEXT.test(key)) {
        const text = v.trim().replace(/\s+/g, " ").slice(0, 1200);
        const notes = pages.get(current)!.notes;
        // Words, not ids or encoded data.
        if (text.length >= 20 && text.includes(" ") && !notes.includes(text) && notes.length < 4) notes.push(text);
      }
    }
  };
  for (const event of events.slice(0, 1000)) {
    const { type, data } = (event && typeof event === "object" ? event : {}) as { type?: unknown; data?: unknown };
    // Browser events carry the live browser link; artifacts and files are signed downloads.
    if (typeof type === "string" && /^browser\.|artifact|file/i.test(type)) continue;
    visit(data, 0);
  }
  const reached = [...pages].sort(([, a], [, b]) => Number(!a.notes.length) - Number(!b.notes.length));
  return reached.slice(0, 6).map(([url, page]) => ({
    url,
    title: page.title || new URL(url).hostname,
    content: page.notes.join("\n\n").slice(0, 2500),
    read: false,
  }));
}

/** The cloud browsers a run used, from its browser.ready and browser.reattached events. */
function browsersInEvents(events: unknown[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    const { type, data } = (event && typeof event === "object" ? event : {}) as { type?: unknown; data?: { browser_session_id?: unknown } };
    const id = data?.browser_session_id;
    if ((type === "browser.ready" || type === "browser.reattached") && typeof id === "string" && UUID.test(id)) ids.add(id);
  }
  return [...ids];
}

export async function browserUseResearch(
  question: string,
  key: string,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
  progress?: Progress,
  time: ResearchTime = {},
): Promise<BrowserResult> {
  const clock = time.clock ?? Date.now;
  const sleep = time.nap ?? nap;
  const deadline = time.deadline ?? clock() + 180_000;
  const headers = { "X-Browser-Use-API-Key": key, "Content-Type": "application/json" };
  const read = async <T>(path: string, ms = 10000) =>
    jsonResponse<T>(
      await fetcher(`${browserUseApi}${path}`, {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1000, Math.min(ms, deadline - clock())))]),
      }),
      "Browser Use Cloud",
    );
  const created = await jsonResponse<{ id?: string; sessionId?: string }>(
    await fetcher(browserUseBase, {
      method: "POST",
      headers,
      body: JSON.stringify({
        task: `Research this question using the web browser: ${question.slice(0, 4000)}. Visit relevant original pages. Reply with only a JSON object, no other text: a "summary" string and a "sources" array, each item containing the exact visited page "url", "title", and a concise "summary" of what that page actually says. For shopping pages include the product's actual image URL as "image" if present, never a generic photo. Do not invent or cite a page you did not visit. Do not log in, purchase, submit forms, or change any external account.`,
        maxCostUsd: 1,
        outputSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            sources: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  url: { type: "string" },
                  title: { type: "string" },
                  summary: { type: "string" },
                  image: { type: "string" },
                },
                required: ["url", "title", "summary"],
              },
            },
          },
          required: ["summary", "sources"],
        },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    }),
    "Browser Use Cloud",
  );
  if (!created.id || !UUID.test(created.id))
    throw new ResearchError("Browser Use Cloud did not create a valid run.");
  const runId = created.id;
  const sessionId = created.sessionId && UUID.test(created.sessionId) ? created.sessionId : undefined;
  progress?.("Browser Use Cloud opened a managed browser");
  let finished = false;
  let browsers: string[] = [];
  // Reads the run's events (bounded, before the deadline) for the pages the agent reached.
  const salvage = async (warning: string): Promise<BrowserResult | undefined> => {
    const events: unknown[] = [];
    let after = 0;
    for (let page = 0; page < 5 && deadline - clock() > 1000; page++) {
      try {
        const got = await read<{ events?: unknown[]; nextAfter?: number | null; hasMore?: boolean }>(
          `/runs/${runId}/events?after=${after}&limit=200`,
          5000,
        );
        if (Array.isArray(got.events)) events.push(...got.events);
        if (!got.hasMore || typeof got.nextAfter !== "number" || got.nextAfter <= after) break;
        after = got.nextAfter;
      } catch {
        signal.throwIfAborted();
        break;
      }
    }
    browsers = browsersInEvents(events);
    const sources = pagesFromEvents(events);
    if (!sources.length) return;
    progress?.(`Kept ${sources.length} ${sources.length === 1 ? "page" : "pages"} the browser agent had reached`);
    return { sources, warning };
  };
  let status = "";
  let misses = 0;
  let pollError: unknown;
  try {
    while (clock() < deadline - SALVAGE_MS) {
      signal.throwIfAborted();
      try {
        const polled = (await read<{ status?: string }>(`/runs/${runId}/status`)).status;
        misses = 0;
        if (polled && polled !== status) {
          status = polled;
          if (status === "running") progress?.("Browser agent is visiting pages");
        }
      } catch (error) {
        signal.throwIfAborted();
        // One slow or throttled poll is not the end of the run; three in a row are.
        pollError = error;
        if (++misses >= 3) break;
      }
      if (status === "completed") {
        finished = true;
        const run = await read<{ result?: string | null; output?: unknown }>(`/runs/${runId}`);
        const sources = parseAgentSources(run.output, run.result || null);
        progress?.(`Browser agent collected ${sources.length} source links`);
        if (!sources.length)
          throw new ResearchError(
            "The browser agent finished without verifiable source links. Try a narrower question.",
          );
        return { sources, warning: "Browser agent summaries; open original pages to verify" };
      }
      if (status === "failed" || status === "cancelled") {
        finished = true;
        const kept = await salvage(STOPPED_EARLY);
        if (kept) return kept;
        throw new ResearchError("The Browser Use Cloud run did not complete. Try again.");
      }
      // After a failed poll, wait out the rate limiter's five-second window.
      await sleep(Math.min(misses ? 5000 : POLL_MS, Math.max(0, deadline - SALVAGE_MS - clock())), signal);
    }
    const unanswered = misses >= 3;
    progress?.(unanswered ? "Browser Use Cloud stopped responding" : "Browser agent reached the time limit");
    const kept = await salvage(unanswered ? STOPPED_EARLY : OUT_OF_TIME);
    if (kept) return kept;
    if (unanswered && pollError instanceof ResearchError) throw pollError;
    throw new ResearchError(
      unanswered
        ? "Browser Use Cloud stopped responding. Try again or choose Kernel."
        : status === "running"
          ? "The browser agent ran out of time before it reached a usable page. Try a narrower question or choose Kernel."
          : "Browser Use Cloud did not start its browser agent in time. Try again or choose Kernel.",
    );
  } finally {
    // Release the run and its cloud browser without delaying the answer: a run
    // Scout stopped polling is cancelled, and a browser outlives its run until stopped.
    const quick = () => AbortSignal.timeout(5000);
    void (async () => {
      if (!finished)
        await fetcher(`${browserUseBase}/${runId}/cancel`, { method: "POST", headers, signal: quick() }).catch(() => {});
      let ids = browsers;
      if (!ids.length && sessionId) {
        const list = await jsonResponse<{ items?: Array<{ id?: unknown }> }>(
          await fetcher(`${browserUseApi}/browsers?agentSessionId=${sessionId}&filterBy=active`, { headers, signal: quick() }),
          "Browser Use Cloud",
        );
        ids = (list.items || []).flatMap((b) => (typeof b.id === "string" && UUID.test(b.id) ? [b.id] : []));
      }
      await Promise.all(ids.map((id) =>
        fetcher(`${browserUseApi}/browsers/${id}`, {
          method: "PATCH", headers, body: JSON.stringify({ action: "stop" }), signal: quick(),
        }).catch(() => {})));
    })().catch(() => {});
  }
}

// JEV answers the same choice question whether it is reached through AI/ML API
// or straight from TypeSafe; only the address and model name differ.
export type JevService = { key: string; url: string; model: string };
export function jevService(keys: { aimlapiKey?: string; typesafeKey?: string }): JevService | undefined {
  if (keys.aimlapiKey)
    return { key: keys.aimlapiKey, url: "https://api.aimlapi.com/v1/decisions", model: "typesafe/jev" };
  if (keys.typesafeKey)
    return { key: keys.typesafeKey, url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" };
}

export async function jevChooseEngine(
  question: string,
  service: JevService,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
  progress?: Progress,
  options: BrowserEngine[] = ["browser_use", "kernel"],
): Promise<BrowserEngine> {
  // Without a usable answer, prefer the most thorough engine on offer.
  const safest = (["browser_use", "vision_agent", "kernel"] as const).find((e) => options.includes(e))!;
  const fallback = (why: string): BrowserEngine => {
    progress?.(`JEV was ${why}; using ${ENGINE_LABELS[safest]}`);
    return safest;
  };
  try {
    const response = await fetcher(service.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${service.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: service.model,
        state: question.slice(0, 4000),
        questions: {
          route: {
            type: "choice",
            instructions: "Choose the appropriate browser workflow for this user's research question.",
            criteria: Object.fromEntries(options.map((e) => [e, JEV_CRITERIA[e]])),
          },
        },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(4500)]),
    });
    if (!response.ok) return fallback("unavailable");
    const body = await response.json() as {
      answers?: { route?: { choice?: string; confidence?: number } };
    };
    const route = body.answers?.route;
    const choice = options.find((e) => e === route?.choice);
    if (!choice) return fallback("unavailable");
    // Kernel only reads pages; take it only when JEV is sure.
    if (choice === "kernel" && (route?.confidence || 0) < 0.65) return fallback("unsure");
    progress?.(`JEV selected ${ENGINE_LABELS[choice]}`);
    return choice;
  } catch {
    signal.throwIfAborted();
    return fallback("unavailable");
  }
}

function kernelScript(question: string, directUrl?: string): string {
  // Only fixed Playwright code runs in Kernel; the user's input is a quoted value.
  return `
const question = ${JSON.stringify(question.slice(0, 400))};
const direct = ${JSON.stringify(directUrl || "")};
const allowed = (value) => {
  try {
    const u = new URL(value);
    const h = u.hostname.toLowerCase();
    return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password &&
      (!u.port || ["80", "443"].includes(u.port)) && h.includes(".") &&
      !h.includes(":") && !/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(h) &&
      ![".local", ".internal", ".localhost", ".test"].some(x => h.endsWith(x));
  } catch { return false; }
};
let targets = direct ? [{ url: direct, title: direct }] : [];
if (!direct) {
  for (const searchUrl of [
    "https://www.google.com/search?q=" + encodeURIComponent(question),
    "https://www.bing.com/search?q=" + encodeURIComponent(question)
  ]) {
    try {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      targets = await page.locator("a:has(h3), #b_results h2 a").evaluateAll(anchors =>
        anchors.slice(0, 12).map(a => ({
          url: a.href,
          title: (a.innerText || a.textContent || "").trim()
        }))
      );
      targets = targets.filter(item => allowed(item.url)).slice(0, 4);
      if (targets.length) break;
    } catch { /* Try the other public search page. */ }
  }
}
const out = [];
for (const target of targets.slice(0, 4)) {
  if (!allowed(target.url)) continue;
  const tab = await context.newPage();
  try {
    await tab.goto(target.url, { waitUntil: "domcontentloaded", timeout: 12000 });
    if (!allowed(tab.url())) continue;
    const text = await tab.locator("main, article, body").first().innerText({ timeout: 5000 });
    const metaImage = await tab.locator('meta[property="og:image"]').first()
      .getAttribute("content").catch(() => null);
    const image = metaImage ? new URL(metaImage, tab.url()).href : undefined;
    out.push({ url: tab.url(), title: (await tab.title()).slice(0, 220) || target.title,
      content: text.slice(0, 6000), image, read: true });
  } catch { /* Skip an inaccessible page. */ }
  finally { await tab.close(); }
}
return out;
`;
}

export async function kernelResearch(
  question: string,
  key: string,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
  progress?: Progress,
  time: ResearchTime = {},
): Promise<BrowserResult> {
  const clock = time.clock ?? Date.now;
  const left = () => (time.deadline ?? Infinity) - clock();
  const tooLate = () => new ResearchError("There is not enough time left for Kernel to read pages. Try a narrower question.");
  // Kernel reads its pages in one go; without time for that, do not open (and pay for) a browser.
  if (left() < 20000) throw tooLate();
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const browser = await jsonResponse<{ session_id?: string }>(
    await fetcher(kernelBase, {
      method: "POST", headers, body: "{}", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    }),
    "Kernel",
  );
  const id = browser.session_id;
  if (!id || !/^[a-zA-Z0-9_-]{8,80}$/.test(id))
    throw new ResearchError("Kernel did not create a valid browser session.");
  progress?.("Kernel opened a separate cloud browser");
  try {
    const directUrl = extractPublicUrls(question)[0];
    progress?.(directUrl ? "Kernel is opening the supplied page" : "Kernel is finding and reading public pages");
    // The script, and the request waiting for it, end before research must.
    const seconds = Math.min(58, Math.floor((left() - 7000) / 1000));
    if (seconds < 5) throw tooLate();
    const result = await jsonResponse<{
      success?: boolean; result?: unknown;
    }>(
      await fetcher(`${kernelBase}/${id}/playwright/execute`, {
        method: "POST", headers,
        body: JSON.stringify({ code: kernelScript(question, directUrl), timeout_sec: seconds }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(seconds * 1000 + 7000)]),
      }),
      "Kernel",
    );
    if (!result.success)
      throw new ResearchError("Kernel could not read these pages. Try Browser Use Cloud.");
    const sources = (Array.isArray(result.result) ? result.result : [])
      .map(sourceFromUnknown)
      .filter((s): s is ResearchSource => !!s)
      .slice(0, 4);
    if (!sources.length)
      throw new ResearchError("Kernel did not find readable pages. Try Browser Use Cloud.");
    progress?.(`Kernel read ${sources.length} source pages`);
    return { sources };
  } finally {
    // A session costs money while open; cleanup also happens when extraction fails.
    await fetcher(`${kernelBase}/${id}`, {
      method: "DELETE", headers, signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
}

export async function chooseResearchEngine(
  requested: ResearchEngine,
  keys: { browserUseKey: string; kernelKey: string; jev?: JevService; visionAgent?: boolean },
  question: string,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
  progress?: Progress,
): Promise<Exclude<ResearchEngine, "auto">> {
  if (requested !== "auto") {
    progress?.(`Selected ${ENGINE_LABELS[requested]}`);
    return requested;
  }
  // In order of preference when JEV is not asked.
  const available: BrowserEngine[] = [
    ...(keys.browserUseKey ? ["browser_use" as const] : []),
    ...(keys.visionAgent ? ["vision_agent" as const] : []),
    ...(keys.kernelKey ? ["kernel" as const] : []),
  ];
  // JEV reports its own decision, or why Scout fell back, through progress.
  if (available.length >= 2 && keys.jev)
    return jevChooseEngine(question, keys.jev, signal, fetcher, progress, available);
  const engine = available[0] ?? "tavily";
  progress?.(`Selected ${ENGINE_LABELS[engine]}`);
  return engine;
}
