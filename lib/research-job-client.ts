import { APICallError, DefaultChatTransport, type HttpChatTransportInitOptions, type InferUIMessageChunk } from "ai";
import type { Clock } from "./chat-registry.ts";
import { researchData, type ResearchJob, type ScoutMessage } from "./chat-types.ts";

// The browser's side of a Research job: which Answer a job still writes, reading on from one response
// window to the next, and carrying on by itself when the connection drops, so the Chat never sees a
// lost connection and nothing is replayed. The Chat registry stays unaware of jobs.

type Chunk = InferUIMessageChunk<ScoutMessage>;
type ChatStatus = "submitted" | "streaming" | "ready" | "error";
type Open = (runId: string, startIndex: number, signal: AbortSignal) => Promise<ReadableStream<Chunk> | null>;

/** Tries in a row, each made online, before a read of a job gives up: about four minutes. */
export const MAX_TRIES = 20;
/** A read with a chunk this recent is healthy: the app coming back leaves it alone. */
export const HEALTHY_MS = 10_000;
/** How long a lost connection goes without a chunk before the page says Scout is reconnecting. */
export const QUIET_MS = 4000;
/** The longest a replay is held back while it catches up with the job. */
export const HOLD_MS = 10_000;
/** The wait before try `tries` after a lost connection: 1 s, 2 s, 4 s, 8 s, then 15 s. */
export const retryDelay = (tries: number) => Math.min(15_000, 1000 * 2 ** Math.max(0, tries - 1));

/** Whether the device can reach the network, and news of when it can again. */
export type Network = { online: () => boolean; onOnline: (run: () => void) => () => void };

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
const browserNetwork: Network = {
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  onOnline: (run) => {
    if (typeof window === "undefined") return () => {};
    window.addEventListener("online", run);
    return () => window.removeEventListener("online", run);
  },
};

/** The Research job of a Conversation's last Answer. */
export function lastJob(messages: ScoutMessage[]): ResearchJob | undefined {
  const last = messages.at(-1);
  return last?.role === "assistant" ? last.metadata?.job : undefined;
}

/** The run id of the Research job still writing the last Answer. */
export function activeRunId(messages: ScoutMessage[]): string | undefined {
  const job = lastJob(messages);
  return job?.id && !job.end ? job.id : undefined;
}

/** The messages with the last Answer's Research job marked as over. */
export function withJobEnd(messages: ScoutMessage[], end: NonNullable<ResearchJob["end"]>): ScoutMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !last.metadata?.job) return messages;
  return [...messages.slice(0, -1), { ...last, metadata: { ...last.metadata, job: { ...last.metadata.job, end } } }];
}

/**
 * Whether a Conversation may have a Research job this device never heard of: its question has no
 * saved Answer, or its Answer stopped mid-research without a job id. The server can look it up.
 */
export function mayHaveLostJob(messages: ScoutMessage[]): boolean {
  const last = messages.at(-1);
  if (!last) return false;
  if (last.role === "user") return true;
  if (last.metadata?.job) return false;
  const data = researchData(last);
  return !!data && data.phase !== "complete";
}

/**
 * What the app coming back, going online, or opening a Conversation does for a Chat whose Answer a job
 * may still be writing. A Chat reading its job is only woken ("wake"; the read decides what that
 * needs), never stopped or replayed. Only a Chat with no live read, after a reload or a read that
 * gave up, reads the job again from the start of its stream ("resume").
 */
export function wakePlan({ status, runId, live }: { status: ChatStatus; runId?: string; live: boolean }) {
  if (!runId) return "none";
  if (live) return "wake";
  return status === "submitted" || status === "streaming" ? "none" : "resume";
}

/**
 * What waking a live read does: a read waiting to reconnect tries at once; one with no chunk for
 * HEALTHY_MS may have lost its connection while the app was away, so it opens a fresh window from
 * the same place, which the Chat never sees; a healthy read is left alone. A read whose job is not
 * known yet is the chat request itself, which is never cut.
 */
export function wakeAction({ waiting, reading, lastChunkAt, now }: { waiting: boolean; reading: boolean; lastChunkAt: number; now: number }) {
  if (waiting) return "retry";
  return reading && now - lastChunkAt >= HEALTHY_MS ? "refresh" : "none";
}

