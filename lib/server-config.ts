// Server-only settings from environment variables: Vercel project settings, a
// local .env file, or Cloudflare Worker variables (nodejs_compat fills
// process.env there too). Never prefix these with NEXT_PUBLIC_.
export function serverConfig() {
  const e = process.env;
  return {
    apiKey: e.MODEL_API_KEY || "",
    baseURL: e.MODEL_BASE_URL || "",
    model: e.MODEL_ID || "",
    searchKey: e.TAVILY_API_KEY || "",
    browserUseKey: e.BROWSER_USE_API_KEY || "",
    kernelKey: e.KERNEL_API_KEY || "",
    jevKey: e.TYPESAFE_API_KEY || "",
    modelName: e.MODEL_DISPLAY_NAME || "Your model",
    accessCode: e.SCOUT_ACCESS_CODE || "",
  };
}
