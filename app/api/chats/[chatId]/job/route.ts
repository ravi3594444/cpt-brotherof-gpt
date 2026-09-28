import { refuse } from "@/lib/access";
import { serverConfig } from "@/lib/server-config";

// The Conversation's running Research job, for a device that lost its run id (a cold start).
export async function GET(request: Request, { params }: { params: Promise<{ chatId: string }> }) {
  const config = serverConfig();
  const refused = refuse(request, config.accessCode);
  if (refused) return refused;
  const { chatId } = await params;
  let runId: string | undefined;
  if (config.durable && /^[\w-]{1,100}$/.test(chatId)) {
    const { activeJob } = await import("@/lib/research-job-server");
    runId = await activeJob(chatId);
  }
  return Response.json({ chatId, runId: runId ?? null }, { headers: { "Cache-Control": "no-store" } });
}
