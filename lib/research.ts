import type { ResearchSource } from "./chat-types";
export class ResearchError extends Error {
  /** False when trying again in the same message would fail the same way: a rejected key, no credit, a limit, or a run that may still be going. */
  readonly retryable: boolean;
  constructor(message: string, { retryable = true }: { retryable?: boolean } = {}) {
    super(message);
    this.retryable = retryable;
  }
}
/** HTTP statuses that repeat when asked again within seconds: a rejected key, no credit, or a limit. */
export const repeats = (status: number) => [401, 402, 403, 429].includes(status);

/** How far Research goes: "quick" reads a few pages; "deep" is for thorough research the user asked for. */
export type ResearchDepth = "quick" | "deep";
/** What the Answer model asked the Research tool for: the task, a short search query, and the depth. */
export type ResearchTask = { task: string; query: string; depth: ResearchDepth };
/** A Research task as given: plain text, or the tool's input, which a provider may leave fields out of. */
export type ResearchInput = string | { task: string; query?: unknown; depth?: unknown };
const words = (text: string, most: number) => text.trim().split(/\s+/).slice(0, most).join(" ");
/**
 * A Research task with its fallbacks: without a query, the task's first 12 words; without a known
 * depth, quick. A query is at most 16 words, so the engines never search with a whole sentence.
 */
export function researchTask(input: ResearchInput): ResearchTask {
  const { task, query, depth } = typeof input === "string" ? { task: input } : input;
  const given = typeof query === "string" ? words(query, 16).slice(0, 200) : "";
  return { task, query: given || words(task, 12), depth: depth === "deep" ? "deep" : "quick" };
}
export function publicUrl(value: string): string | undefined {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    if (
      !["https:", "http:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      (u.port && !["443", "80"].includes(u.port))
    )
      return;
    if (
      !host.includes(".") ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.endsWith(".test") ||
      host.includes(":") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host)
    )
      return;
    u.hash = "";
    return u.href;
  } catch {
    return;
  }
}
async function requestTavily(
  path: "search" | "extract",
  key: string,
  body: unknown,
  signal: AbortSignal,
) {
  const response = await fetch(`https://api.tavily.com/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
  });
  if (!response.ok)
    throw new ResearchError(
      response.status === 401 || response.status === 403
        ? "The search service could not authenticate. Check the workspace search key."
        : response.status === 429
          ? "The search service has reached its limit. Please try again later."
          : "The search service is unavailable. Please try again.",
      { retryable: !repeats(response.status) },
    );
  return response.json() as Promise<{
    results?: Array<{
      title?: string;
      url: string;
      content?: string;
      raw_content?: string;
    }>;
    failed_results?: unknown[];
  }>;
}
export async function searchWeb(
  query: string,
  key: string,
  signal: AbortSignal,
): Promise<ResearchSource[]> {
  const result = await requestTavily(
    "search",
    key,
    {
      query: query.slice(0, 400),
      search_depth: "advanced",
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
    },
    signal,
  );
  return (result.results || [])
    .filter((s) => publicUrl(s.url))
    .map((s) => ({
      title: (s.title || new URL(s.url).hostname).slice(0, 220),
      url: publicUrl(s.url)!,
      content: (s.content || "").slice(0, 3500),
    }));
}
export async function readPages(
  sources: ResearchSource[],
  key: string,
  signal: AbortSignal,
): Promise<{ sources: ResearchSource[]; partial: boolean }> {
  const urls = sources
    .slice(0, 4)
    .map((s) => publicUrl(s.url))
    .filter((url): url is string => !!url);
  if (!urls.length) return { sources, partial: false };
  const data = await requestTavily(
    "extract",
    key,
    { urls, extract_depth: "basic", format: "markdown", timeout: 15 },
    signal,
  );
  const content = new Map(
    (data.results || [])
      .filter((r) => publicUrl(r.url) && r.raw_content?.trim())
      .map((r) => [publicUrl(r.url)!, r.raw_content!.slice(0, 7000)]),
  );
  return {
    sources: sources.map((s) =>
      content.has(s.url)
        ? { ...s, content: content.get(s.url)!, read: true }
        : s,
    ),
    partial: urls.some((url) => !content.has(url)),
  };
}
/** True for a search engine's results page, which leads to sources but is not one. */
export const isSearchPage = (url: string) =>
  /(^|\.)(bing\.com|google\.[a-z.]+|duckduckgo\.com)$/.test(new URL(url).hostname);
const closers: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
// Trailing punctuation and unbalanced closing brackets belong to the sentence, not the link.
function trimLinkEnd(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1) || "";
    if (/[.,;:!?'"*]/.test(last)) url = url.slice(0, -1);
    else if (closers[last] && url.split(closers[last]).length <= url.split(last).length - 1)
      url = url.slice(0, -1);
    else return url;
  }
}
/** Public HTTP(S) links written in free text, deduplicated, in order of appearance. */
export function extractPublicUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const raw of text.match(/https?:\/\/[^\s<>"'`]+/g) || []) {
    const url = publicUrl(trimLinkEnd(raw));
    if (url) urls.add(url);
  }
  return [...urls];
}
