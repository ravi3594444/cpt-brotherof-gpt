import assert from "node:assert/strict";
import { test } from "node:test";
import {
  JOB_RUN_ID,
  compactChunks,
  jobPlace,
  jobToken,
  jobWindow,
  replaceActiveJob,
  skipChunks,
  stepWriter,
  watchRun,
} from "../lib/job-stream.ts";

// The pieces between a Research job's durable stream and the responses that carry it.
function sink() {
  const chunks = [];
  let closed = false;
  const writable = new WritableStream({
    write: (chunk) => {
      chunks.push(chunk);
    },
    close: () => {
      closed = true;
    },
  });
  return { writable, chunks, closed: () => closed };
}
const readAll = async (stream) => {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
};
const streamOf = (chunks, { close = true } = {}) => new ReadableStream({
  start(controller) {
    chunks.forEach((c) => controller.enqueue(c));
    if (close) controller.close();
  },
});

test("a step writer keeps its chunks in order and closes the stream with the same writer", async () => {
  const out = sink();
  const writer = stepWriter(out.writable, { attempt: 1, marker: "step" });
  writer.write({ type: "text-start", id: "a" });
  writer.write({ type: "text-delta", id: "a", delta: "Hi" });
  writer.write({ type: "finish", finishReason: "stop" });
  await writer.close();
  assert.deepEqual(out.chunks.map((c) => c.type), ["start-step", "text-start", "text-delta", "finish"]);
  assert.equal(out.closed(), true);
});

test("a retried step first drops what its failed attempt wrote", async () => {
  const again = sink();
  const writer = stepWriter(again.writable, { attempt: 2, marker: "step" });
  writer.write({ type: "text-start", id: "a" });
  await writer.release();
  assert.deepEqual(again.chunks.map((c) => c.type), ["reset-step", "text-start"]);
  assert.equal(again.closed(), false, "releasing leaves the stream open for later steps");

  // The step that re-sends the start of the answer marks nothing the first time, so the request can skip it by count.
  const first = sink();
  const open = stepWriter(first.writable, { attempt: 1, marker: "open" });
  open.write({ type: "start", messageId: "m" });
  await open.release();
  assert.deepEqual(first.chunks.map((c) => c.type), ["start"]);
  const retried = sink();
  const reopened = stepWriter(retried.writable, { attempt: 3, marker: "open" });
  reopened.write({ type: "start", messageId: "m" });
  await reopened.release();
  assert.deepEqual(retried.chunks.map((c) => c.type), ["reset-step", "start"]);

  const research = sink();
  const plain = stepWriter(research.writable, { attempt: 2, marker: "none" });
  plain.write({ type: "data-research", id: "research", data: {} });
  await plain.release();
  assert.deepEqual(research.chunks.map((c) => c.type), ["data-research"], "Research snapshots replace each other, so no marker");
});

test("a failed write surfaces when the step flushes, not as an unhandled rejection", async () => {
  const writable = new WritableStream({ write: () => Promise.reject(new Error("stream gone")) });
  const writer = stepWriter(writable, { attempt: 1, marker: "none" });
  writer.write({ type: "text-start", id: "a" });
  writer.write({ type: "text-delta", id: "a", delta: "x" });
  await assert.rejects(writer.release(), /stream gone/);
});

test("a reset in the start of an answer drops what came before it, so the job re-sends only what the app ended with", () => {
  const research = (steps) => ({ type: "data-research", id: "research", data: { steps } });
  const compacted = compactChunks([
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "I'll research that." },
    research(["one"]),
    { type: "reset-step" },
    { type: "reasoning-start", id: "thinking-1" },
    { type: "reasoning-delta", id: "thinking-1", delta: "I'll research that." },
    research(["one"]),
    { type: "reasoning-end", id: "thinking-1" },
    research(["one", "two"]),
  ]);
  assert.deepEqual(compacted, [
    { type: "reasoning-start", id: "thinking-1" },
    { type: "reasoning-delta", id: "thinking-1", delta: "I'll research that." },
    research(["one", "two"]),
    { type: "reasoning-end", id: "thinking-1" },
  ]);
  // A reset takes back only its own step.
  assert.deepEqual(compactChunks([
    research(["one"]),
    { type: "start-step" },
    { type: "text-start", id: "a" },
    { type: "reset-step" },
    { type: "text-start", id: "b" },
  ]), [research(["one"]), { type: "start-step" }, { type: "text-start", id: "b" }]);
});

