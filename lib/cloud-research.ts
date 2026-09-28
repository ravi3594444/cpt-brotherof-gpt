import type { ResearchSource } from "./chat-types";
import {
  extractPublicUrls,
  isSearchPage,
  publicUrl,
  repeats,
  ResearchError,
  researchTask,
  type ResearchDepth,
  type ResearchInput,
} from "./research.ts";

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
  /** A signal that aborts a request after `ms`. */
  timeout?: (ms: number) => AbortSignal;
  /** Keeps cleanup (closing a paid browser) running after the response ends: the platform's waitUntil. */
  keepAlive?: (work: Promise<unknown>) => void;
  /** How long a Kernel browser nobody drives lives on before Kernel deletes it, as a backstop. */
  browserTimeoutSeconds?: number;
};
/** The body that creates a Kernel browser. */
export const kernelBrowserBody = (timeoutSeconds?: number) =>
  JSON.stringify(timeoutSeconds ? { timeout_seconds: timeoutSeconds } : {});

const browserUseApi = "https://api.browser-use.com/api/v4";
const browserUseBase = `${browserUseApi}/runs`;
const UUID = /^[0-9a-f-]{36}$/i;
// Status reads have their own rate bucket. Polling stops this long before the
// deadline, to read the run's events for the pages the agent reached.
const POLL_MS = 2000;
const SALVAGE_MS = 8000;
const OUT_OF_TIME = "The browser agent ran out of time; these are the pages it had reached";
// The Browser Use Cloud cost cap per run, in US dollars, unless RESEARCH_MAX_COST_USD sets one.
export const DEFAULT_MAX_COST_USD = 2;
const STOPPED_EARLY = "The browser agent stopped early; these are the pages it had reached";
export const kernelBase = "https://api.onkernel.com/browsers";
export const ENGINE_LABELS: Record<Exclude<ResearchEngine, "auto">, string> = {
  browser_use: "Browser Use Cloud",
  kernel: "Kernel",
  vision_agent: "Vision agent",
  tavily: "Search API",
};
// The least time left for which an engine opens a paid browser: Browser Use must
// start its agent and still read what it reached, the vision agent needs a few
// steps, and Kernel reads its pages in one go.
export const ENGINE_MIN_MS: Record<BrowserEngine, number> = { browser_use: 60_000, vision_agent: 45_000, kernel: 20_000 };
export const notEnoughTime = (engine: BrowserEngine) =>
  new ResearchError(`There is not enough time left for ${engine === "vision_agent" ? "the vision agent" : ENGINE_LABELS[engine]} to research this. Try a narrower question.`);
// What JEV weighs for each engine it may choose.
// Plain Kernel does most research; Browser Use Cloud only what needs a heavier agent.
const JEV_CRITERIA: Record<BrowserEngine, string> = {
  kernel: "The default, and the fastest: questions answered by reading a few public pages, such as facts, explanations, how things work, news, reviews, or comparisons from articles, and the links the user gave.",
  vision_agent: "Tasks that need using a site like a person: searching inside a site, filters, menus, product listings and prices, pictures, layouts or charts.",
  browser_use: "Only when the task clearly needs a heavy autonomous browser agent: long multi-step work across many sites, complex forms, or dynamic web apps the other options cannot handle.",
};
// The order Auto prefers engines in for each depth, and for a second try, where Browser Use Cloud is the backup.
const PREFERENCE: Record<ResearchDepth, BrowserEngine[]> = {
  quick: ["kernel", "vision_agent", "browser_use"],
  deep: ["vision_agent", "kernel", "browser_use"],
};
const backupOrder = (depth: ResearchDepth): BrowserEngine[] =>
  ["browser_use", ...PREFERENCE[depth].filter((e) => e !== "browser_use")];
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
      { retryable: !repeats(response.status) },
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

/** A Browser Use Cloud run Scout created: its id, and the agent session its browser belongs to. */
export type BrowserUseRun = { runId: string; sessionId?: string };
type Read = <T>(path: string, ms?: number) => Promise<T>;

