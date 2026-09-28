import assert from "node:assert/strict";
import { test } from "node:test";
import { APICallError } from "ai";
import {
  HEALTHY_MS,
  HOLD_MS,
  JobChatTransport,
  MAX_TRIES,
  QUIET_MS,
  activeRunId,
  continueJob,
  jobErrorShown,
  mayHaveLostJob,
  reconnectingShown,
  retryDelay,
  wakeAction,
  wakePlan,
  withJobEnd,
} from "../lib/research-job-client.ts";

// The browser's side of a Research job: which Answers it still writes, reading on from one response
// window to the next, and carrying on by itself when the connection drops.
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

test("coming back, going online or opening a Conversation never replays a Chat that is reading its job", () => {
  // A live read decides for itself (wakeAction); the Chat is left alone.
  assert.equal(wakePlan({ status: "streaming", runId: "wrun_1", live: true }), "wake");
  assert.equal(wakePlan({ status: "submitted", runId: "wrun_1", live: true }), "wake");
  // Only a Chat with no live read, after a reload or a read that gave up, reads the job from its start.
  assert.equal(wakePlan({ status: "ready", runId: "wrun_1", live: false }), "resume");
  assert.equal(wakePlan({ status: "error", runId: "wrun_1", live: false }), "resume");
  // A Chat still winding down its read is not resumed on top of it.
  assert.equal(wakePlan({ status: "streaming", runId: "wrun_1", live: false }), "none");
  // No job, nothing to do.
  assert.equal(wakePlan({ status: "ready", runId: undefined, live: false }), "none");
  assert.equal(wakePlan({ status: "streaming", runId: undefined, live: true }), "none");
});

test("a healthy read is left alone when the app comes back; one waiting to reconnect tries at once", () => {
  const now = 100_000;
  assert.equal(wakeAction({ waiting: false, reading: true, lastChunkAt: now - 200, now }), "none");
  assert.equal(wakeAction({ waiting: false, reading: true, lastChunkAt: now - HEALTHY_MS + 1, now }), "none");
  // Quiet for a while: its connection may have died while the app was away, so a fresh window
  // opens from the same place, which the Chat never sees.
  assert.equal(wakeAction({ waiting: false, reading: true, lastChunkAt: now - HEALTHY_MS, now }), "refresh");
  assert.equal(wakeAction({ waiting: true, reading: false, lastChunkAt: now - 200, now }), "retry");
  // Before its job is known the read is the chat request itself, which is never cut.
  assert.equal(wakeAction({ waiting: false, reading: false, lastChunkAt: 0, now }), "none");
});

test("Reconnecting shows only when a lost connection has gone without a chunk for a few seconds", () => {
  const now = 100_000;
  assert.equal(reconnectingShown({ live: true, retrying: true, lastChunkAt: now - QUIET_MS }, now), true);
  assert.equal(reconnectingShown({ live: true, retrying: true, lastChunkAt: now - QUIET_MS + 1 }, now), false, "just dropped");
  assert.equal(reconnectingShown({ live: true, retrying: false, lastChunkAt: now - 60_000 }, now), false, "quiet but reading");
  assert.equal(reconnectingShown({ live: false, retrying: true, lastChunkAt: now - 60_000 }, now), false, "over");
});

test("tries after a lost connection wait 1, 2, 4 and 8 seconds, then 15 at most", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 12].map(retryDelay), [1000, 2000, 4000, 8000, 15_000, 15_000, 15_000]);
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
const place = (id, index, tail) => ({ type: "data-job", data: { id, index, ...(tail !== undefined && { tail }) }, transient: true });
const delta = (text) => ({ type: "text-delta", id: "answer-1", delta: text });

