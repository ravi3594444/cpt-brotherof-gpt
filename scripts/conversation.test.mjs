import assert from "node:assert/strict";
import { test } from "node:test";
import { modelConversation } from "../lib/conversation.ts";

const user = (text) => ({ role: "user", parts: [{ type: "text", text }] });
const assistant = (text) => ({ role: "assistant", parts: [{ type: "step-start" }, { type: "text", text }] });

test("the question is the latest user turn's text", () => {
  const { question, messages } = modelConversation([user("First?"), assistant("Answer."), user("  Follow-up?  ")]);
  assert.equal(question, "Follow-up?");
  assert.deepEqual(messages, [
    { role: "user", content: "First?" },
    { role: "assistant", content: "Answer." },
    { role: "user", content: "  Follow-up?  " },
  ]);
});

test("skips turns with no text, such as an answer that failed before writing", () => {
  const failed = { role: "assistant", parts: [{ type: "data-research" }, { type: "source-url" }] };
  const { messages } = modelConversation([user("Why?"), failed, user("Why?")]);
  assert.deepEqual(messages, [
    { role: "user", content: "Why?" },
    { role: "user", content: "Why?" },
  ]);
});

test("there is no question when the conversation ends with an answer", () => {
  assert.equal(modelConversation([user("Q"), assistant("A")]).question, "");
  assert.equal(modelConversation([user("   ")]).question, "");
});

test("keeps the latest 16 turns, each at most 16000 characters", () => {
  const long = "x".repeat(20000);
  const turns = Array.from({ length: 20 }, (_, i) => (i % 2 ? assistant(`a${i}`) : user(`q${i}`)));
  turns.push(user(long));
  const { messages } = modelConversation(turns);
  assert.equal(messages.length, 16);
  assert.equal(messages[0].content, "a5");
  assert.equal(messages.at(-1).content.length, 16000);
});