/** What a read of a job is doing: open, trying again after a lost connection, and its last chunk's time. */
export type ReadState = { live: boolean; retrying: boolean; lastChunkAt: number };

/** The page says Scout is reconnecting only when a lost connection has gone QUIET_MS without a chunk. */
export const reconnectingShown = (state: ReadState, now: number) =>
  state.live && state.retrying && now - state.lastChunkAt >= QUIET_MS;

/**
 * Whether an error shows while a job writes the Answer: a lost connection does not, since Scout
 * reconnects; a refused access code does, and so does any error once no job is running.
 */
export function jobErrorShown(error: Error | undefined, runId: string | undefined): boolean {
  if (!error) return false;
  if (!runId) return true;
  return refused(error);
}
const refused = (error: unknown) => APICallError.isInstance(error) && [401, 403].includes(error.statusCode ?? 0);
const ends = (chunk: Chunk) =>
  chunk.type === "finish" || chunk.type === "abort" || chunk.type === "error" ||
  (chunk.type === "message-metadata" && !!chunk.messageMetadata?.job?.end);

/**
 * Passes an Answer's chunks through and, while its job runs, reads on from the next chunk when a
 * response window ends (`data-job` says where a window's chunks sit in the job's stream). A window
 * that drops, or cannot be opened, is tried again from the same place after `retryDelay`, only while
 * online, so the Chat never sees the drop; only a job the server no longer has (`open` returns null),
 * a refused access code, or MAX_TRIES failures in a row end the read. `from` starts a read with no
 * first window: a replay from the start of the job's stream, which `hold` keeps back until it reaches
 * where the stream was when it opened (up to HOLD_MS), then passes on at once.
 */
