import type { InferUIMessageChunk } from "ai";
import type { ScoutMessage } from "./chat-types";

// A Research job streams its part of an Answer into its run's durable stream. These pieces write
// that stream from steps and carry it to the client in responses that fit a function's time.

export type Chunk = InferUIMessageChunk<ScoutMessage>;
type Nap = (ms: number, signal: AbortSignal) => Promise<void>;

/** The hook token that finds a Conversation's Research job while it runs. */
export const jobToken = (chatId: string) => `scout-chat:${chatId}`;
/** A workflow run id, as the world makes them. */
export const JOB_RUN_ID = /^wrun_[0-9A-HJKMNP-TV-Z]{26}$/;

const nap: Nap = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });

/**
 * Writes a step's chunks to its run's stream in order, without making the step await each one.
 * A step that writes words marks where it starts ("step"); a retried attempt instead drops what the
 * failed attempt wrote ("reset-step"). The step that re-sends the start of the Answer ("open") marks
 * nothing the first time, so the request can skip what it already sent by count. Research snapshots
 * replace each other, so their steps need no marker ("none"). Close with the same writer: a second
 * writer's close can overtake chunks this one still holds.
 */
export function stepWriter(writable: WritableStream<Chunk>, { attempt, marker }: { attempt: number; marker: "open" | "step" | "none" }) {
  const writer = writable.getWriter();
  let queue = Promise.resolve();
  let failed = false;
  let failure: unknown;
  const write = (chunk: Chunk) => {
    queue = queue
      .then(() => (failed ? undefined : writer.write(chunk)))
      .catch((error) => {
        if (!failed) failure = error;
        failed = true;
      });
  };
  if (attempt > 1 && marker !== "none") write({ type: "reset-step" });
  else if (marker === "step") write({ type: "start-step" });
  const flush = async () => {
    await queue;
    if (failed) throw failure;
  };
  return {
    write,
    flush,
    /** Waits for every chunk, and leaves the stream open for the steps after this one. */
    release: async () => {
      try {
        await flush();
      } finally {
        writer.releaseLock();
      }
    },
    close: async () => {
      await flush();
      await writer.close();
    },
  };
}
export type StepWriter = ReturnType<typeof stepWriter>;

/** The chunks an Answer started with, compacted before a job re-sends them: fewer and whole. */
export function compactChunks(chunks: Chunk[]): Chunk[] {
  const out: Chunk[] = [];
  for (const chunk of chunks) {
    const last = out.at(-1);
    if ((chunk.type === "text-delta" || chunk.type === "reasoning-delta") && last?.type === chunk.type && last.id === chunk.id) {
      out[out.length - 1] = { ...last, delta: last.delta + chunk.delta };
      continue;
    }
    // A data part stays where it first appeared, with its latest data.
    if (chunk.type.startsWith("data-") && "id" in chunk && chunk.id !== undefined) {
      const first = out.findIndex((c) => c.type === chunk.type && "id" in c && c.id === chunk.id);
      if (first >= 0) {
        out[first] = chunk;
        continue;
      }
    }
    out.push(chunk);
  }
  return out;
}

/**
 * A transient chunk that tells the client where the chunks after it sit in the job's stream, and
 * the last chunk's index when it knows it, so a replay can tell when it has caught up.
 */
export const jobPlace = (id: string, index: number, tail?: number): Chunk =>
  ({ type: "data-job", data: { id, index, ...(tail !== undefined && { tail }) }, transient: true });

/**
 * Skips the first `count` chunks of a job's stream, which the client already has, unless a retry of
 * the job's first step dropped them (a "reset-step" among them): then the client gets it all again.
 * `announce` makes a chunk that says where the chunks passed on start, given how many were skipped.
 */
export function skipChunks(source: ReadableStream<Chunk>, count: number, announce?: (skipped: number) => Chunk): ReadableStream<Chunk> {
  let seen = 0;
  let passing = false;
  return source.pipeThrough(new TransformStream<Chunk, Chunk>({
    start(controller) {
      if (announce) controller.enqueue(announce(count));
    },
    transform(chunk, controller) {
      if (!passing) {
        if (seen < count && chunk.type !== "reset-step") {
          seen++;
          return;
        }
        passing = true;
        if (announce && seen < count) controller.enqueue(announce(seen));
      }
      controller.enqueue(chunk);
    },
  }));
}

