import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel, ModelMessage } from "ai";
import type { ResearchHandoff } from "./answer.ts";
import { BROWSER_USE_WINDOW_MS, type ResearchEngine } from "./cloud-research.ts";
import { compactChunks, type Chunk } from "./job-stream.ts";
import { ResearchError } from "./research.ts";
import type { ServerConfig } from "./server-config.ts";
import { testAnswerModel, testBrowserUseFetch } from "./test-mode.ts";
import { VISION_BATCH_MS } from "./vision-agent.ts";
import type { Keys } from "./web-research.ts";

// A Research job: the rest of a turn once the Answer model calls the Research tool, run as a
// workflow (workflows/research-job.ts) that outlives the request and has no time limit.

/** Everything a Research job starts from. Plain data only: never photos, screenshots or keys. */
export type ResearchJobInput = {
  chatId: string;
  /** The Answer's message id, so a replay of the job's stream replaces the partial Answer. */
  messageId: string;
  engine: ResearchEngine;
  /** The conversation as text. */
  messages: ModelMessage[];
  handoff: ResearchHandoff;
  /** What the request streamed after its start chunk; the job sends it again first, for full replays. */
  prefix: Chunk[];
  photos: number;
  photosToModel: number;
  modelName: string;
  /** When the request started (epoch ms); nothing in the job depends on it. */
  startedAt: number;
};

/** The conversation as text for a Research job: photos become a note, never data. */
export function jobMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string" || m.role !== "user") return m;
    const text = m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    const photos = m.content.filter((p) => p.type !== "text").length;
    return {
      role: "user",
      content: photos ? `${text}\n\n[The user attached ${photos === 1 ? "a photo" : `${photos} photos`} to this message.]` : text,
    };
  });
}

export function jobInput(input: Omit<ResearchJobInput, "prefix" | "messages"> & { prefix: Chunk[]; messages: ModelMessage[] }): ResearchJobInput {
  return { ...input, messages: jobMessages(input.messages), prefix: compactChunks(input.prefix) };
}

/** The Answer model: the workspace's OpenAI-compatible endpoint, or test mode's fake. */
export function answerModel(config: ServerConfig): LanguageModel {
  if (config.testMode) return testAnswerModel();
  let baseURL: URL;
  try {
    baseURL = new URL(config.baseURL);
    if (baseURL.protocol !== "https:") throw new Error();
  } catch {
    throw new ResearchError("The workspace model endpoint must be a valid HTTPS URL.");
  }
  const provider = createOpenAICompatible({
    name: "scout-provider",
    baseURL: baseURL.href.replace(/\/$/, ""),
    apiKey: config.apiKey,
  });
  return provider(config.model);
}

/** The research engines' keys and fetch; test mode has only a fake Browser Use Cloud. */
export function researchServices(config: ServerConfig): {
  keys: Keys;
  fetcher: typeof fetch;
  maxCostUsd: number;
  modelName: string;
} {
  if (config.testMode)
    return {
      keys: { searchKey: "", browserUseKey: "test", kernelKey: "" },
      fetcher: testBrowserUseFetch(config.testResearchMs),
      maxCostUsd: config.maxCostUsd,
      modelName: "Test model",
    };
  return { keys: config, fetcher: fetch, maxCostUsd: config.maxCostUsd, modelName: config.modelName };
}

/** How long a Research job's steps and the responses that carry its stream run; test mode is quicker. */
export function jobTiming(config: ServerConfig) {
  return config.testMode
    ? { pollWindowMs: 3000, pollMs: 500, visionBatchMs: 20_000, streamWindowMs: 5000, statusPollMs: 500 }
    : {
      // One Browser Use poll window or vision agent batch per step.
      pollWindowMs: BROWSER_USE_WINDOW_MS,
      pollMs: 3000,
      visionBatchMs: VISION_BATCH_MS,
      // A response carries the stream for at most this long, inside its function's 300 seconds.
      streamWindowMs: 280_000,
      statusPollMs: 2000,
    };
}
