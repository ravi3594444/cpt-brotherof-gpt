import assert from "node:assert/strict";
import { test } from "node:test";
import { SAVE_EVERY_MS, createChatRegistry } from "../lib/chat-registry.ts";

// Reports changes the way @ai-sdk/react's Chat does.
function fakeChat(messages = []) {
  const on = { messages: new Set(), status: new Set() };
  const register = (set) => (callback) => {
    set.add(callback);
    return () => set.delete(callback);
  };
  const chat = {
    status: "ready",
    messages,
    stops: 0,
    stop() {
      chat.stops++;
      return Promise.resolve();
    },
    "~registerMessagesCallback": register(on.messages),
    "~registerStatusCallback": register(on.status),
    listening: () => on.messages.size + on.status.size,
    push(message) {
      chat.messages = [...chat.messages, message];
      on.messages.forEach((callback) => callback());
    },
    // One more streamed chunk of the answer being written.
    write(text) {
      const last = chat.messages.at(-1);
      chat.messages = last?.role === "assistant"
        ? [...chat.messages.slice(0, -1), { ...last, text: last.text + text }]
        : [...chat.messages, { role: "assistant", text }];
      on.messages.forEach((callback) => callback());
    },
    setStatus(status) {
      chat.status = status;
      on.status.forEach((callback) => callback());
    },
  };
  return chat;
}
const ask = (chat, text = "Why?") => {
  chat.push({ role: "user", text });
  chat.setStatus("submitted");
};

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (run, ms) => {
      timers.set(nextId, { at: now + ms, run });
      return nextId++;
    },
    clearTimeout: (id) => timers.delete(id),
    pending: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] || [];
        if (!timer || timer.at > end) break;
        timers.delete(id);
        now = timer.at;
        timer.run();
      }
      now = end;
    },
  };
}

function setup() {
  const clock = fakeClock();
  const saves = [];
  const chats = createChatRegistry({
    save: (id, messages, { started, running }) => saves.push({ id, messages, started, running, at: clock.now() }),
    clock,
  });
  const created = {};
  const open = (id, messages) => {
    const chat = chats.get(id, () => (created[id] = fakeChat(messages)));
    chats.show(id);
    return chat;
  };
  return { clock, saves, chats, created, open };
}

test("each conversation gets one Chat, created once and reused", () => {
  const { chats } = setup();
  let made = 0;
  const create = () => (made++, fakeChat());
  const a = chats.get("a", create);
  assert.equal(chats.get("a", create), a);
  const b = chats.get("b", create);
  assert.notEqual(b, a);
  assert.equal(made, 2);
  assert.ok(chats.has("a") && chats.has("b"));
});

test("opening a conversation does not save it", () => {
  const { saves, open } = setup();
  open("a", [{ role: "user", text: "Old?" }, { role: "assistant", text: "Old." }]);
  assert.equal(saves.length, 0);
});

test("a new question is saved at once, and a streaming answer at most once a second", () => {
  const { clock, saves, open } = setup();
  const chat = open("a");
  ask(chat);
  assert.deepEqual([saves.at(-1).at, saves.at(-1).messages.length], [0, 1]);
  saves.length = 0;
  chat.setStatus("streaming");
  for (let t = 0; t < 9; t++) {
    clock.advance(100);
    chat.write(`${t}`);
  }
  assert.equal(saves.length, 0, "no save inside the first second");
  clock.advance(100);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].at, SAVE_EVERY_MS);
  assert.equal(saves[0].messages.at(-1).text, "012345678", "the latest words, not the first chunk");
  clock.advance(300);
  chat.write("9");
  clock.advance(699);
  assert.equal(saves.length, 1);
  clock.advance(1);
  assert.deepEqual([saves[1].at, saves[1].messages.at(-1).text], [2 * SAVE_EVERY_MS, "0123456789"]);
  clock.advance(5000);
  assert.equal(saves.length, 2, "nothing new, nothing saved");
});

