import { getStepMetadata, getWorkflowMetadata, getWritable } from "workflow";
import { getRun } from "workflow/api";
import {
  continueAnswer,
  researchFailure,
  researchProgress,
  type AnswerState,
  type ResearchCall,
  type ResearchHandoff,
  type ResearchResult,
} from "../lib/answer.ts";
import {
  createBrowserUseRun,
  kernelResearch,
  pollBrowserUseWindow,
  releaseBrowserUseRun,
  type BrowserUsePoll,
  type BrowserUseRun,
} from "../lib/cloud-research.ts";
import { answerErrorMessage } from "../lib/conversation.ts";
import { stepWriter, watchRun, type Chunk } from "../lib/job-stream.ts";
import { answerModel, jobTiming, researchServices, writerModel, type ResearchJobInput } from "../lib/research-job.ts";
import { extractPublicUrls, findPages, ResearchError, researchTask, type ResearchTask } from "../lib/research.ts";
import { serverConfig } from "../lib/server-config.ts";
import {
  closeVisionBrowser,
  newVisionAgent,
  openVisionBrowser,
  visionAgentBatch,
  type VisionAgentState,
} from "../lib/vision-agent.ts";
import { chooseEngine, searchApiResearch } from "../lib/web-research.ts";

// The Research job's steps. Each writes its part of the Answer to the run's stream and returns plain
// data for the next: the Research record in the Answer's state, never photos, screenshots or keys.
// A step that waits on paid work watches its run, so a stopped job ends it early.

type Engine = Awaited<ReturnType<typeof chooseEngine>>;
export type Researched = { state: AnswerState; result: ResearchResult };
export type Turn = { mode: ResearchHandoff["mode"]; calls: ResearchCall[]; responseMessages: ResearchHandoff["responseMessages"] };

function stepContext(marker: "open" | "step" | "none") {
  const { attempt } = getStepMetadata();
  const { workflowRunId } = getWorkflowMetadata();
  const config = serverConfig();
  const timing = jobTiming(config);
  const writer = stepWriter(getWritable<Chunk>(), { attempt, marker });
  const watch = watchRun(() => getRun(workflowRunId).status, { pollMs: timing.statusPollMs });
  return {
    runId: workflowRunId,
    config,
    timing,
    services: researchServices(config),
    writer,
    signal: watch.signal,
    /** Stops watching and waits for this step's chunks; `close` ends the stream: the Answer is done. */
    done: async (close = false) => {
      watch.stop();
      await (close ? writer.close() : writer.release());
    },
  };
}
const failed = (state: AnswerState, error: unknown): Researched => ({ state, result: { error: researchFailure(error) } });
const stopped = async (runId: string) => (await getRun(runId).status.catch(() => "running")) === "cancelled";

/** The job's first step: the start of the Answer again, for full replays, then the Research engine. */
export async function openJob(input: ResearchJobInput): Promise<{ state: AnswerState; engine: Engine }> {
  "use step";
  const c = stepContext("open");
  const state = structuredClone(input.handoff.state);
  try {
    c.writer.write({ type: "start", messageId: input.messageId, messageMetadata: { demo: false, job: { id: c.runId } } });
    for (const chunk of input.prefix) c.writer.write(chunk);
    const { keys, fetcher } = c.services;
    const engine = await chooseEngine(researchTask(input.handoff), input.engine, keys, c.signal, fetcher, researchProgress(state, c.writer));
    return { state, engine };
  } catch {
    // Only a stopped job gets here: choosing falls back on its own.
    return { state, engine: "tavily" };
  } finally {
    await c.done();
  }
}
openJob.maxRetries = 1;

/** Chooses the engine again for a second research attempt; Auto tries an engine not `tried` yet. */
export async function chooseAgain(input: ResearchJobInput, state: AnswerState, task: ResearchTask, tried: string[]): Promise<{ state: AnswerState; engine: Engine }> {
  "use step";
  const c = stepContext("none");
  try {
    const { keys, fetcher } = c.services;
    return { state, engine: await chooseEngine(task, input.engine, keys, c.signal, fetcher, researchProgress(state, c.writer), Infinity, tried) };
  } catch {
    return { state, engine: "tavily" };
  } finally {
    await c.done();
  }
}

/** Creates the Browser Use Cloud run. Never retried: a second run would bill twice. */
export async function startBrowserUse(
  input: ResearchJobInput,
  state: AnswerState,
  task: ResearchTask,
): Promise<Researched | { state: AnswerState; run: BrowserUseRun }> {
  "use step";
  const c = stepContext("none");
  try {
    const { keys, fetcher, maxCostUsd } = c.services;
    const run = await createBrowserUseRun(task, keys.browserUseKey, c.signal, fetcher, {
      maxCostUsd,
      timeout: AbortSignal.timeout(30_000),
    });
    researchProgress(state, c.writer).step("Browser Use Cloud opened a managed browser");
    return { state, run };
  } catch (error) {
    return failed(state, error);
  } finally {
    await c.done();
  }
}
startBrowserUse.maxRetries = 0;

/** One poll window of the Browser Use run, until it completes, fails or reaches the cost cap. */
export async function pollBrowserUse(
  input: ResearchJobInput,
  state: AnswerState,
  run: BrowserUseRun,
  poll: BrowserUsePoll,
): Promise<Researched | { state: AnswerState; poll: BrowserUsePoll }> {
  "use step";
  const c = stepContext("none");
  try {
    const { keys, fetcher, maxCostUsd } = c.services;
    const window = await pollBrowserUseWindow(run, keys.browserUseKey, c.signal, fetcher, researchProgress(state, c.writer).step, poll, {
      until: Date.now() + c.timing.pollWindowMs,
      maxCostUsd,
      pollMs: c.timing.pollMs,
    });
    if (window.done) return { state, result: { finding: { ...window.result, engine: "browser_use" } } };
    // A job stopped as the window ended gets no next step, so its run is released here.
    if (await stopped(c.runId)) await releaseBrowserUseRun(fetcher, keys.browserUseKey, run);
    return { state, poll: window.poll };
  } catch (error) {
    return failed(state, error);
  } finally {
    await c.done();
  }
}
pollBrowserUse.maxRetries = 1;

