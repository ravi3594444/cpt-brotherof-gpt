import { getHookByToken, getRun, start } from "workflow/api";
import { researchJob } from "@/workflows/research-job";
import { jobPlace, jobToken, jobWindow, replaceActiveJob, skipChunks, type Chunk } from "./job-stream.ts";
import type { ResearchJobInput } from "./research-job.ts";
import { testCounters } from "./test-mode.ts";

// Starting, reading and stopping Research jobs. Routes import this only when durable research is
// on, so a server without workflows (Cloudflare) never loads the workflow runtime.

const jobs = {
  lookup: async (token: string) => (await getHookByToken(token)).runId,
  status: (runId: string) => getRun(runId).status,
  cancel: (runId: string) => getRun(runId).cancel(),
};
type Window = { until: number; signal?: AbortSignal; pollMs: number };

/**
 * Starts a Research job for the rest of a turn, after stopping the Conversation's last one, and
 * returns its stream without the start of the Answer the request already sent.
 */
export async function startResearchJob(input: ResearchJobInput, window: Window & { testMode: boolean }) {
  await replaceActiveJob(input.chatId, jobs);
  const run = await start(researchJob, [input]);
  if (window.testMode) testCounters().jobsStarted++;
  const readable = run.getReadable<Chunk>({ startIndex: 0 });
  // The job sends its start chunk, then the start of the Answer again.
  const skipped = skipChunks(readable, 1 + input.prefix.length, (index) => jobPlace(run.runId, index));
  return { runId: run.runId, stream: jobWindow(skipped, { ...window, status: () => run.status }) };
}

/** A window onto a job's stream from `startIndex`, or undefined when the server no longer has the job. */
export async function openJobStream(runId: string, startIndex: number, window: Window) {
  const run = getRun(runId);
  if (!(await run.exists)) return;
  const readable = run.getReadable<Chunk>({ startIndex });
  // How far the stream had reached: a client replaying it holds the replay until it gets there.
  const tail = await readable.getTailIndex().catch(() => undefined);
  return jobWindow(skipChunks(readable, 0, (index) => jobPlace(runId, startIndex + index, tail)), { ...window, status: () => run.status });
}

/** Stops a job; returns its status afterwards, or undefined when there is no such job. */
export async function cancelJob(runId: string) {
  const run = getRun(runId);
  if (!(await run.exists)) return;
  const status = await run.status;
  if (status === "running" || status === "pending") await run.cancel();
  return run.status;
}

/** The Conversation's running job, found by its hook. */
export async function activeJob(chatId: string): Promise<string | undefined> {
  try {
    const runId = await jobs.lookup(jobToken(chatId));
    const status = await jobs.status(runId);
    return status === "running" || status === "pending" ? runId : undefined;
  } catch {
    return;
  }
}
