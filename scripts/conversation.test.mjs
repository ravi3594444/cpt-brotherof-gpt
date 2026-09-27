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

// ---- Photos ----
import { PhotoError, requestTurns, answerErrorMessage } from "../lib/conversation.ts";
const jpeg = (tag = "AAAA") => `data:image/jpeg;base64,${tag}`;
const photo = (url = jpeg(), mediaType = "image/jpeg") => ({ type: "file", mediaType, url, filename: "p.jpg" });
const withPhotos = (text, ...photos) => ({ role: "user", parts: [...photos, { type: "text", text }] });

test("the latest question's photos go to the model as images after its text", () => {
  const { messages, question, photos } = modelConversation([withPhotos("What is this?", photo(jpeg("QUJD")), photo("data:image/png;base64,REVG", "image/png"))]);
  assert.equal(question, "What is this?");
  assert.equal(photos, 2);
  assert.deepEqual(messages, [{
    role: "user",
    content: [
      { type: "text", text: "What is this?" },
      { type: "image", image: "QUJD", mediaType: "image/jpeg" },
      { type: "image", image: "REVG", mediaType: "image/png" },
    ],
  }]);
});

test("only the latest question with photos sends them, so follow-ups keep one set", () => {
  const { messages, photos } = modelConversation([
    withPhotos("Old photo?", photo(jpeg("T0xE"))),
    assistant("An old answer."),
    withPhotos("New photo?", photo(jpeg("TkVX"))),
    assistant("A new answer."),
    user("And its colour?"),
  ]);
  assert.equal(photos, 1);
  assert.deepEqual(messages[0], { role: "user", content: "Old photo?" });
  assert.deepEqual(messages[2].content.at(-1), { type: "image", image: "TkVX", mediaType: "image/jpeg" });
  assert.deepEqual(messages[4], { role: "user", content: "And its colour?" });
});

test("rejects photos that are not JPEG, PNG or WebP data, too many, or too big", () => {
  const bad = [
    [photo("data:image/gif;base64,R0lG", "image/gif")],
    [photo("https://example.com/p.jpg")],
    [photo("data:image/jpeg;base64,not base64!")],
    Array.from({ length: 5 }, () => photo()),
    [photo(jpeg("A".repeat(2_000_004)))],
  ];
  for (const photos of bad)
    assert.throws(() => modelConversation([withPhotos("Q?", ...photos)]), PhotoError);
});

test("requests carry text for every turn and photos only for the latest photo question", () => {
  const turns = requestTurns([
    { id: "1", role: "user", parts: [photo(jpeg("T0xE")), { type: "text", text: "Old" }] },
    { id: "2", role: "assistant", parts: [{ type: "data-research", data: {} }, { type: "text", text: "A" }] },
    { id: "3", role: "user", parts: [photo(jpeg("TkVX")), { type: "text", text: "New" }] },
  ]);
  assert.deepEqual(turns.map((t) => t.parts.map((p) => p.type)), [["text"], ["text"], ["file", "text"]]);
  assert.equal(turns[2].parts[0].url, jpeg("TkVX"));
});

test("a failed answer with photos says the model may not read photos", () => {
  assert.match(answerErrorMessage({ photos: 2, aborted: false }), /may not be able to read photos/);
  assert.doesNotMatch(answerErrorMessage({ photos: 0, aborted: false }), /photo/);
  assert.match(answerErrorMessage({ photos: 1, aborted: true }), /stopped or timed out/);
});

// ---- Photos described by the vision helper ----
import { withPhotoDescription } from "../lib/conversation.ts";

test("the conversation hands back the photos it will send, for the vision helper", () => {
  const { images } = modelConversation([withPhotos("What is this?", photo(jpeg("QUJD")))]);
  assert.deepEqual(images, [{ image: "QUJD", mediaType: "image/jpeg" }]);
});

test("a text-only answer model gets the helper's description instead of the photos", () => {
  const { messages } = modelConversation([user("Hi"), assistant("Hello."), withPhotos("What plant is this?", photo(jpeg("QUJD")))]);
  const described = withPhotoDescription(messages, "A potted fern.");
  assert.deepEqual(described.slice(0, 2), messages.slice(0, 2));
  assert.equal(typeof described[2].content, "string");
  assert.match(described[2].content, /^What plant is this\?/);
  assert.match(described[2].content, /A potted fern\./);
  assert.match(described[2].content, /cannot see/i);
  assert.equal(JSON.stringify(described).includes("QUJD"), false);
});
