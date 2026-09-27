import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDrafts, pendingDrafts, readDrafts } from "../lib/history-drafts.ts";

const thread = (id, updatedAt, text) => ({ id, title: id, updatedAt, messages: [{ role: "user", text }] });
const draft = (updatedAt, text) => ({ updatedAt, messages: [{ role: "user", text }, { role: "assistant", text: `${text}, half answered` }] });

test("a draft newer than its saved conversation takes its place when the history loads", () => {
  const saved = [thread("a", 100, "A?"), thread("b", 100, "B?")];
  const loaded = applyDrafts(saved, { a: draft(150, "A?") });
  assert.deepEqual(loaded.map((t) => [t.id, t.updatedAt, t.messages.at(-1).text]), [
    ["a", 150, "A?, half answered"],
    ["b", 100, "B?"],
  ]);
  assert.equal(loaded[0].title, "a", "the rest of the conversation is kept");
  assert.equal(loaded[1], saved[1]);
});

test("a draft older than its saved conversation, or of a conversation no longer saved, is ignored", () => {
  const saved = [thread("a", 200, "A, finished")];
  assert.deepEqual(applyDrafts(saved, { a: draft(150, "A?"), gone: draft(300, "Deleted?") }), saved);
});

test("once the history is saved, only drafts still newer than it are kept", () => {
  const drafts = { a: draft(150, "A?"), b: draft(150, "B?"), gone: draft(150, "Deleted?") };
  const saved = [thread("a", 100, "A?"), thread("b", 150, "B, finished")];
  assert.deepEqual(Object.keys(pendingDrafts(saved, drafts)), ["a"]);
  assert.deepEqual(pendingDrafts(applyDrafts(saved, drafts), drafts), {}, "drafts put in place are done with");
});

test("drafts read back from storage drop anything malformed", () => {
  assert.deepEqual(readDrafts(null), {});
  assert.deepEqual(readDrafts("not json"), {});
  assert.deepEqual(readDrafts("[1, 2]"), {});
  assert.deepEqual(
    readDrafts(JSON.stringify({ a: draft(150, "A?"), b: { updatedAt: "soon", messages: [] }, c: { updatedAt: 1 }, d: null })),
    { a: draft(150, "A?") },
  );
});
