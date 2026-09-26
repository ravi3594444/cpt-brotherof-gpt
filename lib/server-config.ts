import { env } from "cloudflare:workers";
export function serverConfig() {
  const e = env as unknown as Record<string, string | undefined>;
  return {
    apiKey: e.MODEL_API_KEY || "",
    baseURL: e.MODEL_BASE_URL || "",
    model: e.MODEL_ID || "",
    searchKey: e.TAVILY_API_KEY || "",
    browserUseKey: e.BROWSER_USE_API_KEY || "",
    kernelKey: e.KERNEL_API_KEY || "",
    jevKey: e.TYPESAFE_API_KEY || "",
    modelName: e.MODEL_DISPLAY_NAME || "Your model",
  };
}
