import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { serverConfig } from "@/lib/server-config";
import { ACCESS_HEADER, accessAllowed } from "@/lib/access";
import { streamAnswer } from "@/lib/answer";
import { answerErrorMessage, modelConversation, PhotoError, withPhotoDescription } from "@/lib/conversation";
import { describePhotos } from "@/lib/vision";
import { demoAnswer, withoutCitations } from "@/lib/demo";
import { ResearchError } from "@/lib/research";
import { webResearch } from "@/lib/web-research";
import type { ScoutMessage } from "@/lib/chat-types";
const inputSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        parts: z
          .array(
            z
              .object({
                type: z.string(),
                text: z.string().max(16000).optional(),
                url: z.string().max(2_100_000).optional(),
                mediaType: z.string().max(100).optional(),
              })
              .passthrough(),
          )
          .max(50),
      }),
    )
    .min(1)
    .max(80),
  webEnabled: z.boolean().default(true),
  preview: z.boolean().default(false),
  engine: z.enum(["auto", "browser_use", "kernel", "vision_agent", "tavily"]).default("auto"),
});
// Vercel functions accept request bodies up to 4.5 MB; stay just under it so
// an oversized request gets this route's message rather than the platform's.
// Four photos shrunk on the device fit well inside.
const MAX_REQUEST_CHARS = 4_400_000;
// Vercel stops a function after 300 seconds on every plan's default. Research
// (including the vision agent's browsing) and the answer share a 280-second ceiling.
export const maxDuration = 300;
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
export async function POST(request: Request) {
  // Research and the answer share the 280-second ceiling from here.
  const startedAt = Date.now();
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return new Response("This request must come from your Scout workspace.", {
      status: 403,
    });
  const config = serverConfig();
  if (!accessAllowed(config.accessCode, request.headers.get(ACCESS_HEADER)))
    return new Response("Scout needs its access code. Reload Scout and enter it again.", {
      status: 401,
    });
  if (Number(request.headers.get("content-length") || 0) > MAX_REQUEST_CHARS)
    return new Response("This question is too large. Try fewer photos, or start a new chat.", {
      status: 413,
    });
  let input: z.infer<typeof inputSchema>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_REQUEST_CHARS)
      return new Response("This question is too large. Try fewer photos, or start a new chat.", {
        status: 413,
      });
    input = inputSchema.parse(JSON.parse(raw));
  } catch {
    return new Response("Send a valid question to continue.", { status: 400 });
  }
  let conversation: ReturnType<typeof modelConversation>;
  try {
    conversation = modelConversation(input.messages);
  } catch (error) {
    if (error instanceof PhotoError) return new Response(error.message, { status: 400 });
    throw error;
  }
  const { messages, question, photos, images } = conversation;
  // Photos the answer model itself sees; 0 once the vision helper describes them.
  let photosToModel = photos;
  if (!question || question.length > 6000)
    return new Response("Your question must contain 1 to 6000 characters.", {
      status: 400,
    });
  const demo = input.preview || !(config.apiKey && config.baseURL && config.model);
  if (!demo && input.webEnabled && !(config.searchKey || config.browserUseKey || config.kernelKey))
    return new Response(
      "Web research needs a Browser Use Cloud or Kernel key. Choose sample mode to explore the interface.",
      { status: 503 },
    );
  if (!demo && input.webEnabled && input.engine !== "auto" && !({
    browser_use: config.browserUseKey,
    kernel: config.kernelKey,
    vision_agent: config.kernelKey && config.vision,
    tavily: config.searchKey,
  }[input.engine]))
    return new Response("That research engine is not connected in this workspace.", { status: 503 });
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(280000)]);
  const stream = createUIMessageStream<ScoutMessage>({
    onError: (error) =>
      error instanceof ResearchError
        ? error.message
        : answerErrorMessage({ photos: photosToModel, aborted: signal.aborted }),
    execute: async ({ writer }) => {
      writer.write({
        type: "start",
        messageId: crypto.randomUUID(),
        messageMetadata: { demo },
      });
      if (demo) {
        const answer = demoAnswer(question, { photos });
        if (input.webEnabled && answer.sources.length) {
          writer.write({
            type: "data-research",
            id: "research",
            data: {
              phase: "searching",
              queries: [question],
              sources: [],
              demo: true,
              steps: ["Opened an example research trail"],
            },
          });
          await wait(380, signal);
          writer.write({
            type: "data-research",
            id: "research",
            data: {
              phase: "reading",
              queries: [question],
              sources: answer.sources,
              demo: true,
              steps: ["Opened an example research trail", "Loaded example source links"],
            },
          });
          await wait(420, signal);
        }
        const text = input.webEnabled ? answer.text : withoutCitations(answer.text);
        writer.write({ type: "text-start", id: "answer" });
        const chunks = text.match(/[\s\S]{1,36}/g) || [text];
        for (const delta of chunks) {
          signal.throwIfAborted();
          writer.write({ type: "text-delta", id: "answer", delta });
          await wait(16, signal);
        }
        writer.write({ type: "text-end", id: "answer" });
        if (input.webEnabled && answer.sources.length)
          writer.write({
            type: "data-research",
            id: "research",
            data: {
              phase: "complete",
              queries: [question],
              sources: answer.sources,
              demo: true,
              steps: ["Opened an example research trail", "Loaded example source links", "Wrote the sample answer"],
            },
          });
        writer.write({ type: "data-suggestions", data: answer.suggestions });
        writer.write({ type: "finish", finishReason: "stop" });
        return;
      }
      let baseURL: URL;
      try {
        baseURL = new URL(config.baseURL);
        if (baseURL.protocol !== "https:") throw new Error();
      } catch {
        throw new ResearchError(
          "The workspace model endpoint must be a valid HTTPS URL.",
        );
      }
      const provider = createOpenAICompatible({
        name: "scout-provider",
        baseURL: baseURL.href.replace(/\/$/, ""),
        apiKey: config.apiKey,
      });
      const model = provider(config.model);
      let answerMessages = messages;
      // A text-only answer model gets photos as words: the vision helper
      // describes them before the answer model decides whether to research.
      if (photos && config.vision) {
        answerMessages = withPhotoDescription(messages, await describePhotos(config.vision, question, images, signal));
        photosToModel = 0;
      }
      await streamAnswer({
        model,
        messages: answerMessages,
        question,
        webEnabled: input.webEnabled,
        research: webResearch({ keys: config, engine: input.engine, model, conversation: answerMessages }),
        writer,
        modelName: config.modelName,
        photos,
        photosToModel,
        signal,
        startedAt,
      });
    },
  });
  return createUIMessageStreamResponse({
    stream,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