test("starting an answer saves its conversation at once as started; saving more of it does not", () => {
  const { clock, saves, open } = setup();
  const chat = open("a", [{ role: "user", text: "Old?" }, { role: "assistant", text: "Old." }]);
  ask(chat, "New?");
  assert.deepEqual([saves.at(-1).started, saves.at(-1).messages.at(-1).text], [true, "New?"]);
  assert.equal(saves.filter((s) => s.started).length, 1);
  chat.setStatus("streaming");
  chat.write("Part");
  clock.advance(SAVE_EVERY_MS);
  chat.write(" two");
  clock.advance(SAVE_EVERY_MS);
  chat.setStatus("error");
  assert.ok(saves.length > 2);
  assert.equal(saves.filter((s) => s.started).length, 1, "only the start is marked");

  // Try again after a failure starts a new answer to the same question.
  clock.advance(100);
  chat.setStatus("submitted");
  assert.deepEqual([saves.at(-1).started, saves.at(-1).at], [true, clock.now()], "saved at once, not held by the throttle");
  assert.equal(clock.pending(), 0);
});

test("the final state is saved the moment an answer finishes, with no stale save after it", () => {
  const { clock, saves, open } = setup();
  const chat = open("a");
  ask(chat);
  saves.length = 0;
  chat.setStatus("streaming");
  clock.advance(200);
  chat.write("Almost");
  clock.advance(100);
  chat.write(" done.");
  chat.setStatus("ready");
  assert.equal(saves.length, 1);
  assert.deepEqual([saves[0].at, saves[0].messages.at(-1).text], [300, "Almost done."]);
  assert.equal(clock.pending(), 0, "the throttled save was dropped");
  clock.advance(5000);
  assert.equal(saves.length, 1);
});

test("an answer that fails is saved as it stands", () => {
  const { saves, open } = setup();
  const chat = open("a");
  ask(chat);
  chat.setStatus("streaming");
  chat.write("Part of it");
  chat.setStatus("error");
  assert.equal(saves.at(-1).messages.at(-1).text, "Part of it");
});

test("clearing an error is not the end of an answer and saves nothing", () => {
  const { saves, open } = setup();
  const chat = open("a");
  ask(chat);
  chat.setStatus("error");
  const count = saves.length;
  chat.setStatus("ready");
  assert.equal(saves.length, count);
});

test("switching conversations keeps a running Chat and never stops it", () => {
  const { chats, open } = setup();
  const a = open("a");
  ask(a);
  open("b");
  assert.ok(chats.has("a"));
  assert.equal(a.stops, 0);
  assert.equal(chats.get("a", () => fakeChat()), a, "coming back re-attaches the same Chat");
});

test("an answer that finishes off screen is saved, then its Chat is let go", () => {
  const { chats, saves, created, open } = setup();
  const a = open("a");
  ask(a);
  a.setStatus("streaming");
  open("b");
  a.write("The whole answer.");
  a.setStatus("ready");
  assert.equal(saves.at(-1).id, "a");
  assert.equal(saves.at(-1).messages.at(-1).text, "The whole answer.");
  assert.ok(!chats.has("a"));
  assert.equal(a.listening(), 0, "the old Chat saves nothing more");
  const again = open("a", saves.at(-1).messages);
  assert.notEqual(again, a);
  assert.equal(created.a.messages.at(-1).text, "The whole answer.");
});

test("a finished Chat is kept while on screen and let go once another conversation opens", () => {
  const { chats, open } = setup();
  const a = open("a");
  ask(a);
  a.setStatus("ready");
  assert.ok(chats.has("a"));
  open("b");
  assert.ok(!chats.has("a"));
  assert.equal(a.stops, 0);
});

test("an answer that fails off screen keeps its Chat until the conversation has been opened", () => {
  const { chats, open } = setup();
  const a = open("a");
  ask(a);
  open("b");
  a.setStatus("error");
  assert.ok(chats.has("a"), "so the error shows when the conversation opens");
  open("c");
  assert.ok(chats.has("a"));
  open("a");
  open("b");
  assert.ok(!chats.has("a"));
});

