import assert from "node:assert/strict";
import { test } from "node:test";
import { APICallError } from "ai";
import {
  activeRunId,
  continueJob,
  jobErrorShown,
  mayHaveLostJob,
  resumePlan,
  withJobEnd,
} from "../lib/research-job-client.ts";

// The browser's side of a Research job: which Answers it still writes, when to reconnect, and
// reading on from one response window to the next.
const user = { id: "u1", role: "user", parts: [{ type: "text", text: "Research ferns" }] };
const answer = (metadata, parts = []) => ({ id: "a1", role: "assistant", metadata, parts });
const research = (phase) => ({ type: "data-research", id: "research", data: { phase, queries: [], sources: [], demo: false } });

test("the job still writing a Conversation's last Answer is known from that Answer", () => {
  assert.equal(activeRunId([user, answer({ job: { id: "wrun_1" } })]), "wrun_1");
  assert.equal(activeRunId([user, answer({ job: { id: "wrun_1", end: "done" } })]), undefined);
  assert.equal(activeRunId([user, answer({ demo: false })]), undefined);
  assert.equal(activeRunId([user]), undefined);
  assert.equal(activeRunId([]), undefined);
});

test("an Answer's job can be marked over, and nothing else changes", () => {
  const messages = [user, answer({ thinkingMs: 5, job: { id: "wrun_1" } }, [{ type: "text", text: "Hi" }])];
  const stopped = withJobEnd(messages, "stopped");
  assert.deepEqual(stopped[1].metadata, { thinkingMs: 5, job: { id: "wrun_1", end: "stopped" } });
  assert.equal(stopped[0], messages[0]);
  assert.equal(stopped[1].parts, messages[1].parts);
  assert.equal(activeRunId(stopped), undefined);
  assert.equal(withJobEnd([user], "stopped").length, 1, "a Conversation without an Answer is left alone");
});

test("an Answer that stopped mid-research without a job id may have a job the server can find", () => {
  assert.equal(mayHaveLostJob([user]), true, "the answer never saved");
  assert.equal(mayHaveLostJob([user, answer({ demo: false }, [research("reading")])]), true);
  assert.equal(mayHaveLostJob([user, answer({ demo: false }, [research("complete"), { type: "text", text: "Done" }])]), false);
  assert.equal(mayHaveLostJob([user, answer({ demo: false }, [{ type: "text", text: "Hi" }])]), false, "plain chat never has a job");
  assert.equal(mayHaveLostJob([user, answer({ job: { id: "wrun_1", end: "done" } }, [research("reading")])]), false);
  assert.equal(mayHaveLostJob([]), false);
});

test("when to reconnect to a job", () => {
  // Opening a Conversation reconnects a Chat that is not already reading its job.
  assert.equal(resumePlan({ status: "ready", runId: "wrun_1", restartLive: false }), "resume");
  assert.equal(resumePlan({ status: "error", runId: "wrun_1", restartLive: false }), "resume");
  assert.equal(resumePlan({ status: "streaming", runId: "wrun_1", restartLive: false }), "none");
  assert.equal(resumePlan({ status: "ready", runId: undefined, restartLive: false }), "none");
  // Coming back to the app (visible, resumed, online) restarts a read that may have gone quiet.
  assert.equal(resumePlan({ status: "streaming", runId: "wrun_1", restartLive: true }), "restart");
  assert.equal(resumePlan({ status: "submitted", runId: "wrun_1", restartLive: true }), "restart");
  assert.equal(resumePlan({ status: "error", runId: "wrun_1", restartLive: true }), "resume");
  assert.equal(resumePlan({ status: "streaming", runId: undefined, restartLive: true }), "none");
});

test("while its job runs, a lost connection shows no error; a refused code or a job that failed does", () => {
  const offline = new TypeError("Failed to fetch");
  assert.equal(jobErrorShown(offline, "wrun_1"), false);
  assert.equal(jobErrorShown(new Error("network error"), "wrun_1"), false);
  assert.equal(jobErrorShown(offline, undefined), true, "without a job, errors show as before");
  const refused = new APICallError({ message: "Scout needs its access code.", url: "/api/jobs/x/stream", requestBodyValues: {}, statusCode: 401 });
  assert.equal(jobErrorShown(refused, "wrun_1"), true);
  assert.equal(jobErrorShown(undefined, "wrun_1"), false);
});

const streamOf = (chunks) => new ReadableStream({
  start(controller) {
    chunks.forEach((c) => controller.enqueue(c));
    controller.close();
  },
});
const readAll = async (stream) => {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
};
const place = (id, index) => ({ type: "data-job", data: { id, index }, transient: true });
const delta = (text) => ({ type: "text-delta", id: "answer-1", delta: text });

test("a window that ends with the job still running is read on from where it ended", async () => {
  const opened = [];
  const windows = [
    streamOf([place("wrun_1", 7), delta("b"), delta("c")]),
    streamOf([place("wrun_1", 9), delta("d"), { type: "finish", finishReason: "stop" }]),
  ];
  const out = await readAll(continueJob(streamOf([{ type: "message-metadata", messageMetadata: { job: { id: "wrun_1" } } }, place("wrun_1", 5), delta("a"), { type: "text-start", id: "answer-1" }]), {
    open: async (id, index) => {
      opened.push([id, index]);
      return windows.shift();
    },
  }));
  assert.deepEqual(opened, [["wrun_1", 7], ["wrun_1", 9]]);
  assert.deepEqual(out.filter((c) => c.type === "text-delta").map((c) => c.delta), ["a", "b", "c", "d"]);
  assert.equal(out.at(-1).type, "finish");
});

test("a finished, stopped or failed job, or plain chat, is not read on", async () => {
  const open = async () => assert.fail("nothing more to read");
  for (const ending of [
    [{ type: "finish", finishReason: "stop" }],
    [{ type: "message-metadata", messageMetadata: { job: { end: "stopped" } } }, { type: "abort" }],
    [{ type: "message-metadata", messageMetadata: { job: { end: "failed" } } }, { type: "error", errorText: "Research stopped unexpectedly." }],
  ])
    await readAll(continueJob(streamOf([place("wrun_1", 3), ...ending]), { open }));
  await readAll(continueJob(streamOf([delta("Hi"), { type: "text-end", id: "answer-1" }]), { open }));
});

test("a job the server no longer has ends the read and is reported", async () => {
  const gone = [];
  const out = await readAll(continueJob(streamOf([place("wrun_1", 3), delta("a")]), {
    open: async () => null,
    onGone: (id) => gone.push(id),
  }));
  assert.equal(out.length, 2);
  assert.deepEqual(gone, ["wrun_1"]);
});

test("a window that cannot be opened fails the read, so the page can reconnect later", async () => {
  await assert.rejects(readAll(continueJob(streamOf([place("wrun_1", 3)]), {
    open: async () => {
      throw new TypeError("Failed to fetch");
    },
  })), /Failed to fetch/);
});
