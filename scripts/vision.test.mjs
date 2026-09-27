import assert from "node:assert/strict";
import { test } from "node:test";
import { describePhotos, visionService } from "../lib/vision.ts";
import { ResearchError } from "../lib/research.ts";

const signal = new AbortController().signal;
const service = { baseURL: "https://api.aimlapi.com/v1", apiKey: "aiml-key", model: "deepseek/deepseek-v4.1-flash" };
const answering = (content, calls = []) => async (url, init) => {
  calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
  return Response.json({ choices: [{ message: { role: "assistant", content } }] });
};

test("the vision helper is off until a vision model is set, and defaults to AI/ML API", () => {
  assert.equal(visionService({ aimlapiKey: "k" }), undefined);
  assert.equal(visionService({ model: "m" }), undefined);
  assert.deepEqual(visionService({ model: "deepseek/deepseek-v4.1-flash", aimlapiKey: "k" }), {
    baseURL: "https://api.aimlapi.com/v1",
    apiKey: "k",
    model: "deepseek/deepseek-v4.1-flash",
  });
  assert.deepEqual(visionService({ model: "m", baseURL: "https://vision.example.com/v1/", apiKey: "own", aimlapiKey: "k" }), {
    baseURL: "https://vision.example.com/v1",
    apiKey: "own",
    model: "m",
  });
});

test("photos are described by the vision model, with the question for context", async () => {
  const calls = [];
  const text = await describePhotos(service, "What plant is this?", [
    { image: "QUJD", mediaType: "image/jpeg" },
    { image: "REVG", mediaType: "image/png" },
  ], signal, answering("  A potted fern with long fronds.  ", calls));
  assert.equal(text, "A potted fern with long fronds.");
  const [call] = calls;
  assert.equal(call.url, "https://api.aimlapi.com/v1/chat/completions");
  assert.equal(call.auth, "Bearer aiml-key");
  assert.equal(call.body.model, "deepseek/deepseek-v4.1-flash");
  const content = call.body.messages.at(-1).content;
  assert.match(content[0].text, /What plant is this\?/);
  assert.deepEqual(content.slice(1), [
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
    { type: "image_url", image_url: { url: "data:image/png;base64,REVG" } },
  ]);
});

test("a vision model failure or empty reply is a plain error, not a crash", async () => {
  const rejected = async () => new Response("bad key", { status: 401 });
  await assert.rejects(() => describePhotos(service, "Q", [{ image: "QUJD", mediaType: "image/jpeg" }], signal, rejected),
    (e) => e instanceof ResearchError && /vision model/i.test(e.message) && !/bad key/.test(e.message));
  await assert.rejects(() => describePhotos(service, "Q", [{ image: "QUJD", mediaType: "image/jpeg" }], signal, answering("")),
    (e) => e instanceof ResearchError);
  await assert.rejects(() => describePhotos({ ...service, baseURL: "http://insecure.example.com/v1" }, "Q", [], signal, answering("x")),
    (e) => e instanceof ResearchError && /HTTPS/.test(e.message));
});