test("the start of an answer is compacted before a job re-sends it", () => {
  const research = (steps) => ({ type: "data-research", id: "research", data: { steps } });
  assert.deepEqual(compactChunks([
    { type: "reasoning-start", id: "thinking-1" },
    { type: "reasoning-delta", id: "thinking-1", delta: "A " },
    { type: "reasoning-delta", id: "thinking-1", delta: "plant." },
    { type: "message-metadata", messageMetadata: { thinkingMs: 40 } },
    { type: "reasoning-end", id: "thinking-1" },
    research(["one"]),
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "Let " },
    { type: "text-delta", id: "answer", delta: "me look." },
    { type: "text-end", id: "answer" },
    research(["one", "two"]),
  ]), [
    { type: "reasoning-start", id: "thinking-1" },
    { type: "reasoning-delta", id: "thinking-1", delta: "A plant." },
    { type: "message-metadata", messageMetadata: { thinkingMs: 40 } },
    { type: "reasoning-end", id: "thinking-1" },
    research(["one", "two"]),
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "Let me look." },
    { type: "text-end", id: "answer" },
  ]);
});

test("the request skips what the job re-sends, unless the job's first step was retried", async () => {
  const chunks = (types) => types.map((type, i) => ({ type, n: i }));
  const skipped = await readAll(skipChunks(streamOf(chunks(["start", "reasoning-start", "data-research", "text-start"])), 3));
  assert.deepEqual(skipped.map((c) => c.type), ["text-start"]);
  // A retry of the first step wrote reset-step and the start again: the client must see both.
  const retried = await readAll(skipChunks(streamOf(chunks(["start", "reset-step", "start", "reasoning-start", "data-research", "text-start"])), 3));
  assert.deepEqual(retried.map((c) => c.type), ["reset-step", "start", "reasoning-start", "data-research", "text-start"]);
  // The client learns where the chunks it gets sit in the job's stream, to open the next window there.
  const placed = await readAll(skipChunks(streamOf(chunks(["start", "a", "reset-step", "start", "b"])), 3, (i) => jobPlace("wrun_1", i)));
  assert.deepEqual(placed.map((c) => (c.type === "data-job" ? c.data.index : c.type)), [3, 2, "reset-step", "start", "b"]);
  assert.equal(placed[0].transient, true);
  const fromStart = await readAll(skipChunks(streamOf(chunks(["x"])), 0, (i) => jobPlace("wrun_1", 7 + i)));
  assert.deepEqual(fromStart.map((c) => (c.type === "data-job" ? c.data.index : c.type)), [7, "x"]);
});

test("a window's place can say how far the job's stream had reached, so a replay knows when it has caught up", () => {
  assert.deepEqual(jobPlace("wrun_1", 0, 41), { type: "data-job", data: { id: "wrun_1", index: 0, tail: 41 }, transient: true });
  assert.deepEqual(jobPlace("wrun_1", 5), { type: "data-job", data: { id: "wrun_1", index: 5 }, transient: true });
});