/** Kernel's fixed page-reading script, in one step; its browser deletes itself if the step dies. */
export async function kernelStep(input: ResearchJobInput, state: AnswerState, task: ResearchTask): Promise<Researched> {
  "use step";
  const c = stepContext("none");
  try {
    const { keys, fetcher } = c.services;
    const finding = await kernelResearch(task, keys.kernelKey, c.signal, fetcher, researchProgress(state, c.writer).step, {
      deadline: Date.now() + 200_000,
      browserTimeoutSeconds: 60,
    }, keys.searchKey);
    return { state, result: { finding: { ...finding, engine: "kernel" } } };
  } catch (error) {
    return failed(state, error);
  } finally {
    await c.done();
  }
}
kernelStep.maxRetries = 1;

/** The Search API, in one step. */
export async function searchStep(input: ResearchJobInput, state: AnswerState, task: ResearchTask): Promise<Researched> {
  "use step";
  const c = stepContext("none");
  try {
    const finding = await searchApiResearch(task, c.services.keys.searchKey, answerModel(c.config), input.messages, c.signal,
      researchProgress(state, c.writer));
    return { state, result: { finding: { ...finding, engine: "tavily" } } };
  } catch (error) {
    return failed(state, error);
  } finally {
    await c.done();
  }
}
searchStep.maxRetries = 1;

/** Opens the vision agent's Kernel browser, which deletes itself two minutes after nobody drives it. */
export async function openVision(
  input: ResearchJobInput,
  state: AnswerState,
  task: ResearchTask,
): Promise<Researched | { state: AnswerState; agent: VisionAgentState }> {
  "use step";
  const c = stepContext("none");
  try {
    const { keys, fetcher } = c.services;
    const step = researchProgress(state, c.writer).step;
    // The Search API finds pages while Kernel opens the browser; it never throws.
    const finding = extractPublicUrls(task.task).length ? Promise.resolve([]) : findPages(task.query, keys.searchKey, c.signal, fetcher, step);
    const id = await openVisionBrowser(keys.kernelKey, c.signal, fetcher, step, 120);
    return { state, agent: newVisionAgent(id, task, await finding) };
  } catch (error) {
    return failed(state, error);
  } finally {
    await c.done();
  }
}
openVision.maxRetries = 0;

/** One batch of the vision agent's turns; the screenshots stay in this step. */
export async function visionTurns(
  input: ResearchJobInput,
  state: AnswerState,
  agent: VisionAgentState,
): Promise<Researched | { state: AnswerState; agent: VisionAgentState }> {
  "use step";
  const c = stepContext("none");
  try {
    const { keys, fetcher } = c.services;
    if (!keys.vision) throw new ResearchError("The vision agent needs a vision model connected to this workspace.");
    const batch = await visionAgentBatch(agent, { kernelKey: keys.kernelKey, vision: keys.vision }, c.signal, fetcher,
      researchProgress(state, c.writer).step, { until: Date.now() + c.timing.visionBatchMs });
    if (batch.done) return { state, result: { finding: { ...batch.result, engine: "vision_agent" } } };
    if (await stopped(c.runId)) await closeVisionBrowser(agent.browserId, keys.kernelKey, fetcher);
    return { state, agent: batch.agent };
  } catch (error) {
    return failed(state, error);
  } finally {
    await c.done();
  }
}
visionTurns.maxRetries = 1;

/** Closes the vision agent's browser; the job runs it after the last batch, whatever happened. */
export async function closeVision(browserId: string): Promise<void> {
  "use step";
  await closeVisionBrowser(browserId, serverConfig().kernelKey, fetch);
}
closeVision.maxRetries = 2;

/**
 * The answer step, with fresh time: the research writer (the vision model, or else the Answer model)
 * gets the research result and writes the Answer, ending the stream. When research may be tried
 * again, the Answer model decides; if it calls the Research tool, this returns that call.
 */
export async function answerStep(
  input: ResearchJobInput,
  turn: Turn,
  state: AnswerState,
  result: ResearchResult,
  round: number,
): Promise<Omit<ResearchHandoff, "mode"> | undefined> {
  "use step";
  const c = stepContext("step");
  try {
    const next = await continueAnswer({
      ...turn,
      model: answerModel(c.config),
      researchWriter: writerModel(c.config),
      messages: input.messages,
      writer: c.writer,
      modelName: input.modelName,
      signal: c.signal,
      textId: `answer-${round}`,
      state,
      result,
      photos: input.photos,
      photosToModel: input.photosToModel,
      finishMetadata: { job: { end: "done" } },
    });
    await c.done(!next);
    return next;
  } catch (error) {
    if (c.signal.aborted) {
      await c.done();
      return;
    }
    if (!(error instanceof ResearchError)) console.error(error);
    c.writer.write({ type: "message-metadata", messageMetadata: { job: { end: "failed" } } });
    c.writer.write({
      type: "error",
      errorText: error instanceof ResearchError ? error.message : answerErrorMessage({ photos: input.photosToModel, aborted: false }),
    });
    await c.done(true);
  }
}
answerStep.maxRetries = 1;

/** Cancels another job that holds this Conversation's hook: the newest turn wins. */
export async function stopOtherJob(runId: string): Promise<void> {
  "use step";
  await getRun(runId).cancel();
}