test("running lists the conversations whose answer is still running and tells subscribers", () => {
  const { chats, open } = setup();
  let told = 0;
  chats.subscribe(() => told++);
  assert.deepEqual(chats.running(), []);
  const a = open("a");
  ask(a);
  assert.deepEqual(chats.running(), ["a"]);
  const b = open("b");
  ask(b);
  b.setStatus("streaming");
  const both = chats.running();
  assert.deepEqual(both, ["a", "b"]);
  assert.equal(chats.running(), both, "the same array until something changes");
  assert.equal(told, 2);
  a.setStatus("ready");
  assert.deepEqual(chats.running(), ["b"]);
  assert.equal(told, 3);
});

test("unsubscribing stops the updates", () => {
  const { chats, open } = setup();
  let told = 0;
  const off = chats.subscribe(() => told++);
  off();
  ask(open("a"));
  assert.equal(told, 0);
});

test("deleting a conversation stops its Chat and forgets it without saving again", () => {
  const { clock, chats, saves, open } = setup();
  const a = open("a");
  ask(a);
  a.setStatus("streaming");
  a.write("Half");
  const count = saves.length;
  let told = 0;
  chats.subscribe(() => told++);
  chats.remove("a");
  assert.equal(a.stops, 1);
  assert.ok(!chats.has("a"));
  assert.deepEqual(chats.running(), []);
  assert.equal(told, 1);
  a.setStatus("ready"); // the stopped request ends
  clock.advance(5000);
  assert.equal(saves.length, count, "a deleted conversation does not come back");
  chats.remove("missing");
});

test("flush saves every running or unsaved Chat now, for a page that is going away", () => {
  const { clock, chats, saves, open } = setup();
  const a = open("a");
  ask(a);
  a.setStatus("streaming");
  clock.advance(100);
  a.write("Latest words");
  const b = open("b");
  ask(b);
  open("c");
  const before = saves.length;
  chats.flush();
  const flushed = saves.slice(before);
  assert.deepEqual(flushed.map((s) => s.id).sort(), ["a", "b"], "the idle, empty conversation is not saved");
  assert.equal(flushed.find((s) => s.id === "a").messages.at(-1).text, "Latest words");
  assert.equal(clock.pending(), 0);
  clock.advance(5000);
  assert.equal(saves.length, before + 2);
});

test("each save says whether the answer is still running", () => {
  const { clock, saves, chats, open } = setup();
  const chat = open("a");
  const last = () => [saves.at(-1).started, saves.at(-1).running];
  ask(chat);
  assert.deepEqual(last(), [true, true]);
  chat.setStatus("streaming");
  clock.advance(SAVE_EVERY_MS);
  chat.write("Part");
  assert.deepEqual(last(), [false, true]);
  chat.write(" two");
  chats.flush();
  assert.deepEqual(last(), [false, true], "a page going away saves a running answer as running");
  chat.setStatus("ready");
  assert.deepEqual(last(), [false, false]);
  assert.equal(saves.at(-1).messages.at(-1).text, "Part two");
});

test("stopAll stops every running answer, and each is saved as it stands", () => {
  const { chats, saves, open } = setup();
  const a = open("a");
  ask(a);
  a.setStatus("streaming");
  a.write("Half an answer");
  const b = open("b");
  ask(b);
  const c = open("c");
  ask(c);
  c.setStatus("ready");
  chats.stopAll();
  assert.deepEqual([a.stops, b.stops, c.stops], [1, 1, 0], "a finished answer is left alone");
  a.setStatus("ready"); // the stopped requests end
  b.setStatus("ready");
  assert.equal(saves.findLast((s) => s.id === "a").messages.at(-1).text, "Half an answer");
  assert.ok(saves.some((s) => s.id === "b"));
  assert.deepEqual(chats.running(), []);
});
