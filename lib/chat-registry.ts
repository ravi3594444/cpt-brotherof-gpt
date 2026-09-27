// One Chat per Conversation, kept by the page rather than by the Conversation on
// screen, so switching Conversations never stops or loses an Answer. It uses only
// what @ai-sdk/react's Chat reports, whatever transport the Chat sends through.

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

/** The parts of an @ai-sdk/react Chat the registry uses. */
export type RegistryChat<M> = {
  readonly status: ChatStatus;
  readonly messages: M[];
  stop: () => unknown;
  "~registerMessagesCallback": (onChange: () => void) => () => void;
  "~registerStatusCallback": (onChange: () => void) => () => void;
};

export type Clock = {
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

export type ChatRegistry<C> = {
  /** The Conversation's Chat, made with `create` the first time. */
  get: (id: string, create: () => C) => C;
  /** Marks the Conversation on screen, and lets go of finished Chats that are not. */
  show: (id: string) => void;
  /** Stops the Conversation's Chat and forgets it without saving, for a deleted Conversation. */
  remove: (id: string) => void;
  /** Saves every running or unsaved Chat now, for a page that is going away. */
  flush: () => void;
  has: (id: string) => boolean;
  /** Conversations whose Answer is still running: the same array until that changes. */
  running: () => readonly string[];
  subscribe: (listener: () => void) => () => void;
};

// While an Answer streams, its Conversation is saved at most this often.
export const SAVE_EVERY_MS = 1000;

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const isRunning = (status: ChatStatus) => status === "submitted" || status === "streaming";

type Entry<C> = {
  chat: C;
  running: boolean;
  lastSave: number;
  timer?: unknown;
  // Failed off screen: kept until its Conversation opens, so the error shows there.
  unseenError: boolean;
  unsubscribe: () => void;
};

export function createChatRegistry<M, C extends RegistryChat<M> = RegistryChat<M>>({
  save,
  saveEveryMs = SAVE_EVERY_MS,
  clock = systemClock,
}: {
  save: (id: string, messages: M[]) => void;
  saveEveryMs?: number;
  clock?: Clock;
}): ChatRegistry<C> {
  const entries = new Map<string, Entry<C>>();
  const listeners = new Set<() => void>();
  let onScreen: string | undefined;
  let running: readonly string[] = [];

  const updateRunning = () => {
    const next = [...entries].filter(([, entry]) => entry.running).map(([id]) => id);
    if (next.length === running.length && next.every((id, i) => id === running[i])) return;
    running = next;
    listeners.forEach((listener) => listener());
  };
  const cancelSave = (entry: Entry<C>) => {
    if (entry.timer !== undefined) clock.clearTimeout(entry.timer);
    entry.timer = undefined;
  };
  const saveNow = (id: string, entry: Entry<C>) => {
    cancelSave(entry);
    entry.lastSave = clock.now();
    save(id, entry.chat.messages);
  };
  const forget = (id: string, entry: Entry<C>) => {
    entry.unsubscribe();
    cancelSave(entry);
    entries.delete(id);
  };
  // The first change after a quiet second saves at once; later ones wait for the second to end.
  const changed = (id: string, entry: Entry<C>) => {
    if (entry.timer !== undefined) return;
    const wait = entry.lastSave + saveEveryMs - clock.now();
    if (wait <= 0) saveNow(id, entry);
    else entry.timer = clock.setTimeout(() => saveNow(id, entry), wait);
  };
  const statusChanged = (id: string, entry: Entry<C>) => {
    const wasRunning = entry.running;
    entry.running = isRunning(entry.chat.status);
    if (wasRunning && !entry.running) {
      saveNow(id, entry);
      if (id !== onScreen) {
        if (entry.chat.status === "error") entry.unseenError = true;
        else forget(id, entry);
      }
    }
    updateRunning();
  };

  return {
    get(id, create) {
      const existing = entries.get(id);
      if (existing) return existing.chat;
      const chat = create();
      const entry: Entry<C> = {
        chat,
        running: isRunning(chat.status),
        lastSave: -Infinity,
        unseenError: false,
        unsubscribe: () => {},
      };
      const offMessages = chat["~registerMessagesCallback"](() => changed(id, entry));
      const offStatus = chat["~registerStatusCallback"](() => statusChanged(id, entry));
      entry.unsubscribe = () => {
        offMessages();
        offStatus();
      };
      entries.set(id, entry);
      updateRunning();
      return chat;
    },
    show(id) {
      onScreen = id;
      for (const [other, entry] of entries) {
        if (other === id) entry.unseenError = false;
        else if (!entry.running && !entry.unseenError) forget(other, entry);
      }
    },
    remove(id) {
      const entry = entries.get(id);
      if (!entry) return;
      forget(id, entry);
      void entry.chat.stop();
      updateRunning();
    },
    flush() {
      for (const [id, entry] of entries)
        if (entry.running || entry.timer !== undefined) saveNow(id, entry);
    },
    has: (id) => entries.has(id),
    running: () => running,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
