import type { ResearchSource } from "./chat-types";
import { extractPublicUrls, publicUrl, ResearchError } from "./research.ts";

export type BrowserEngine = "browser_use" | "kernel";
export type ResearchEngine = "auto" | BrowserEngine | "tavily";
type Fetcher = typeof fetch;
type BrowserResult = { sources: ResearchSource[]; warning?: string };
type Progress = (description: string) => void;

const browserUseBase = "https://api.browser-use.com/api/v4/runs";
const kernelBase = "https://api.onkernel.com/browsers";
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

async function jsonResponse<T>(response: Response, service: string): Promise<T> {
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
function jsonIn(text: string): unknown {
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

export async function browserUseResearch(
  question: string,
  key: string,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
  progress?: Progress,
): Promise<BrowserResult> {
  const headers = { "X-Browser-Use-API-Key": key, "Content-Type": "application/json" };
  const created = await jsonResponse<{ id?: string }>(
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
  if (!created.id || !/^[0-9a-f-]{36}$/i.test(created.id))
    throw new ResearchError("Browser Use Cloud did not create a valid run.");
  const runId = created.id;
  progress?.("Browser Use Cloud opened a managed browser");
  let finished = false;
  let lastStatus = "";
  try {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 75000) {
      signal.throwIfAborted();
      const run = await jsonResponse<{
        status?: string; result?: string | null; output?: unknown;
      }>(
        await fetcher(`${browserUseBase}/${runId}`, {
          headers,
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        }),
        "Browser Use Cloud",
      );
      if (run.status && run.status !== lastStatus) {
        lastStatus = run.status;
        if (run.status === "running") progress?.("Browser agent is visiting pages");
      }
      if (run.status === "completed") {
        finished = true;
        const sources = parseAgentSources(run.output, run.result || null);
        progress?.(`Browser agent collected ${sources.length} source links`);
        if (!sources.length)
          throw new ResearchError(
            "The browser agent finished without verifiable source links. Try a narrower question.",
          );
        return { sources, warning: "Browser agent summaries; open original pages to verify" };
      }
      if (run.status === "failed" || run.status === "cancelled") {
        finished = true;
        throw new ResearchError("The Browser Use Cloud run did not complete. Try again.");
      }
      await nap(1800, signal);
    }
    throw new ResearchError(
      "The browser agent took too long. Try a narrower question or choose Kernel.",
    );
  } finally {
    if (!finished) {
      // Release a remote run when Scout stops polling; do not delay the response.
      void fetcher(`${browserUseBase}/${runId}/cancel`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
  }
}

export async function jevChooseEngine(
  question: string,
  key: string,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
  progress?: Progress,
): Promise<BrowserEngine> {
  const fallback = (why: string): BrowserEngine => {
    progress?.(`JEV was ${why}; using Browser Use Cloud`);
    return "browser_use";
  };
  try {
    const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "jev-latest",
        state: question.slice(0, 4000),
        questions: {
          route: {
            type: "choice",
            instructions: "Choose the appropriate browser workflow for this user's research question.",
            criteria: {
              kernel: "Read a public page URL or quickly search and extract a few straightforward public pages.",
              browser_use: "Navigate complex websites, compare many pages, interact with dynamic pages, or resolve uncertain steps with a browser agent.",
            },
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
    if (route?.choice === "kernel") {
      if ((route.confidence || 0) < 0.65) return fallback("unsure");
      progress?.("JEV selected Kernel");
      return "kernel";
    }
    if (route?.choice !== "browser_use") return fallback("unavailable");
    progress?.("JEV selected Browser Use Cloud");
    return "browser_use";
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
): Promise<BrowserResult> {
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
    const result = await jsonResponse<{
      success?: boolean; result?: unknown;
    }>(
      await fetcher(`${kernelBase}/${id}/playwright/execute`, {
        method: "POST", headers,
        body: JSON.stringify({ code: kernelScript(question, directUrl), timeout_sec: 58 }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(65000)]),
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
  keys: { browserUseKey: string; kernelKey: string; jevKey: string },
  question: string,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
  progress?: Progress,
): Promise<Exclude<ResearchEngine, "auto">> {
  const label = { browser_use: "Browser Use Cloud", kernel: "Kernel", tavily: "Search API" };
  if (requested !== "auto") {
    progress?.(`Selected ${label[requested]}`);
    return requested;
  }
  // JEV reports its own decision, or why Scout fell back, through progress.
  if (keys.browserUseKey && keys.kernelKey && keys.jevKey)
    return jevChooseEngine(question, keys.jevKey, signal, fetcher, progress);
  const engine = keys.browserUseKey ? "browser_use" : keys.kernelKey ? "kernel" : "tavily";
  progress?.(`Selected ${label[engine]}`);
  return engine;
}