function browserUseRequests(key: string, signal: AbortSignal, fetcher: Fetcher, time: {
  deadline: number; clock: () => number; timeout: (ms: number) => AbortSignal;
}) {
  const headers = { "X-Browser-Use-API-Key": key, "Content-Type": "application/json" };
  const read: Read = async <T>(path: string, ms = 10000) =>
    jsonResponse<T>(
      await fetcher(`${browserUseApi}${path}`, {
        headers,
        signal: AbortSignal.any([signal, time.timeout(Math.max(1000, Math.min(ms, time.deadline - time.clock())))]),
      }),
      "Browser Use Cloud",
    );
  return { headers, read };
}

// How far Browser Use Cloud's agent goes for each depth.
const BROWSER_USE_DEPTH: Record<ResearchDepth, string> = {
  quick: "Finish after a few relevant pages.",
  deep: "Be thorough: visit many relevant pages from different sources before you finish.",
};

/**
 * Starts a Browser Use Cloud run for the task, capped at `maxCostUsd`. A run Scout did not hear
 * back about may exist, so that failure is never retried: another run would bill twice.
 */
export async function createBrowserUseRun(
  input: ResearchInput,
  key: string,
  signal: AbortSignal,
  fetcher: Fetcher,
  { maxCostUsd, timeout }: { maxCostUsd: number; timeout: AbortSignal },
): Promise<BrowserUseRun> {
  const { task, depth } = researchTask(input);
  let response: Response;
  try {
    response = await fetcher(browserUseBase, {
      method: "POST",
      headers: { "X-Browser-Use-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        task: `Research this question using the web browser: ${task.slice(0, 4000)}. ${BROWSER_USE_DEPTH[depth]} Visit relevant original pages. Reply with only a JSON object, no other text: a "summary" string and a "sources" array, each item containing the exact visited page "url", "title", and a concise "summary" of what that page actually says. For shopping pages include the product's actual image URL as "image" if present, never a generic photo. Do not invent or cite a page you did not visit. Do not log in, purchase, submit forms, or change any external account.`,
        maxCostUsd,
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
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch {
    signal.throwIfAborted();
    // The run may exist without Scout hearing back; starting another would bill twice.
    throw new ResearchError(
      "Browser Use Cloud did not confirm the new run, which may still be running. Try again in a few minutes.",
      { retryable: false },
    );
  }
  const created = await jsonResponse<{ id?: string; sessionId?: string }>(response, "Browser Use Cloud");
  if (!created.id || !UUID.test(created.id))
    throw new ResearchError("Browser Use Cloud did not create a valid run.");
  return { runId: created.id, ...(created.sessionId && UUID.test(created.sessionId) ? { sessionId: created.sessionId } : {}) };
}

/** Reads a run's events (bounded) for the pages the agent reached, and the cloud browsers it used. */
async function salvageRun(read: Read, runId: string, signal: AbortSignal, progress: Progress | undefined, warning: string, hasTime: () => boolean) {
  const events: unknown[] = [];
  let after = 0;
  for (let page = 0; page < 5 && hasTime(); page++) {
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
  const browsers = browsersInEvents(events);
  const sources = pagesFromEvents(events);
  if (sources.length)
    progress?.(`Kept ${sources.length} ${sources.length === 1 ? "page" : "pages"} the browser agent had reached`);
  return { browsers, kept: sources.length ? { sources, warning } : undefined };
}

/**
 * Releases a run and its cloud browser, with 5-second timeouts: a run Scout stopped polling is
 * cancelled, and a browser outlives its run until stopped. Never throws.
 */
function releaseRun(fetcher: Fetcher, key: string, run: BrowserUseRun, { finished, browsers }: { finished: boolean; browsers: string[] }) {
  const headers = { "X-Browser-Use-API-Key": key, "Content-Type": "application/json" };
  const quick = () => AbortSignal.timeout(5000);
  return (async () => {
    if (!finished)
      await fetcher(`${browserUseBase}/${run.runId}/cancel`, { method: "POST", headers, signal: quick() }).catch(() => {});
    let ids = browsers;
    if (!ids.length && run.sessionId) {
      const list = await jsonResponse<{ items?: Array<{ id?: unknown }> }>(
        await fetcher(`${browserUseApi}/browsers?agentSessionId=${run.sessionId}&filterBy=active`, { headers, signal: quick() }),
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

/** Cancels a run that is still going and stops its cloud browser, for a Research job that was stopped. */
export const releaseBrowserUseRun = (fetcher: Fetcher, key: string, run: BrowserUseRun) =>
  releaseRun(fetcher, key, run, { finished: false, browsers: [] });

/** The sources of a completed run, which are summaries, never Read. */
async function completedRun(read: Read, runId: string, progress?: Progress): Promise<BrowserResult> {
  const run = await read<{ result?: string | null; output?: unknown }>(`/runs/${runId}`);
  const sources = parseAgentSources(run.output, run.result || null);
  progress?.(`Browser agent collected ${sources.length} source links`);
  if (!sources.length)
    throw new ResearchError(
      "The browser agent finished without verifiable source links. Try a narrower question.",
    );
  return { sources, warning: "Browser agent summaries; open original pages to verify" };
}

export async function browserUseResearch(
  input: ResearchInput,
  key: string,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
  progress?: Progress,
  time: ResearchTime & { maxCostUsd?: number } = {},
): Promise<BrowserResult> {
  const clock = time.clock ?? Date.now;
  const sleep = time.nap ?? nap;
  const deadline = time.deadline ?? clock() + 180_000;
  const timeout = time.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
  if (deadline - clock() < ENGINE_MIN_MS.browser_use) throw notEnoughTime("browser_use");
  const { read } = browserUseRequests(key, signal, fetcher, { deadline, clock, timeout });
  const run = await createBrowserUseRun(input, key, signal, fetcher, {
    maxCostUsd: time.maxCostUsd ?? DEFAULT_MAX_COST_USD,
    timeout: timeout(Math.min(30_000, deadline - clock())),
  });
  const { runId } = run;
  progress?.("Browser Use Cloud opened a managed browser");
  let finished = false;
  let browsers: string[] = [];
  // Reads the run's events (bounded, before the deadline) for the pages the agent reached.
  const salvage = async (warning: string): Promise<BrowserResult | undefined> => {
    const salvaged = await salvageRun(read, runId, signal, progress, warning, () => deadline - clock() > 1000);
    browsers = salvaged.browsers;
    return salvaged.kept;
  };
  let status = "";
  let misses = 0;
  let pollError: unknown;
  try {
    while (clock() < deadline - SALVAGE_MS) {
      signal.throwIfAborted();
      try {
        // A slow poll ends where the salvage window starts, so the events can still be read.
        const polled = (await read<{ status?: string }>(`/runs/${runId}/status`, Math.min(10000, deadline - SALVAGE_MS - clock()))).status;
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
        return await completedRun(read, runId, progress);
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
    // Release the run and its cloud browser without delaying the answer.
    const release = releaseRun(fetcher, key, run, { finished, browsers });
    time.keepAlive?.(release);
  }
}

/** Where a Research job's Browser Use run stands between poll windows. */
export type BrowserUsePoll = { status: string; misses: number; windows: number; costCheckedAt?: number };
export type BrowserUseWindow = { done: false; poll: BrowserUsePoll } | { done: true; result: BrowserResult };
// A Research job polls a run in windows that fit one step. With no time limit, runs end by
// completing, failing, the cost cap, or this many windows as a guard against a run that never ends.
export const BROWSER_USE_WINDOW_MS = 240_000;
export const MAX_BROWSER_USE_WINDOWS = 60;
const COST_LIMIT = "The browser agent reached the research cost limit; these are the pages it had reached";

/**
 * One poll window of a Research job's Browser Use run: polls its status until `until`, streaming
 * progress, and returns where it stands, or its result once it completes, fails, or reaches the cost
 * cap. A finished run is released (and cancelled if it was still going) before this returns, and
 * so is one whose job was stopped (an aborted signal).
 */
export async function pollBrowserUseWindow(
  run: BrowserUseRun,
  key: string,
  signal: AbortSignal,
  fetcher: Fetcher,
  progress: Progress | undefined,
  poll: BrowserUsePoll,
  {
    until,
    maxCostUsd,
    clock = Date.now,
    nap: sleep = nap,
    pollMs = 3000,
    costEveryMs = 60_000,
    maxWindows = MAX_BROWSER_USE_WINDOWS,
    timeout = (ms: number) => AbortSignal.timeout(ms),
  }: {
    until: number;
    maxCostUsd: number;
    clock?: () => number;
    nap?: (ms: number, signal: AbortSignal) => Promise<void>;
    pollMs?: number;
    costEveryMs?: number;
    maxWindows?: number;
    timeout?: (ms: number) => AbortSignal;
  },
): Promise<BrowserUseWindow> {
  const { read } = browserUseRequests(key, signal, fetcher, { deadline: Infinity, clock, timeout });
  const state = { ...poll, windows: poll.windows + 1 };
  let finished = false;
  // True when the window ends with the run still going, to be polled in the next one.
  let later = false;
  let browsers: string[] = [];
  const salvage = async (warning: string) => {
    const salvaged = await salvageRun(read, run.runId, signal, progress, warning, () => true);
    browsers = salvaged.browsers;
    return salvaged.kept;
  };
  let pollError: unknown;
  try {
    if (state.windows > maxWindows) {
      console.warn(`Research job stopped Browser Use run ${run.runId} after ${maxWindows} poll windows`);
      progress?.("Browser agent was stopped after running unusually long");
      const kept = await salvage(STOPPED_EARLY);
      if (kept) return { done: true, result: kept };
      throw new ResearchError("The browser agent ran unusually long without a usable page, so Scout stopped it. Try a narrower question.");
    }
    while (clock() < until) {
      signal.throwIfAborted();
      try {
        const polled = (await read<{ status?: string }>(`/runs/${run.runId}/status`)).status;
        state.misses = 0;
        if (polled && polled !== state.status) {
          state.status = polled;
          if (state.status === "running") progress?.("Browser agent is visiting pages");
        }
      } catch (error) {
        signal.throwIfAborted();
        pollError = error;
        if (++state.misses >= 3) break;
      }
      if (state.status === "completed") {
        finished = true;
        return { done: true, result: await completedRun(read, run.runId, progress) };
      }
      if (state.status === "failed" || state.status === "cancelled") {
        finished = true;
        const kept = await salvage(STOPPED_EARLY);
        if (kept) return { done: true, result: kept };
        throw new ResearchError("The Browser Use Cloud run did not complete. Try again.");
      }
      // The session's cost so far, which counts browser time too: a guard against a runaway run.
      if (run.sessionId && (state.costCheckedAt === undefined || clock() - state.costCheckedAt >= costEveryMs)) {
        state.costCheckedAt = clock();
        const cost = await read<{ totalCostUsd?: unknown }>(`/sessions/${run.sessionId}/cost`)
          .then((c) => Number(c.totalCostUsd), () => NaN);
        signal.throwIfAborted();
        if (cost >= maxCostUsd) {
          progress?.(`Browser Use Cloud reached the $${maxCostUsd} research cost limit`);
          const kept = await salvage(COST_LIMIT);
          if (kept) return { done: true, result: kept };
          throw new ResearchError(
            `The browser agent reached the $${maxCostUsd} research cost limit before it found a usable page. Try a narrower question.`,
            { retryable: false },
          );
        }
      }
      await sleep(Math.min(state.misses ? 5000 : pollMs, Math.max(0, until - clock())), signal);
    }
    if (state.misses < 3) {
      later = true;
      return { done: false, poll: state };
    }
    progress?.("Browser Use Cloud stopped responding");
    const kept = await salvage(STOPPED_EARLY);
    if (kept) return { done: true, result: kept };
    if (pollError instanceof ResearchError) throw pollError;
    throw new ResearchError("Browser Use Cloud stopped responding. Try again or choose Kernel.");
  } finally {
    if (!later) await releaseRun(fetcher, key, run, { finished, browsers });
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

const JEV_DEPTH: Record<ResearchDepth, string> = {
  quick: "quick (a few relevant pages are enough)",
  deep: "deep (the user asked for thorough research across many pages or sites)",
};

export async function jevChooseEngine(
  input: ResearchInput,
  service: JevService,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
  progress?: Progress,
  options: BrowserEngine[] = ["kernel", "browser_use"],
  /** A second try, after an engine failed: Browser Use Cloud is then the backup. */
  backup = false,
): Promise<BrowserEngine> {
  const { task, depth } = researchTask(input);
  // Without a usable answer, the engine the depth prefers, or the backup on a second try.
  const preferred = (backup ? backupOrder(depth) : PREFERENCE[depth]).find((e) => options.includes(e))!;
  const pick = (engine: BrowserEngine, why: string): BrowserEngine => {
    progress?.(`JEV was ${why}; using ${ENGINE_LABELS[engine]}`);
    return engine;
  };
  // Why JEV gave no usable answer goes into the step, and the cause into the server log.
  const unavailable = (why: string, detail: string) => {
    const shown = detail.slice(0, 300);
    console.warn(`JEV routing failed (${why}): ${service.key ? shown.replaceAll(service.key, "[key]") : shown}`);
    return pick(preferred, `unavailable (${why})`);
  };
  const timeout = AbortSignal.timeout(4500);
  let text: string;
  try {
    const response = await fetcher(service.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${service.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: service.model,
        state: `Research task: ${task.slice(0, 4000)}\nResearch depth: ${JEV_DEPTH[depth]}`,
        questions: {
          route: {
            type: "choice",
            instructions: "Choose the browser workflow for this research task. kernel is the default and the fastest; choose vision_agent only when the task needs using a site like a person, and browser_use only when it clearly needs a heavy autonomous agent.",
            criteria: Object.fromEntries(options.map((e) => [e, JEV_CRITERIA[e]])),
          },
        },
      }),
      signal: AbortSignal.any([signal, timeout]),
    });
    text = await response.text();
    if (!response.ok) return unavailable(`HTTP ${response.status}`, text);
  } catch (error) {
    signal.throwIfAborted();
    const timedOut = timeout.aborted || (error instanceof Error && error.name === "TimeoutError");
    return timedOut
      ? unavailable("timed out", "no answer within 4.5 seconds")
      : unavailable("network error", error instanceof Error ? error.message : String(error));
  }
  let route: { choice?: unknown; confidence?: unknown } | undefined;
  try {
    route = (JSON.parse(text) as { answers?: { route?: typeof route } }).answers?.route;
  } catch {
    // Not JSON: an unexpected answer.
  }
  const choice = options.find((e) => e === route?.choice);
  if (!choice) return unavailable("unexpected answer", text);
  const sure = Number(route?.confidence || 0) >= 0.65;
  // Browser Use Cloud costs the most; take it on a first try only when JEV is sure the task needs it.
  if (choice === "browser_use" && !backup && !sure && preferred !== "browser_use") return pick(preferred, "unsure");
  // An unsure plain Kernel answer stays Kernel for quick research; deep research browses with the
  // vision agent instead, and a second try goes to the backup.
  if (choice === "kernel" && !sure) {
    const instead = backup ? preferred : depth === "deep" && options.includes("vision_agent") ? "vision_agent" : "kernel";
    if (instead !== choice) return pick(instead, "unsure");
  }
  progress?.(`JEV selected ${ENGINE_LABELS[choice]}`);
  return choice;
}

/**
 * Kernel's fixed Playwright script: it searches for the task's query (or opens the pasted link) and
 * reads up to four pages side by side, each within `pageMs`.
 */
export function kernelScript(input: ResearchInput, directUrl?: string, { pageMs = 20_000 }: { pageMs?: number } = {}): string {
  const { query } = researchTask(input);
  // Only fixed Playwright code runs in Kernel; the user's input is a quoted value.
  return `
const query = ${JSON.stringify(query.slice(0, 400))};
const direct = ${JSON.stringify(directUrl || "")};
const pageMs = ${Math.round(pageMs)};
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
    "https://www.google.com/search?q=" + encodeURIComponent(query),
    "https://www.bing.com/search?q=" + encodeURIComponent(query)
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
// Each page in a tab of its own, all at once; a page that is not read within pageMs is left out.
const withinTime = (work) => {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The page took too long.")), pageMs); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};
const readPage = async (target) => {
  if (!allowed(target.url)) return null;
  const tab = await context.newPage();
  try {
    return await withinTime((async () => {
      await tab.goto(target.url, { waitUntil: "domcontentloaded", timeout: 12000 });
      if (!allowed(tab.url())) return null;
      const text = await tab.locator("main, article, body").first().innerText({ timeout: 5000 });
      const metaImage = await tab.locator('meta[property="og:image"]').first()
        .getAttribute("content", { timeout: 1500 }).catch(() => null);
      // A page can move on (or fail) while it is read; its address is checked again.
      const url = tab.url();
      if (!allowed(url)) return null;
      const image = metaImage ? new URL(metaImage, url).href : undefined;
      return { url, title: (await tab.title()).slice(0, 220) || target.title,
        content: text.slice(0, 6000), image, read: true };
    })());
  } catch { return null; /* Skip an inaccessible page. */ }
  finally { await tab.close().catch(() => {}); }
};
const read = await Promise.allSettled(targets.slice(0, 4).map(readPage));
const out = read.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
return out;
`;
}

export async function kernelResearch(
  input: ResearchInput,
  key: string,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
  progress?: Progress,
  time: ResearchTime = {},
): Promise<BrowserResult> {
  const request = researchTask(input);
  const clock = time.clock ?? Date.now;
  const left = () => (time.deadline ?? Infinity) - clock();
  // Kernel reads its pages in one go; without time for that, do not open (and pay for) a browser.
  if (left() < ENGINE_MIN_MS.kernel) throw notEnoughTime("kernel");
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const browser = await jsonResponse<{ session_id?: string }>(
    await fetcher(kernelBase, {
      method: "POST", headers, body: kernelBrowserBody(time.browserTimeoutSeconds), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    }),
    "Kernel",
  );
  const id = browser.session_id;
  if (!id || !/^[a-zA-Z0-9_-]{8,80}$/.test(id))
    throw new ResearchError("Kernel did not create a valid browser session.");
  progress?.("Kernel opened a separate cloud browser");
  try {
    const directUrl = extractPublicUrls(request.task)[0];
    progress?.(directUrl ? "Kernel is opening the supplied page" : `Kernel is searching for “${request.query}” and reading public pages`);
    // The script, and the request waiting for it, end before research must.
    const seconds = Math.min(58, Math.floor((left() - 7000) / 1000));
    if (seconds < 5) throw notEnoughTime("kernel");
    const result = await jsonResponse<{
      success?: boolean; result?: unknown;
    }>(
      await fetcher(`${kernelBase}/${id}/playwright/execute`, {
        method: "POST", headers,
        body: JSON.stringify({ code: kernelScript(request, directUrl), timeout_sec: seconds }),
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
    const closing = fetcher(`${kernelBase}/${id}`, {
      method: "DELETE", headers, signal: AbortSignal.timeout(5000),
    }).catch(() => {});
    time.keepAlive?.(closing);
    await closing;
  }
}

export async function chooseResearchEngine(
  requested: ResearchEngine,
  keys: { browserUseKey: string; kernelKey: string; jev?: JevService; visionAgent?: boolean },
  input: ResearchInput,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
  progress?: Progress,
  /** Time research has left (ms); Auto leaves out engines that need more. */
  timeLeft = Infinity,
  /** Engines already tried for this Answer: a second try leaves them out while another is connected. */
  avoid: readonly string[] = [],
): Promise<Exclude<ResearchEngine, "auto">> {
  if (requested !== "auto") {
    progress?.(`Selected ${ENGINE_LABELS[requested]}`);
    return requested;
  }
  const on: Record<BrowserEngine, boolean> = {
    vision_agent: !!keys.visionAgent,
    kernel: !!keys.kernelKey,
    browser_use: !!keys.browserUseKey,
  };
  const request = researchTask(input);
  const order = backupOrder(request.depth);
  const untried = order.filter((e) => on[e] && !avoid.includes(e));
  const backup = avoid.length > 0 && untried.length > 0;
  // In the depth's order of preference when JEV is not asked, or with Browser Use Cloud as the backup.
  const connected = backup ? untried : PREFERENCE[request.depth].filter((e) => on[e]);
  // When no engine fits, the chosen one says there is not enough time.
  const fits = connected.filter((e) => timeLeft >= ENGINE_MIN_MS[e]);
  const available = fits.length ? fits : connected;
  const skipped = order.filter((e) => connected.includes(e) && !available.includes(e));
  if (skipped.length) progress?.(`Not enough time is left for ${skipped.map((e) => ENGINE_LABELS[e]).join(" or ")}`);
  // JEV reports its own decision, or why Scout fell back, through progress.
  if (available.length >= 2 && keys.jev)
    return jevChooseEngine(request, keys.jev, signal, fetcher, progress, available, backup);
  const engine = available[0] ?? "tavily";
  progress?.(`Selected ${ENGINE_LABELS[engine]}`);
  return engine;
}