const STOPPED: Chunk[] = [
  { type: "message-metadata", messageMetadata: { job: { end: "stopped" } } },
  { type: "abort" },
];
const FAILED: Chunk[] = [
  { type: "message-metadata", messageMetadata: { job: { end: "failed" } } },
  { type: "error", errorText: "Research stopped unexpectedly. Please try again." },
];

/**
 * One response's window onto a job's stream: passes its chunks through until the job's stream ends,
 * the window's time is up (the client then opens the next window), or the request goes away. A
 * cancelled or failed run never closes its stream, so the run's status is checked every `pollMs`,
 * and a stopped job's window ends saying so.
 */
export function jobWindow(
  source: ReadableStream<Chunk>,
  { status, until, pollMs = 2000, signal, clock = Date.now, nap: sleep = nap }: {
    status: () => Promise<string>;
    until: number;
    pollMs?: number;
    signal?: AbortSignal;
    clock?: () => number;
    nap?: Nap;
  },
): ReadableStream<Chunk> {
  const reader = source.getReader();
  const done = new AbortController();
  const gone = () => done.signal.aborted || !!signal?.aborted;
  const watching = (async (): Promise<Chunk[]> => {
    for (;;) {
      const state = await status().catch(() => "running");
      if (state === "cancelled") return STOPPED;
      if (state === "failed") return FAILED;
      const left = until - clock();
      if (left <= 0 || gone()) return [];
      await sleep(Math.min(pollMs, left), done.signal).catch(() => {});
      if (gone()) return [];
    }
  })();
  const aborted = new Promise<"aborted">((resolve) => {
    if (signal?.aborted) resolve("aborted");
    signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  const end = (controller: ReadableStreamDefaultController<Chunk>, tail: Chunk[]) => {
    done.abort();
    for (const chunk of tail) controller.enqueue(chunk);
    controller.close();
    reader.cancel().catch(() => {});
  };
  return new ReadableStream<Chunk>({
    async pull(controller) {
      const next = await Promise.race([reader.read(), watching.then((tail) => ({ tail })), aborted]);
      if (next === "aborted") return end(controller, []);
      if ("tail" in next) return end(controller, next.tail);
      if (next.done) return end(controller, []);
      controller.enqueue(next.value);
    },
    cancel() {
      done.abort();
      reader.cancel().catch(() => {});
    },
  });
}

/**
 * Watches a step's own run: cancelling a run does not stop a step that is running, so a step that
 * waits on paid work checks now and every `pollMs`, and its signal aborts once the run is cancelled.
 */
export function watchRun(status: () => Promise<string>, { pollMs = 3000, nap: sleep = nap }: { pollMs?: number; nap?: Nap } = {}) {
  const controller = new AbortController();
  const done = new AbortController();
  void (async () => {
    while (!done.signal.aborted) {
      if ((await status().catch(() => "running")) === "cancelled") {
        controller.abort(new DOMException("The research job was stopped.", "AbortError"));
        return;
      }
      await sleep(pollMs, done.signal).catch(() => {});
    }
  })();
  return { signal: controller.signal, stop: () => done.abort() };
}

/**
 * One active job per Conversation: finds the Conversation's running job by its hook token and
 * cancels it. Returns the cancelled run's id.
 */
export async function replaceActiveJob(
  chatId: string,
  api: { lookup: (token: string) => Promise<string>; status: (runId: string) => Promise<string>; cancel: (runId: string) => Promise<unknown> },
): Promise<string | undefined> {
  let runId: string;
  try {
    runId = await api.lookup(jobToken(chatId));
  } catch {
    return;
  }
  const state = await api.status(runId).catch(() => undefined);
  if (state !== "running" && state !== "pending") return;
  await api.cancel(runId);
  return runId;
}
