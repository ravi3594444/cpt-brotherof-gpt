import { serverConfig } from "@/lib/server-config";
import { ACCESS_HEADER, accessAllowed } from "@/lib/access";
import type { ScoutConfig } from "@/lib/chat-types";

export async function GET(request: Request) {
  const config = serverConfig();
  const access: ScoutConfig["access"] = !config.accessCode
    ? "open"
    : accessAllowed(config.accessCode, request.headers.get(ACCESS_HEADER))
      ? "granted"
      : "required";
  const modelConnected = !!(config.apiKey && config.baseURL && config.model);
  // Without the access code, reveal nothing about the workspace's connections.
  const body: ScoutConfig =
    access === "required"
      ? {
          access,
          demo: true,
          modelConnected: false,
          searchConnected: false,
          modelName: "Scout",
          engines: { browserUse: false, kernel: false, tavily: false, jev: false },
        }
      : {
          access,
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
        };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
