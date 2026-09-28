import { DEFAULT_MAX_COST_USD, jevService } from "./cloud-research.ts";
import { visionService } from "./vision.ts";

type Env = Record<string, string | undefined>;

/** The research cost cap in US dollars: RESEARCH_MAX_COST_USD when it is a positive number. */
export function researchMaxCostUsd(value: string | undefined): number {
  const amount = Number(value?.trim() || NaN);
  return Number.isFinite(amount) && amount > 0 ? amount : DEFAULT_MAX_COST_USD;
}

/**
 * Whether Research runs as a Research job: only where workflows run (Vercel, or the local world
 * that `withWorkflow` sets up under next dev and next start), never on Cloudflare, and unless
 * SCOUT_DURABLE_RESEARCH turns it off.
 */
export function durableResearch(e: Env, userAgent = globalThis.navigator?.userAgent): boolean {
  if (/^(off|0|false|no)$/i.test(e.SCOUT_DURABLE_RESEARCH?.trim() || "")) return false;
  if (userAgent === "Cloudflare-Workers") return false;
  return !!(e.VERCEL || e.WORKFLOW_TARGET_WORLD);
}

/** Test mode (SCOUT_TEST_MODE=1): a fake answer model and research engine, for local tests only. */
export const testMode = (e: Env) => e.SCOUT_TEST_MODE === "1" && !e.VERCEL;

// Server-only settings from environment variables: Vercel project settings, a
// local .env file, or Cloudflare Worker variables (nodejs_compat fills
// process.env there too). Never prefix these with NEXT_PUBLIC_.
export function serverConfig(e: Env = process.env) {
  return {
    apiKey: e.MODEL_API_KEY || "",
    baseURL: e.MODEL_BASE_URL || "",
    model: e.MODEL_ID || "",
    searchKey: e.TAVILY_API_KEY || "",
    browserUseKey: e.BROWSER_USE_API_KEY || "",
    kernelKey: e.KERNEL_API_KEY || "",
    // JEV through AI/ML API (AIMLAPI_API_KEY) or straight from TypeSafe.
    jev: jevService({ aimlapiKey: e.AIMLAPI_API_KEY, typesafeKey: e.TYPESAFE_API_KEY }),
    modelName: e.MODEL_DISPLAY_NAME || "Your model",
    accessCode: e.SCOUT_ACCESS_CODE || "",
    // A model that can see (e.g. DeepSeek V4.1 Flash on AI/ML API) for photos
    // and the browser agent, when the answer model reads text only.
    vision: visionService({
      model: e.VISION_MODEL_ID,
      baseURL: e.VISION_MODEL_BASE_URL,
      apiKey: e.VISION_MODEL_API_KEY,
      aimlapiKey: e.AIMLAPI_API_KEY,
    }),
    // The most one question's research may spend; Browser Use Cloud runs are capped at it.
    maxCostUsd: researchMaxCostUsd(e.RESEARCH_MAX_COST_USD),
    durable: durableResearch(e),
    testMode: testMode(e),
    // Test mode only: how long the fake Browser Use Cloud takes to research.
    testResearchMs: Number(e.SCOUT_TEST_RESEARCH_MS) > 0 ? Number(e.SCOUT_TEST_RESEARCH_MS) : 12_000,
  };
}
export type ServerConfig = ReturnType<typeof serverConfig>;
