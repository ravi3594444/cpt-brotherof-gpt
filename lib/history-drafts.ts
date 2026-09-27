// An Answer that is still running is saved about once a second. Writing the whole
// history that often is slow on a phone, so those saves go to a small record of
// drafts, one per Conversation still answering. The history itself is written when
// an Answer starts or ends, and a draft newer than its Conversation there wins on load.

export type Draft<M> = { updatedAt: number; messages: M[] };
export type Drafts<M> = Record<string, Draft<M>>;
type Saved<M> = { id: string; updatedAt: number; messages: M[] };

/** The history with each draft that is newer than its Conversation put in its place. */
export function applyDrafts<M, T extends Saved<M>>(threads: T[], drafts: Drafts<M>): T[] {
  return threads.map((t) => {
    const draft = drafts[t.id];
    return draft && draft.updatedAt > t.updatedAt ? { ...t, messages: draft.messages, updatedAt: draft.updatedAt } : t;
  });
}

/** The drafts still needed once `threads` is saved: those newer than their Conversation in it. */
export function pendingDrafts<M>(threads: Saved<M>[], drafts: Drafts<M>): Drafts<M> {
  const saved = new Map(threads.map((t) => [t.id, t.updatedAt]));
  return Object.fromEntries(Object.entries(drafts).filter(([id, draft]) => draft.updatedAt > (saved.get(id) ?? Infinity)));
}

/** Drafts read back from storage, without anything malformed. */
export function readDrafts<M>(raw: string | null): Drafts<M> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, draft]) => typeof draft?.updatedAt === "number" && Array.isArray(draft?.messages),
      ),
    );
  } catch {
    return {};
  }
}
