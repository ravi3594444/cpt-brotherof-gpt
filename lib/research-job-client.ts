import { APICallError, DefaultChatTransport, type HttpChatTransportInitOptions, type InferUIMessageChunk } from "ai";
import { researchData, type ResearchJob, type ScoutMessage } from "./chat-types.ts";

// The browser's side of a Research job: which Answer a job still writes, when to reconnect to it,
// and reading on from one response window to the next. The Chat registry stays unaware of jobs.

type Chunk = InferUIMessageChunk<ScoutMessage>;
type ChatStatus = "submitted" | "streaming" | "ready" | "error";

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
 * What to do for a Chat whose Answer a job may still be writing: reconnect ("resume"), drop a read
 * that may have gone quiet and reconnect ("restart", when the app comes back), or nothing.
 */
export function resumePlan({ status, runId, restartLive }: { status: ChatStatus; runId?: string; restartLive: boolean }) {
  if (!runId) return "none";
  if (status === "submitted" || status === "streaming") return restartLive ? "restart" : "none";
  return "resume";
}

/**
 * Whether an error shows while a job writes the Answer: a lost connection does not, since Scout
 * reconnects; a refused access code does, and so does any error once no job is running.
 */
export function jobErrorShown(error: Error | undefined, runId: string | undefined): boolean {
  if (!error) return false;
  if (!runId) return true;
  return APICallError.isInstance(error) && [401, 403].includes(error.statusCode ?? 0);
}

/**
 * Passes an Answer's chunks through and, when a response window ends while its job still runs,
 * reads on from the next chunk (`data-job` says where a window's chunks sit in the job's stream).
 * `open` returns the next window, or null when the server no longer has the job.
 */
export function continueJob(
  first: ReadableStream<Chunk>,
  { open, onGone, signal }: {
    open: (runId: string, startIndex: number, signal?: AbortSignal) => Promise<ReadableStream<Chunk> | null>;
    onGone?: (runId: string) => void;
    signal?: AbortSignal;
  },
): ReadableStream<Chunk> {
  let reader = first.getReader();
  let place: { id: string; index: number } | undefined;
  let ended = false;
  return new ReadableStream<Chunk>({
    async pull(controller) {
      for (;;) {
        const { value, done } = await reader.read();
        if (!done) {
          if (value.type === "data-job") place = { ...value.data };
          else {
            if (place) place.index++;
            if (value.type === "finish" || value.type === "abort" || value.type === "error") ended = true;
            if (value.type === "message-metadata" && value.messageMetadata?.job?.end) ended = true;
          }
          controller.enqueue(value);
          return;
        }
        if (ended || !place || signal?.aborted) return controller.close();
        const next = await open(place.id, place.index, signal);
        if (!next) {
          onGone?.(place.id);
          return controller.close();
        }
        reader = next.getReader();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * The Chat transport: DefaultChatTransport, whose streams read on across a job's response windows,
 * and which reconnects to the job of the Answer on screen from the start of its stream.
 */
export class JobChatTransport extends DefaultChatTransport<ScoutMessage> {
  private readonly runId: () => string | undefined;
  private readonly onGone: (runId: string) => void;
  private readonly accessHeaders: () => Record<string, string>;

  constructor({ runId, onGone, headers, ...options }: Omit<HttpChatTransportInitOptions<ScoutMessage>, "headers" | "prepareReconnectToStreamRequest"> & {
    headers: () => Record<string, string>;
    /** The run id of the job to reconnect to. */
    runId: () => string | undefined;
    /** A job the server no longer has (its stream is kept one day). */
    onGone: (runId: string) => void;
  }) {
    super({
      ...options,
      headers,
      prepareReconnectToStreamRequest: () => ({ api: jobStreamUrl(runId() ?? "none", 0) }),
    });
    this.runId = runId;
    this.onGone = onGone;
    this.accessHeaders = headers;
  }

  private readonly open = async (runId: string, startIndex: number, signal?: AbortSignal) => {
    const response = await fetch(jobStreamUrl(runId, startIndex), { headers: this.accessHeaders(), signal });
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
    return continueJob((await super.sendMessages(options)) as ReadableStream<Chunk>, { open: this.open, onGone: this.onGone, signal: options.abortSignal });
  }

  async reconnectToStream(options: Parameters<DefaultChatTransport<ScoutMessage>["reconnectToStream"]>[0]) {
    const runId = this.runId();
    if (!runId) return null;
    const stream = await super.reconnectToStream(options);
    if (!stream) {
      this.onGone(runId);
      return null;
    }
    return continueJob(stream as ReadableStream<Chunk>, { open: this.open, onGone: this.onGone, signal: options.abortSignal });
  }
}

export const jobStreamUrl = (runId: string, startIndex: number) =>
  `/api/jobs/${encodeURIComponent(runId)}/stream?startIndex=${startIndex}`;