// A fake clock whose naps pass instantly.
function fakeTime() {
  let now = 0;
  return {
    clock: () => now,
    nap: async (ms) => {
      now += ms;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}
const running = () => Promise.resolve("running");

test("a job window passes the job's chunks through and ends with the job", async () => {
  const time = fakeTime();
  const out = await readAll(jobWindow(streamOf([{ type: "text-delta", id: "a", delta: "x" }, { type: "finish" }]),
    { status: running, until: 10_000, ...time }));
  assert.deepEqual(out.map((c) => c.type), ["text-delta", "finish"]);
});

test("a job window ends cleanly when its time is up, so the client can open the next one", async () => {
  const time = fakeTime();
  let cancelled = false;
  const source = new ReadableStream({ start(c) { c.enqueue({ type: "text-delta", id: "a", delta: "x" }); }, cancel() { cancelled = true; } });
  const out = await readAll(jobWindow(source, { status: running, until: 5000, pollMs: 1000, ...time }));
  assert.deepEqual(out.map((c) => c.type), ["text-delta"], "no finish and no stop marker");
  assert.equal(cancelled, true);
  assert.ok(time.clock() >= 5000);
});

test("a stopped job's window says so and aborts, since a cancelled run never closes its stream", async () => {
  const time = fakeTime();
  let status = "running";
  const source = new ReadableStream({ start(c) { c.enqueue({ type: "data-research", id: "research", data: {} }); } });
  setTimeout(() => (status = "cancelled"), 5);
  const out = await readAll(jobWindow(source, { status: async () => status, until: Infinity, pollMs: 1000, ...time }));
  assert.deepEqual(out, [
    { type: "data-research", id: "research", data: {} },
    { type: "message-metadata", messageMetadata: { job: { end: "stopped" } } },
    { type: "abort" },
  ]);
});

test("a failed job's window says so with a plain error", async () => {
  const time = fakeTime();
  const out = await readAll(jobWindow(streamOf([], { close: false }), { status: async () => "failed", until: Infinity, ...time }));
  assert.deepEqual(out.map((c) => c.type), ["message-metadata", "error"]);
  assert.deepEqual(out[0].messageMetadata, { job: { end: "failed" } });
  assert.match(out[1].errorText, /stopped unexpectedly/);
});

test("a job window stops when its request goes away", async () => {
  const time = fakeTime();
  const controller = new AbortController();
  const window = jobWindow(streamOf([], { close: false }), { status: running, until: Infinity, pollMs: 1000, signal: controller.signal, ...time });
  const reading = readAll(window);
  controller.abort();
  assert.deepEqual(await reading, []);
});

test("a step watching its run aborts when the run is cancelled", async () => {
  const time = fakeTime();
  let status = "running";
  const watch = watchRun(async () => status, { pollMs: 3000, nap: time.nap });
  await time.nap(0);
  assert.equal(watch.signal.aborted, false);
  status = "cancelled";
  await new Promise((resolve) => watch.signal.addEventListener("abort", resolve));
  assert.equal(watch.signal.reason.name, "AbortError");
  watch.stop();
  const quiet = watchRun(running, { pollMs: 3000, nap: time.nap });
  quiet.stop();
  await time.nap(0);
  assert.equal(quiet.signal.aborted, false);
});

test("one active job per conversation: a new durable turn cancels the conversation's running job", async () => {
  const cancelled = [];
  const api = (hooks, statuses) => ({
    lookup: async (token) => {
      if (!(token in hooks)) throw Object.assign(new Error("Hook not found"), { name: "HookNotFoundError" });
      return hooks[token];
    },
    status: async (runId) => statuses[runId],
    cancel: async (runId) => cancelled.push(runId),
  });
  const token = jobToken("chat-1");
  assert.equal(token, "scout-chat:chat-1");
  assert.equal(await replaceActiveJob("chat-1", api({ [token]: "wrun_A" }, { wrun_A: "running" })), "wrun_A");
  assert.equal(await replaceActiveJob("chat-1", api({ [token]: "wrun_B" }, { wrun_B: "pending" })), "wrun_B");
  assert.equal(await replaceActiveJob("chat-1", api({ [token]: "wrun_C" }, { wrun_C: "completed" })), undefined);
  assert.equal(await replaceActiveJob("chat-1", api({}, {})), undefined);
  assert.deepEqual(cancelled, ["wrun_A", "wrun_B"]);
});

test("run ids are checked before they reach the workflow world", () => {
  assert.ok(JOB_RUN_ID.test("wrun_01M3HJRGX9J3P49ZHC8X0VC82H"));
  for (const bad of ["", "wrun_", "../etc", "wrun_01M3HJRGX9J3P49ZHC8X0VC82H/..", "run_01M3HJRGX9J3P49ZHC8X0VC82H"])
    assert.ok(!JOB_RUN_ID.test(bad), bad);
});