// A clock whose timers run only when a test says so.
function fakeClock() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    setTimeout: (run, ms) => {
      const timer = { at: now + ms, ms, run };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
    advance: (ms) => {
      now += ms;
    },
    /** Runs the soonest timer, moving the clock to it; returns how long it waited. */
    next() {
      const timer = [...timers].sort((a, b) => a.at - b.at)[0];
      if (!timer) return;
      timers.delete(timer);
      now = Math.max(now, timer.at);
      timer.run();
      return timer.ms;
    },
    waiting: () => [...timers].map((t) => t.ms),
  };
}
function fakeNetwork(online = true) {
  const listeners = new Set();
  return {
    online: () => online,
    onOnline: (run) => {
      listeners.add(run);
      return () => listeners.delete(run);
    },
    set(value) {
      online = value;
      if (value) [...listeners].forEach((run) => run());
    },
  };
}
const settle = async (times = 5) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
};
/** A window that sends its chunks and then drops, as when the connection is lost. */
const failing = (chunks, error = new TypeError("network error")) => {
  const left = [...chunks];
  return new ReadableStream({
    pull(controller) {
      if (left.length) controller.enqueue(left.shift());
      else controller.error(error);
    },
  }, { highWaterMark: 0 });
};
/** A window the test feeds by hand; it stays open until the test closes it. */
function held() {
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
    cancel() {
      stream.cancelled = true;
    },
  });
  stream.send = (...chunks) => chunks.forEach((c) => controller.enqueue(c));
  return stream;
}
/** Reads the stream to its end while running the clock's timers, as time would. */
async function drive(stream, clock, { limit = 200 } = {}) {
  const out = [];
  let result;
  (async () => {
    for await (const chunk of stream) out.push(chunk);
  })().then(() => (result = { ok: true }), (error) => (result = { error }));
  for (let i = 0; i < limit && !result; i++) {
    await settle();
    if (!result) clock.next();
  }
  assert.ok(result, "the read never ended");
  if (result.error) throw result.error;
  return out;
}
const start = { type: "start", messageId: "a1" };
const finish = { type: "finish", finishReason: "stop" };
const deltas = (out) => out.filter((c) => c.type === "text-delta").map((c) => c.delta);
const reading = (network = fakeNetwork()) => ({ clock: fakeClock(), network });

test("a window that ends with the job still running is read on from where it ended", async () => {
  const opened = [];
  const windows = [
    streamOf([place("wrun_1", 7), delta("b"), delta("c")]),
    streamOf([place("wrun_1", 9), delta("d"), finish]),
  ];
  const out = await readAll(continueJob(streamOf([{ type: "message-metadata", messageMetadata: { job: { id: "wrun_1" } } }, place("wrun_1", 5), delta("a"), { type: "text-start", id: "answer-1" }]), {
    ...reading(),
    open: async (id, index) => {
      opened.push([id, index]);
      return windows.shift();
    },
  }));
  assert.deepEqual(opened, [["wrun_1", 7], ["wrun_1", 9]]);
  assert.deepEqual(deltas(out), ["a", "b", "c", "d"]);
  assert.equal(out.at(-1).type, "finish");
});

test("a finished, stopped or failed job, or plain chat, is not read on", async () => {
  const open = async () => assert.fail("nothing more to read");
  for (const ending of [
    [finish],
    [{ type: "message-metadata", messageMetadata: { job: { end: "stopped" } } }, { type: "abort" }],
    [{ type: "message-metadata", messageMetadata: { job: { end: "failed" } } }, { type: "error", errorText: "Research stopped unexpectedly." }],
  ])
    await readAll(continueJob(streamOf([place("wrun_1", 3), ...ending]), { ...reading(), open }));
  await readAll(continueJob(streamOf([delta("Hi"), { type: "text-end", id: "answer-1" }]), { ...reading(), open }));
});

test("the chat request failing before its job is known reaches the Chat", async () => {
  const open = async () => assert.fail("no job to read on from");
  await assert.rejects(readAll(continueJob(failing([start, delta("a")]), { ...reading(), open })), /network error/);
});

test("a window dropped mid-read carries on from the next chunk, with no second start and nothing twice", async () => {
  const { clock, network } = reading();
  const opened = [];
  const stream = continueJob(
    failing([start, { type: "text-start", id: "answer-1" }, place("wrun_1", 2), delta("a"), delta("b")]),
    {
      clock,
      network,
      open: async (id, index) => {
        opened.push([id, index]);
        return streamOf([place("wrun_1", index), delta("c"), finish]);
      },
    },
  );
  const out = await drive(stream, clock);
  assert.deepEqual(opened, [["wrun_1", 4]], "read on from the chunk after the last one received");
  assert.deepEqual(deltas(out), ["a", "b", "c"]);
  assert.equal(out.filter((c) => c.type === "start").length, 1);
  assert.equal(out.at(-1).type, "finish");
});

