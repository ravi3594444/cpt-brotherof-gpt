import type { LanguageModel } from "ai";

// Test mode (SCOUT_TEST_MODE=1, refused on Vercel): a fake answer model and a fake Browser Use
// Cloud, so the real request and Research job paths can be tested end to end with no keys or
// network. It is used only when a request asks for a live answer; /api/config still reports the
// real connections, so sample mode is unchanged.

type Model = Extract<Exclude<LanguageModel, string>, { specificationVersion: "v4" }>;
type CallOptions = Parameters<Model["doStream"]>[0];
type StreamPart = Awaited<ReturnType<Model["doStream"]>>["stream"] extends ReadableStream<infer P> ? P : never;

/** What this server has done in test mode, for the browser checks. Shared by every route in the process. */
export function testCounters() {
  const g = globalThis as typeof globalThis & {
    __scoutTest?: { jobsStarted: number; browserRunsCreated: number; browserRunsCancelled: number; cancelled: string[] };
  };
  return (g.__scoutTest ??= { jobsStarted: 0, browserRunsCreated: 0, browserRunsCancelled: 0, cancelled: [] });
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content) ? content.map((p) => (p?.type === "text" ? p.text : "")).join("") : "";

/** Streams parts a little apart, like a provider. */
function slowly(parts: StreamPart[], ms = 40): ReadableStream<StreamPart> {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= parts.length) return controller.close();
      await new Promise((resolve) => setTimeout(resolve, i ? ms : 0));
      controller.enqueue(parts[i++]);
    },
  });
}
const words = (id: string, text: string): StreamPart[] => [
  { type: "text-start", id },
  ...(text.match(/\S+\s*/g) || []).map((delta) => ({ type: "text-delta" as const, id, delta })),
  { type: "text-end", id },
];
const thought = (id: string, text: string): StreamPart[] => [
  { type: "reasoning-start", id },
  { type: "reasoning-delta", id, delta: text },
  { type: "reasoning-end", id },
];
// An answer from sources goes on for about eight seconds, word by word, so the browser checks can
// switch away, go offline and scroll while it streams.
const MORE = Array.from({ length: 8 }, (_, i) =>
  `Test detail ${i + 1}: ferns in the garden guide grow best in steady shade, with soil that stays damp but never wet, and they need very little care once settled.`,
).join("\n\n");

/** The reply the fake answer model gives for a prompt. */
function reply(options: CallOptions): StreamPart[] {
  const prompt = options.prompt;
  const question = textOf(prompt.findLast((m) => m.role === "user")?.content);
  const results = prompt.filter((m) => m.role === "tool").flatMap((m) => m.content);
  const last = results.at(-1) as { output?: { value?: unknown } } | undefined;
  const mayResearch = !!options.tools?.length && options.toolChoice?.type !== "none";
  const finish = (reason: "stop" | "tool-calls"): StreamPart =>
    ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
  if (last) {
    const value = last.output?.value as { error?: string; sources?: unknown[] } | unknown[] | undefined;
    const sources = (Array.isArray(value) ? value : value?.sources) as Array<{ title: string; url: string }> | undefined;
    const text = sources?.length
      ? `The test research found ${sources.length} ${sources.length === 1 ? "source" : "sources"}. The first is ${sources[0].title} [1](${sources[0].url}).\n\n${MORE}`
      : `The test research did not finish (${(value as { error?: string })?.error ?? "no sources"}), so this answer is not from sources.`;
    return [...thought("r", "Reading what the research found."), ...words("t", text), finish("stop")];
  }
  if (mayResearch && /research/i.test(question))
    return [
      ...thought("r", "The question asks for research."),
      { type: "tool-call", toolCallId: "test-call-1", toolName: "web_research", input: JSON.stringify({ task: question.slice(0, 2000) }) },
      finish("tool-calls"),
    ];
  return [...words("t", "Hi! This is Scout's test model. Ask it to research something."), finish("stop")];
}

/** The fake answer model: it calls the Research tool for questions that mention research. */
export function testAnswerModel(): LanguageModel {
  const model: Model = {
    specificationVersion: "v4",
    provider: "scout-test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: "text", text: "ANSWER" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }),
    doStream: async (options) => ({ stream: slowly(reply(options)) }),
  };
  return model;
}

const RUN_PREFIX = "00000000-0000-4000-8000-";
const TEST_SESSION = "00000000-0000-4000-8000-00000000a11d";
const sources = [
  { url: "https://example.com/scout-test/garden", title: "Test garden guide", summary: "Ferns like shade and damp soil." },
  { url: "https://example.org/scout-test/balcony", title: "Test balcony plants", summary: "Many ferns grow well on a shady balcony." },
];

/**
 * A fake Browser Use Cloud: a run's id holds when it was created, and it completes `researchMs`
 * later unless it is cancelled first. Its session's cost grows a tenth of a cent a second.
 */
export function testBrowserUseFetch(researchMs: number): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "api.browser-use.com") throw new TypeError("Test mode reaches no other service.");
    const path = url.pathname.replace(/^\/api\/v4/, "");
    const method = init?.method || "GET";
    const counters = testCounters();
    if (method === "POST" && path === "/runs") {
      counters.browserRunsCreated++;
      return Response.json({ id: RUN_PREFIX + Date.now().toString(16).padStart(12, "0"), sessionId: TEST_SESSION, status: "queued" });
    }
    if (path.startsWith("/browsers")) return method === "GET" ? Response.json({ items: [] }) : Response.json({});
    if (path === `/sessions/${TEST_SESSION}/cost`) return Response.json({ totalCostUsd: "0.010000" });
    const match = /^\/runs\/([0-9a-f-]{36})(\/status|\/cancel|\/events)?$/.exec(path);
    if (!match) return new Response("Not found", { status: 404 });
    const [, id, action] = match;
    const elapsed = Date.now() - parseInt(id.slice(RUN_PREFIX.length), 16);
    if (action === "/cancel") {
      if (!counters.cancelled.includes(id)) {
        counters.cancelled.push(id);
        counters.browserRunsCancelled++;
      }
      return Response.json({ id, status: "cancelled" });
    }
    const status = counters.cancelled.includes(id) ? "cancelled" : elapsed < researchMs ? "running" : "completed";
    if (action === "/status") return Response.json({ status });
    if (action === "/events")
      return Response.json({
        events: [{ id: 1, type: "tool.result", data: { output: { url: sources[0].url, title: sources[0].title } } }],
        nextAfter: null,
        hasMore: false,
      });
    return Response.json({ id, status, output: status === "completed" ? { summary: "Test research.", sources } : null, result: null });
  };
}
