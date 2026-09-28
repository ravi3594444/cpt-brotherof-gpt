import { refuse } from "@/lib/access";
import { JOB_RUN_ID } from "@/lib/job-stream";
import { serverConfig } from "@/lib/server-config";

// Stop: cancels the Research job itself, not just the client's connection to it.
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const config = serverConfig();
  const refused = refuse(request, config.accessCode);
  if (refused) return refused;
  const { runId } = await params;
  const headers = { "Cache-Control": "no-store", "x-workflow-run-id": runId };
  if (!config.durable || !JOB_RUN_ID.test(runId)) return Response.json({ runId, status: "not_found" }, { status: 404, headers });
  const { cancelJob } = await import("@/lib/research-job-server");
  const status = await cancelJob(runId);
  if (!status) return Response.json({ runId, status: "not_found" }, { status: 404, headers });
  return Response.json({ runId, status }, { headers });
}