test("windows that cannot be opened are tried again, waiting longer each time, from the same place", async () => {
  const { clock, network } = reading();
  const opened = [];
  const waits = [];
  const stream = continueJob(failing([place("wrun_1", 7), delta("a")]), {
    clock,
    network,
    open: async (id, index) => {
      opened.push(index);
      if (opened.length < 6)
        throw opened.length % 2
          ? new TypeError("Failed to fetch")
          : new APICallError({ message: "Bad gateway", url: "/api/jobs/x/stream", requestBodyValues: {}, statusCode: 502 });
      return streamOf([place("wrun_1", index), delta("b"), finish]);
    },
  });
  const next = clock.next;
  clock.next = () => {
    const ms = next();
    if (ms) waits.push(ms);
    return ms;
  };
  const out = await drive(stream, clock);
  assert.deepEqual(opened, [8, 8, 8, 8, 8, 8]);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 15_000, 15_000]);
  assert.deepEqual(deltas(out), ["a", "b"]);
});

test("a job the server no longer has, or a refused access code, ends the read at once", async () => {
  const gone = [];
  const { clock, network } = reading();
  const out = await drive(continueJob(failing([place("wrun_1", 3), delta("a")]), {
    clock,
    network,
    open: async () => null,
    onGone: (id) => gone.push(id),
  }), clock);
  assert.deepEqual(deltas(out), ["a"]);
  assert.deepEqual(gone, ["wrun_1"]);
  for (const statusCode of [401, 403]) {
    let tries = 0;
    const refused = new APICallError({ message: "Scout needs its access code.", url: "/api/jobs/x/stream", requestBodyValues: {}, statusCode });
    await assert.rejects(drive(continueJob(failing([place("wrun_1", 3)]), {
      clock,
      network,
      open: async () => {
        tries++;
        throw refused;
      },
    }), clock), (error) => error === refused);
    assert.equal(tries, 1, "a refused code is not tried again");
  }
});

test("a read gives up only after failing for minutes", async () => {
  const { clock, network } = reading();
  let tries = 0;
  const lost = new TypeError("Failed to fetch");
  await assert.rejects(drive(continueJob(failing([place("wrun_1", 3), delta("a")]), {
    clock,
    network,
    open: async () => {
      tries++;
      throw lost;
    },
  }), clock), (error) => error === lost);
  assert.equal(tries, MAX_TRIES - 1, "the drop itself was the first failure");
  assert.ok(clock.now() >= 180_000, `gave up after ${clock.now()} ms`);
});

test("a window that closes at once with nothing in it waits before the next, instead of looping", async () => {
  const { clock, network } = reading();
  let tries = 0;
  const out = await drive(continueJob(streamOf([place("wrun_1", 3), delta("a")]), {
    clock,
    network,
    open: async (id, index) => (++tries < 3 ? streamOf([place("wrun_1", index)]) : streamOf([place("wrun_1", index), finish])),
  }), clock);
  assert.equal(tries, 3);
  assert.equal(clock.now(), 1000 + 2000);
  assert.equal(out.at(-1).type, "finish");
});

test("while offline a read waits, and tries again as soon as the device is back online", async () => {
  const { clock, network } = reading(fakeNetwork(false));
  const opened = [];
  const stream = continueJob(failing([place("wrun_1", 3), delta("a")]), {
    clock,
    network,
    open: async (id, index) => {
      opened.push(index);
      return streamOf([place("wrun_1", index), delta("b"), finish]);
    },
  });
  const done = readAll(stream);
  for (let i = 0; i < 6; i++) {
    await settle();
    clock.next();
  }
  assert.deepEqual(opened, [], "no tries while offline, however long");
  stream.wake();
  await settle();
  assert.deepEqual(opened, [], "coming back while offline does not try either");
  network.set(true);
  const out = await done;
  assert.deepEqual(opened, [4]);
  assert.deepEqual(deltas(out), ["a", "b"]);
});

test("a window that drops after the job's last chunk ends the read at once, also offline", async () => {
  for (const ending of [
    [finish],
    [{ type: "message-metadata", messageMetadata: { job: { end: "stopped" } } }, { type: "abort" }],
    [{ type: "message-metadata", messageMetadata: { job: { end: "failed" } } }, { type: "error", errorText: "Research stopped unexpectedly." }],
  ]) {
    for (const online of [false, true]) {
      const { clock, network } = reading(fakeNetwork(online));
      const opened = [];
      const states = [];
      const out = await drive(continueJob(failing([place("wrun_1", 3), delta("a"), ...ending]), {
        clock,
        network,
        onState: (state) => states.push(state),
        open: async (id, index) => {
          opened.push(index);
          return null;
        },
        onGone: () => assert.fail("the Answer is whole, not gone"),
      }), clock);
      assert.deepEqual(deltas(out), ["a"]);
      assert.equal(out.at(-1).type, ending.at(-1).type);
      assert.deepEqual(opened, [], "nothing is read past the end");
      assert.equal(clock.now(), 0, "and nothing is waited for");
      assert.deepEqual(states.map(({ live, retrying }) => [live, retrying]), [[false, false]], "never said to be reconnecting");
    }
  }
});

