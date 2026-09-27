import type { ResearchSource } from "./chat-types";
export class ResearchError extends Error {}
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
