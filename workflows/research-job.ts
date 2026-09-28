import { createHook } from "workflow";
import type { AnswerState } from "../lib/answer.ts";
import { jobToken } from "../lib/job-stream.ts";
import type { ResearchJobInput } from "../lib/research-job.ts";
import {
  answerStep,
  chooseAgain,
  closeVision,
  kernelStep,
  openJob,
  openVision,
  pollBrowserUse,
  searchStep,
  startBrowserUse,
  stopOtherJob,
  visionTurns,
  type Researched,
  type Turn,
} from "./research-steps.ts";

/**
 * A Research job: the rest of a turn once the Answer model calls the Research tool. It researches
 * with the engine JEV or the user chose, for as long as the research takes (only the cost cap and a
 * guard against endless runs stop it), then the Answer model writes the Answer in a step of its own.
 */
export async function researchJob(input: ResearchJobInput) {
  "use workflow";
  // The Conversation's hook finds this job after a cold start, and makes it the only one running.
  const token = jobToken(input.chatId);
  try {
    const conflict = await createHook({ token }).getConflict();
    if (conflict) {
      await stopOtherJob(conflict.runId);
      createHook({ token });
    }
  } catch {
    // A conflict whose owner is unknown: the request already stopped the Conversation's last job.
  }
  let turn: Turn = { mode: input.handoff.mode, calls: input.handoff.calls, responseMessages: input.handoff.responseMessages };
  let task = input.handoff.task;
  let { state, engine } = await openJob(input);
  // A second round only after a failure the Answer model may retry.
  for (let round = 1; round <= 2; round++) {
    const researched = await research(input, state, engine, task);
    const next = await answerStep(input, turn, researched.state, researched.result, round);
    if (!next) return;
    turn = { ...turn, calls: next.calls, responseMessages: next.responseMessages };
    task = next.task;
    ({ state, engine } = await chooseAgain(input, next.state, task));
  }
}

async function research(input: ResearchJobInput, state: AnswerState, engine: string, task: string): Promise<Researched> {
  if (engine === "browser_use") {
    const started = await startBrowserUse(input, state, task);
    if ("result" in started) return started;
    let current = started;
    let poll = { status: "", misses: 0, windows: 0 };
    for (;;) {
      const polled = await pollBrowserUse(input, current.state, started.run, poll);
      if ("result" in polled) return polled;
      current = { ...current, state: polled.state };
      poll = polled.poll;
    }
  }
  if (engine === "vision_agent") {
    const opened = await openVision(input, state, task);
    if ("result" in opened) return opened;
    let current = opened;
    try {
      for (;;) {
        const batch = await visionTurns(input, current.state, current.agent);
        if ("result" in batch) return batch;
        current = batch;
      }
    } finally {
      await closeVision(opened.agent.browserId);
    }
  }
  return engine === "kernel" ? kernelStep(input, state, task) : searchStep(input, state, task);
}
