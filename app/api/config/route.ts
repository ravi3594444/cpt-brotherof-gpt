import { serverConfig } from "@/lib/server-config";
export async function GET() {
  const config = serverConfig();
  const modelConnected = !!(config.apiKey && config.baseURL && config.model);
  return Response.json(
    {
      demo: !modelConnected,
      modelConnected,
      searchConnected: !!(config.browserUseKey || config.kernelKey || config.searchKey),
      modelName: modelConnected ? config.modelName : "Scout",
      engines: {
        browserUse: !!config.browserUseKey,
        kernel: !!config.kernelKey,
        tavily: !!config.searchKey,
        jev: !!config.jevKey,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
