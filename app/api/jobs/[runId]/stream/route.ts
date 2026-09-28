import { createUIMessageStreamResponse } from "ai";
import { refuse } from "@/lib/access";
import { JOB_RUN_ID } from "@/lib/job-stream";
import { jobTiming } from "@/lib/research-job";
import { serverConfig } from "@/lib/server-config";

// A Research job's stream from `startIndex` (0 replays it all), for a client that reconnects or
// reads on after a window ends. 204 when the server no longer has the job.
export const maxDuration = 300;

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const config = serverConfig();
  const refused = refuse(request, config.accessCode);
  if (refused) return refused;
  const { runId } = await params;
  if (!config.durable || !JOB_RUN_ID.test(runId)) return new Response(null, { status: 204 });
  const startIndex = Math.max(0, Math.floor(Number(new URL(request.url).searchParams.get("startIndex")) || 0));
  const timing = jobTiming(config);
  const { openJobStream } = await import("@/lib/research-job-server");
  const stream = await openJobStream(runId, startIndex, {
    until: Date.now() + timing.streamWindowMs,
    signal: request.signal,
    pollMs: timing.statusPollMs,
  });
  if (!stream) return new Response(null, { status: 204 });
  return createUIMessageStreamResponse({
    stream,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "x-workflow-run-id": runId },
  });
}
