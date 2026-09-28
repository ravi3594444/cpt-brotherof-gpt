import assert from "node:assert/strict";
import { test } from "node:test";
import { modelConversation } from "../lib/conversation.ts";
import { jobInput, jobMessages, jobTiming, researchServices } from "../lib/research-job.ts";
import { serverConfig } from "../lib/server-config.ts";
import { newAnswerState } from "../lib/answer.ts";

const photo = `data:image/png;base64,${"iVBORw0KGgo".repeat(20)}`;

test("a Research job's conversation is text: photos become a note and never travel as data", () => {
  const { messages } = modelConversation([
    { role: "user", parts: [{ type: "text", text: "What fern is this?" }, { type: "file", mediaType: "image/png", url: photo }] },
    { role: "assistant", parts: [{ type: "text", text: "A maidenhair fern." }] },
    { role: "user", parts: [{ type: "text", text: "Research where to buy one" }] },
  ]);
  assert.ok(JSON.stringify(messages).includes("iVBORw0KGgo"), "the request itself had the photo");
  const text = jobMessages(messages);
  assert.deepEqual(text, [
    { role: "user", content: "What fern is this?\n\n[The user attached a photo to this message.]" },
    { role: "assistant", content: "A maidenhair fern." },
    { role: "user", content: "Research where to buy one" },
  ]);
  const input = jobInput({
    chatId: "chat-1",
    messageId: "message-1",
    engine: "auto",
    messages,
    handoff: { mode: "tool", task: "where to buy a maidenhair fern", calls: [{ toolCallId: "c", task: "where to buy a maidenhair fern" }], responseMessages: [], state: newAnswerState() },
    prefix: [
      { type: "reasoning-start", id: "thinking-1" },
      { type: "reasoning-delta", id: "thinking-1", delta: "a " },
      { type: "reasoning-delta", id: "thinking-1", delta: "fern" },
      { type: "reasoning-end", id: "thinking-1" },
    ],
    photos: 1,
    photosToModel: 1,
    modelName: "Atria",
    startedAt: 0,
  });
  const json = JSON.stringify(input);
  assert.ok(!/data:image|base64|iVBORw0KGgo/.test(json), json.slice(0, 400));
  assert.equal(input.prefix.length, 3, "the start of the answer is compacted");
  assert.deepEqual(structuredClone(input), input, "plain data a workflow can carry");
});

test("test mode researches with the fake Browser Use Cloud only, and quick windows", () => {
  const live = serverConfig({ BROWSER_USE_API_KEY: "bu", KERNEL_API_KEY: "k", MODEL_DISPLAY_NAME: "Atria", RESEARCH_MAX_COST_USD: "3" });
  const services = researchServices(live);
  assert.equal(services.keys.browserUseKey, "bu");
  assert.equal(services.fetcher, fetch);
  assert.equal(services.maxCostUsd, 3);
  assert.equal(services.modelName, "Atria");
  assert.equal(jobTiming(live).pollWindowMs, 240_000);
  assert.equal(jobTiming(live).streamWindowMs, 280_000);

  const test = serverConfig({ SCOUT_TEST_MODE: "1", BROWSER_USE_API_KEY: "real", KERNEL_API_KEY: "real" });
  const fake = researchServices(test);
  assert.deepEqual(fake.keys, { searchKey: "", browserUseKey: "test", kernelKey: "" }, "test mode never uses real keys");
  assert.notEqual(fake.fetcher, fetch);
  assert.ok(jobTiming(test).pollWindowMs < 10_000 && jobTiming(test).streamWindowMs < 10_000);
});

test("the fake Browser Use Cloud completes a run after its research time, unless it is cancelled", async () => {
  const fetcher = researchServices(serverConfig({ SCOUT_TEST_MODE: "1", SCOUT_TEST_RESEARCH_MS: "60" })).fetcher;
  const api = "https://api.browser-use.com/api/v4";
  const created = await (await fetcher(`${api}/runs`, { method: "POST", body: "{}" })).json();
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal((await (await fetcher(`${api}/runs/${created.id}/status`)).json()).status, "running");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal((await (await fetcher(`${api}/runs/${created.id}/status`)).json()).status, "completed");
  const run = await (await fetcher(`${api}/runs/${created.id}`)).json();
  assert.equal(run.output.sources.length, 2);
  const other = await (await fetcher(`${api}/runs`, { method: "POST", body: "{}" })).json();
  await fetcher(`${api}/runs/${other.id}/cancel`, { method: "POST" });
  assert.equal((await (await fetcher(`${api}/runs/${other.id}/status`)).json()).status, "cancelled");
  await assert.rejects(fetcher("https://api.onkernel.com/browsers", { method: "POST" }), /no other service/);
});