export function continueJob(
  first: ReadableStream<Chunk> | undefined,
  { open, onGone, onState, signal, from, hold = false, clock = systemClock, network = browserNetwork }: {
    open: Open;
    onGone?: (runId: string) => void;
    /** Hears when the read loses its connection, gets it back, and ends. */
    onState?: (state: ReadState) => void;
    signal?: AbortSignal;
    from?: { id: string; index: number };
    hold?: boolean;
    clock?: Clock;
    network?: Network;
  },
): ReadableStream<Chunk> & { wake: () => void } {
  let reader = first?.getReader();
  let place = from && { ...from };
  let pending: Promise<ReadableStreamReadResult<Chunk>> | undefined;
  let opening: AbortController | undefined;
  let waiting: { tryNow: () => void; stop: () => void } | undefined;
  let ended = false;
  let closed = false;
  let retrying = false;
  // A window dropped on purpose (wakeAction's "refresh"): opened again at once, and not a failure.
  let refreshing = false;
  let tries = 0;
  let delay = 0;
  let lastChunkAt = clock.now();
  let windowAt = lastChunkAt;
  let windowChunks = 0;
  // A replay's chunks kept back until it has caught up, and the last index it keeps back.
  let held: Chunk[] = [];
  let holdTo: number | undefined;
  let holdChecked = !hold;
  let holdTimer: unknown;
  let holdOver: Promise<"late"> | undefined;

  const report = () => onState?.({ live: !closed, retrying, lastChunkAt });
  const lost = (error: unknown) => {
    tries++;
    if (tries >= MAX_TRIES) throw error;
    delay = retryDelay(tries);
    if (!retrying) {
      retrying = true;
      report();
    }
  };
  const stopHolding = () => {
    holdTo = undefined;
    clock.clearTimeout(holdTimer);
  };
  const release = (controller: ReadableStreamDefaultController<Chunk>) => {
    stopHolding();
    for (const chunk of held) controller.enqueue(chunk);
    held = [];
  };
  const end = (controller?: ReadableStreamDefaultController<Chunk>) => {
    if (closed) return;
    closed = true;
    retrying = false;
    stopHolding();
    waiting?.stop();
    report();
    controller?.close();
  };
  const gone = () => closed || !!signal?.aborted;
  signal?.addEventListener("abort", () => {
    opening?.abort();
    waiting?.stop();
  }, { once: true });
  // Waits `ms`, then for the device to be online; coming back online ends the wait at once.
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const stop = () => {
        clock.clearTimeout(timer);
        offOnline();
        waiting = undefined;
        resolve();
      };
      const tryNow = () => {
        if (network.online()) stop();
      };
      const timer = clock.setTimeout(tryNow, ms);
      const offOnline = network.onOnline(stop);
      waiting = { tryNow, stop };
    });

  const next = async (controller: ReadableStreamDefaultController<Chunk>) => {
    for (;;) {
      if (gone() || (!reader && !place)) return end(controller);
      if (!reader) {
        if (delay) await pause(delay);
        delay = 0;
        if (gone()) return end(controller);
        const id = place!.id;
        opening = new AbortController();
        let window: ReadableStream<Chunk> | null;
        try {
          window = await open(id, place!.index, opening.signal);
        } catch (error) {
          if (gone()) return end(controller);
          if (refreshing) refreshing = false;
          else if (refused(error)) throw error;
          else lost(error);
          continue;
        } finally {
          opening = undefined;
        }
        if (gone()) {
          void window?.cancel().catch(() => {});
          return end(controller);
        }
        if (!window) {
          release(controller);
          onGone?.(id);
          return end(controller);
        }
        reader = window.getReader();
        refreshing = false;
        windowAt = clock.now();
        windowChunks = 0;
      }
      let result: ReadableStreamReadResult<Chunk> | "late";
      try {
        if (!pending) {
          pending = reader.read();
          pending.catch(() => {});
        }
        result = holdTo !== undefined && holdOver ? await Promise.race([pending, holdOver]) : await pending;
      } catch (error) {
        pending = undefined;
        reader = undefined;
        if (gone()) return end(controller);
        // The chat request itself, before its job was known: the Chat hears of it.
        if (!place) throw error;
        if (refreshing) refreshing = false;
        else lost(error);
        continue;
      }
      if (result === "late") {
        // Slow to catch up: the replay shows as it comes from here.
        const some = held.length > 0;
        release(controller);
        if (some) return;
        continue;
      }
      pending = undefined;
      if (result.done) {
        reader = undefined;
        if (gone()) return end(controller);
        if (ended || !place) {
          release(controller);
          return end(controller);
        }
        if (refreshing) refreshing = false;
        // A window that closes at once with nothing in it is a lost connection too, not a loop.
        else if (!windowChunks && clock.now() - windowAt < 1000) lost(new Error("Scout could not reach the research."));
        else tries = 0;
        continue;
      }
      const chunk = result.value;
      lastChunkAt = clock.now();
      if (retrying) {
        retrying = false;
        report();
      }
      if (chunk.type === "data-job") {
        place = { id: chunk.data.id, index: chunk.data.index };
        const tail = chunk.data.tail;
        if (!holdChecked) {
          holdChecked = true;
          if (tail !== undefined && tail >= chunk.data.index) {
            holdTo = tail;
            holdOver = new Promise((resolve) => {
              holdTimer = clock.setTimeout(() => resolve("late"), HOLD_MS);
            });
          }
        }
      } else {
        tries = 0;
        windowChunks++;
        if (place) place.index++;
        if (ends(chunk)) ended = true;
      }
      if (holdTo !== undefined && !ended && place && place.index <= holdTo) {
        held.push(chunk);
        continue;
      }
      release(controller);
      controller.enqueue(chunk);
      return;
    }
  };

  const stream = new ReadableStream<Chunk>({
    async pull(controller) {
      try {
        await next(controller);
      } catch (error) {
        end();
        throw error;
      }
    },
    cancel(reason) {
      end();
      opening?.abort();
      return reader?.cancel(reason);
    },
  });
  return Object.assign(stream, {
    wake() {
      if (closed) return;
      const action = wakeAction({ waiting: !!waiting, reading: !!place && !!(reader || opening), lastChunkAt, now: clock.now() });
      if (action === "retry") waiting?.tryNow();
      if (action !== "refresh") return;
      refreshing = true;
      if (opening) opening.abort();
      else void reader?.cancel().catch(() => {});
    },
  });
}