test("waking a read that waits to reconnect tries at once", async () => {
  const { clock, network } = reading();
  const opened = [];
  const stream = continueJob(failing([place("wrun_1", 3), delta("a")]), {
    clock,
    network,
    open: async (id, index) => {
      opened.push(index);
      if (opened.length === 1) throw new TypeError("Failed to fetch");
      return streamOf([place("wrun_1", index), delta("b"), finish]);
    },
  });
  const done = readAll(stream);
  await settle();
  clock.next();
  await settle();
  assert.deepEqual(opened, [4]);
  assert.deepEqual(clock.waiting(), [2000], "waiting to try again");
  stream.wake();
  const out = await done;
  assert.deepEqual(opened, [4, 4]);
  assert.deepEqual(deltas(out), ["a", "b"]);
});

test("waking a healthy read does nothing; one quiet for a while gets a fresh window from the same place", async () => {
  const { clock, network } = reading();
  const first = held();
  const opened = [];
  const stream = continueJob(first, {
    clock,
    network,
    open: async (id, index) => {
      opened.push(index);
      return streamOf([place("wrun_1", index), delta("c"), finish]);
    },
  });
  const reader = stream.getReader();
  first.send(place("wrun_1", 5), delta("a"), delta("b"));
  const got = [(await reader.read()).value, (await reader.read()).value, (await reader.read()).value];
  assert.deepEqual(deltas(got), ["a", "b"]);
  const nextRead = reader.read();
  clock.advance(HEALTHY_MS - 1);
  stream.wake();
  await settle();
  assert.deepEqual(opened, [], "a chunk came recently");
  assert.equal(first.cancelled, undefined);
  clock.advance(1);
  stream.wake();
  const out = [(await nextRead).value];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out.push(value);
  }
  assert.equal(first.cancelled, true, "the quiet window was dropped");
  assert.deepEqual(opened, [7]);
  assert.deepEqual(deltas(out), ["c"]);
});

test("Stop ends a read, also while it waits to reconnect", async () => {
  const stop = new AbortController();
  let tries = 0;
  const stream = continueJob(failing([place("wrun_1", 3), delta("a")]), {
    ...reading(),
    signal: stop.signal,
    open: async () => {
      tries++;
      return streamOf([finish]);
    },
  });
  const done = readAll(stream);
  await settle();
  stop.abort();
  const out = await done;
  assert.deepEqual(deltas(out), ["a"]);
  assert.equal(tries, 0);
});

test("a read reports when it loses its connection, gets it back and ends", async () => {
  const { clock, network } = reading();
  const states = [];
  const stream = continueJob(failing([place("wrun_1", 3), delta("a")]), {
    clock,
    network,
    onState: (state) => states.push(state),
    open: async (id, index) => streamOf([place("wrun_1", index), delta("b"), finish]),
  });
  await drive(stream, clock);
  assert.deepEqual(states.map(({ live, retrying }) => [live, retrying]), [[true, true], [true, false], [false, false]]);
});

test("a replay is held until it reaches the job's stream as it was when it opened, then passed on at once", async () => {
  const window = held();
  const stream = continueJob(undefined, { ...reading(), from: { id: "wrun_1", index: 0 }, hold: true, open: async () => window });
  const reader = stream.getReader();
  let first;
  void reader.read().then((r) => (first = r));
  window.send(place("wrun_1", 0, 3), start, delta("a"), delta("b"));
  await settle();
  assert.equal(first, undefined, "nothing reaches the Chat while the replay catches up");
  window.send(delta("c"));
  await settle();
  assert.equal(first.value.type, "data-job");
  const caughtUp = [];
  for (let i = 0; i < 4; i++) caughtUp.push((await reader.read()).value);
  assert.deepEqual(caughtUp.map((c) => c.type), ["start", "text-delta", "text-delta", "text-delta"]);
  // From there on, chunks pass as they come.
  const next = reader.read();
  window.send(delta("d"));
  assert.equal((await next).value.delta, "d");
});