/**
 * The Chat transport: DefaultChatTransport, whose streams read on across a job's response windows
 * and carry on by themselves after a lost connection. It replays the job of the Answer on screen from
 * the start of its stream only when the Chat asks to reconnect (a reload, or a read that gave up).
 * `link` tells the page whether a read is live and whether to say Scout is reconnecting.
 */
export class JobChatTransport extends DefaultChatTransport<ScoutMessage> {
  private readonly runId: () => string | undefined;
  private readonly onGone: (runId: string) => void;
  private readonly accessHeaders: () => Record<string, string>;
  private readonly clock: Clock;
  private readonly network: Network;
  private read?: ReturnType<typeof continueJob>;
  private readState: ReadState = { live: false, retrying: false, lastChunkAt: 0 };
  private shown = { live: false, reconnecting: false };
  private timer: unknown;
  private readonly listeners = new Set<() => void>();

  constructor({ runId, onGone, headers, clock = systemClock, network = browserNetwork, ...options }: Omit<HttpChatTransportInitOptions<ScoutMessage>, "headers" | "prepareReconnectToStreamRequest"> & {
    headers: () => Record<string, string>;
    /** The run id of the job to reconnect to. */
    runId: () => string | undefined;
    /** A job the server no longer has (its stream is kept one day). */
    onGone: (runId: string) => void;
    clock?: Clock;
    network?: Network;
  }) {
    super({ ...options, headers });
    this.runId = runId;
    this.onGone = onGone;
    this.accessHeaders = headers;
    this.clock = clock;
    this.network = network;
  }

  /** Whether the Chat's read of its job is live, and whether the page says Scout is reconnecting. */
  readonly link = () => this.shown;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** The app came back or went online: see wakeAction. */
  readonly wake = () => this.read?.wake();

  private update(state: ReadState) {
    this.readState = state;
    this.clock.clearTimeout(this.timer);
    const now = this.clock.now();
    const reconnecting = reconnectingShown(state, now);
    if (state.live && state.retrying && !reconnecting)
      this.timer = this.clock.setTimeout(() => this.update(this.readState), state.lastChunkAt + QUIET_MS - now);
    if (this.shown.live === state.live && this.shown.reconnecting === reconnecting) return;
    this.shown = { live: state.live, reconnecting };
    this.listeners.forEach((listener) => listener());
  }

  private follow(first: ReadableStream<Chunk> | undefined, signal: AbortSignal | undefined, from?: { id: string; index: number }) {
    const read: ReturnType<typeof continueJob> = continueJob(first, {
      open: this.open,
      onGone: this.onGone,
      onState: (state) => {
        if (this.read === read) this.update(state);
      },
      signal,
      from,
      hold: !!from,
      clock: this.clock,
      network: this.network,
    });
    this.read = read;
    this.update({ live: true, retrying: false, lastChunkAt: this.clock.now() });
    return read;
  }

  private readonly open = async (runId: string, startIndex: number, signal: AbortSignal) => {
    const response = await (this.fetch ?? fetch)(jobStreamUrl(runId, startIndex), { headers: this.accessHeaders(), signal });
    if (response.status === 204) return null;
    if (!response.ok || !response.body)
      throw new APICallError({
        message: (await response.text()) || "Scout could not reach the research.",
        url: response.url,
        requestBodyValues: undefined,
        statusCode: response.status,
      });
    return this.processResponseStream(response.body) as ReadableStream<Chunk>;
  };

  async sendMessages(options: Parameters<DefaultChatTransport<ScoutMessage>["sendMessages"]>[0]) {
    return this.follow((await super.sendMessages(options)) as ReadableStream<Chunk>, options.abortSignal);
  }

  async reconnectToStream(options: Parameters<DefaultChatTransport<ScoutMessage>["reconnectToStream"]>[0]) {
    const runId = this.runId();
    if (!runId) return null;
    return this.follow(undefined, options.abortSignal, { id: runId, index: 0 });
  }
}

export const jobStreamUrl = (runId: string, startIndex: number) =>
  `/api/jobs/${encodeURIComponent(runId)}/stream?startIndex=${startIndex}`;