test("a replay that is slow to catch up is shown as it comes after a while", async () => {
  const { clock, network } = reading();
  const window = held();
  const stream = continueJob(undefined, { clock, network, from: { id: "wrun_1", index: 0 }, hold: true, open: async () => window });
  const reader = stream.getReader();
  const firstRead = reader.read();
  window.send(place("wrun_1", 0, 30), start, delta("a"));
  await settle();
  assert.deepEqual(clock.waiting(), [HOLD_MS]);
  clock.next();
  assert.equal((await firstRead).value.type, "data-job");
  assert.equal((await reader.read()).value.type, "start");
  assert.equal((await reader.read()).value.delta, "a");
  const next = reader.read();
  window.send(delta("b"));
  assert.equal((await next).value.delta, "b");
});

// The server's side for the transport: the chat request, then the job's stream from any index.
function sse(chunks, { drop = false } = {}) {
  const encoder = new TextEncoder();
  const left = [...chunks];
  return new Response(new ReadableStream({
    pull(controller) {
      if (left.length) controller.enqueue(encoder.encode(`data: ${JSON.stringify(left.shift())}\n\n`));
      else if (drop) controller.error(new TypeError("network error"));
      else controller.close();
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}
const send = (transport) => transport.sendMessages({ chatId: "c1", messages: [], trigger: "submit-message", messageId: undefined });

test("the transport carries a dropped answer on by itself: the Chat sees one unbroken stream", async () => {
  const job = [start, { type: "text-start", id: "answer-1" }, delta("a"), delta("b"), delta("c"), { type: "text-end", id: "answer-1" }, finish];
  const requests = [];
  const { clock, network } = reading();
  const transport = new JobChatTransport({
    api: "/api/chat",
    headers: () => ({ "x-scout-access": "code" }),
    runId: () => "wrun_1",
    onGone: () => assert.fail("the job is still there"),
    clock,
    network,
    fetch: async (url, init) => {
      requests.push([String(url), init?.headers?.["x-scout-access"]]);
      if (url === "/api/chat") return sse([...job.slice(0, 2), place("wrun_1", 2), job[2], job[3]], { drop: true });
      const index = Number(new URL(url, "https://scout.test").searchParams.get("startIndex"));
      return sse([place("wrun_1", index), ...job.slice(index)]);
    },
  });
  const out = (await drive(await send(transport), clock)).filter((c) => c.type !== "data-job");
  assert.deepEqual(out, job);
  assert.deepEqual(requests, [["/api/chat", "code"], ["/api/jobs/wrun_1/stream?startIndex=4", "code"]]);
  assert.deepEqual(transport.link(), { live: false, reconnecting: false });
});

test("the transport replays a job from its start after a reload, held until it has caught up", async () => {
  const { clock, network } = reading();
  const transport = new JobChatTransport({
    api: "/api/chat",
    headers: () => ({}),
    runId: () => "wrun_1",
    onGone: () => assert.fail("the job is still there"),
    clock,
    network,
    fetch: async (url) => {
      assert.equal(url, "/api/jobs/wrun_1/stream?startIndex=0");
      return sse([place("wrun_1", 0, 2), start, delta("a"), delta("b"), finish]);
    },
  });
  const stream = await transport.reconnectToStream({ chatId: "c1" });
  assert.equal(transport.link().live, true, "reading from the moment the Chat asks");
  const out = await drive(stream, clock);
  assert.deepEqual(deltas(out), ["a", "b"]);
  assert.equal(transport.link().live, false);
});

/** A job's stream response the test feeds by hand. */
function sseByHand() {
  const encoder = new TextEncoder();
  let controller;
  const response = new Response(new ReadableStream({
    start(c) {
      controller = c;
    },
  }), { headers: { "content-type": "text/event-stream" } });
  return {
    response,
    send: (...chunks) => chunks.forEach((c) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`))),
    close: () => controller.close(),
  };
}
const replayTransport = (clock, network, fetch) => new JobChatTransport({
  api: "/api/chat",
  headers: () => ({}),
  runId: () => "wrun_1",
  onGone: () => assert.fail("the job is still there"),
  clock,
  network,
  fetch,
});
const readRest = async (reader) => {
  const out = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out.push(value);
  }
};

test("a replay after a reload that is slow to come says Reconnecting after a few quiet seconds, until it shows", async () => {
  const { clock, network } = reading();
  let respond;
  const transport = replayTransport(clock, network, () => new Promise((resolve) => {
    respond = () => resolve(sse([place("wrun_1", 0, 2), start, delta("a"), delta("b"), finish]));
  }));
  const reader = (await transport.reconnectToStream({ chatId: "c1" })).getReader();
  const first = reader.read();
  await settle();
  assert.deepEqual(transport.link(), { live: true, reconnecting: false }, "a replay that comes quickly needs no note");
  assert.deepEqual(clock.waiting(), [QUIET_MS]);
  clock.next();
  assert.deepEqual(transport.link(), { live: true, reconnecting: true }, "the saved answer sits still: Scout says it is reconnecting");
  respond();
  assert.equal((await first).value.type, "data-job");
  assert.deepEqual(transport.link(), { live: true, reconnecting: false }, "the replay has reached the Chat");
  assert.deepEqual(deltas(await readRest(reader)), ["a", "b"]);
  assert.deepEqual(transport.link(), { live: false, reconnecting: false });
});

test("a replay held while it catches up says Reconnecting after a few quiet seconds, until it is passed on", async () => {
  const { clock, network } = reading();
  const window = sseByHand();
  const transport = replayTransport(clock, network, async () => window.response);
  const reader = (await transport.reconnectToStream({ chatId: "c1" })).getReader();
  const first = reader.read();
  window.send(place("wrun_1", 0, 30), start, delta("a"));
  await settle();
  assert.deepEqual(transport.link(), { live: true, reconnecting: false });
  // Chunks come in, but none reaches the answer on screen yet.
  clock.next();
  assert.equal(clock.now(), QUIET_MS);
  assert.deepEqual(transport.link(), { live: true, reconnecting: true });
  window.send(delta("b"));
  await settle();
  assert.deepEqual(transport.link(), { live: true, reconnecting: true }, "still held");
  clock.next();
  assert.equal(clock.now(), HOLD_MS);
  assert.equal((await first).value.type, "data-job");
  assert.deepEqual(transport.link(), { live: true, reconnecting: false }, "shown as it comes from here");
  window.send(delta("c"), finish);
  window.close();
  assert.deepEqual(deltas(await readRest(reader)), ["a", "b", "c"]);
  assert.deepEqual(transport.link(), { live: false, reconnecting: false });
});

test("a job gone from the server ends the transport's replay, and the page hears of it", async () => {
  const gone = [];
  const { clock, network } = reading();
  const transport = new JobChatTransport({
    api: "/api/chat",
    headers: () => ({}),
    runId: () => "wrun_1",
    onGone: (id) => gone.push(id),
    clock,
    network,
    fetch: async () => new Response(null, { status: 204 }),
  });
  assert.deepEqual(await drive(await transport.reconnectToStream({ chatId: "c1" }), clock), []);
  assert.deepEqual(gone, ["wrun_1"]);
  assert.equal(await new JobChatTransport({ api: "/api/chat", headers: () => ({}), runId: () => undefined, onGone: () => {} })
    .reconnectToStream({ chatId: "c1" }), null, "no job, nothing to read");
});

test("the transport says Reconnecting only after a lost connection has been quiet for a few seconds", async () => {
  const { clock, network } = reading();
  let fail = true;
  const transport = new JobChatTransport({
    api: "/api/chat",
    headers: () => ({}),
    runId: () => "wrun_1",
    onGone: () => {},
    clock,
    network,
    fetch: async (url) => {
      if (url === "/api/chat") return sse([start, place("wrun_1", 1), delta("a")], { drop: true });
      if (fail) throw new TypeError("Failed to fetch");
      return sse([place("wrun_1", 2), finish]);
    },
  });
  const heard = [];
  transport.subscribe(() => heard.push(transport.link()));
  const done = readAll(await send(transport));
  await settle();
  assert.deepEqual(transport.link(), { live: true, reconnecting: false }, "just dropped: the answer on screen needs no note");
  // Tries at 1 and 3 seconds fail; the note shows once 4 seconds pass without a chunk.
  while (clock.now() < QUIET_MS) {
    clock.next();
    await settle();
  }
  assert.deepEqual(transport.link(), { live: true, reconnecting: true });
  fail = false;
  transport.wake();
  await done;
  assert.deepEqual(transport.link(), { live: false, reconnecting: false });
  assert.deepEqual(heard, [
    { live: true, reconnecting: false },
    { live: true, reconnecting: true },
    { live: true, reconnecting: false },
    { live: false, reconnecting: false },
  ]);
});
