import assert from "node:assert/strict";
import { test } from "node:test";
import { jevChooseEngine, jevService } from "../lib/cloud-research.ts";

const signal = new AbortController().signal;
async function askJev(service) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return Response.json({ answers: { route: { type: "choice", choice: "kernel", confidence: 0.9 } } });
  };
  const engine = await jevChooseEngine("Read https://example.com/a", service, signal, fetcher);
  return { engine, call: calls[0] };
}

test("JEV through AI/ML API asks its decisions endpoint with the typesafe/jev model", async () => {
  const { engine, call } = await askJev(jevService({ aimlapiKey: "aiml-key" }));
  assert.equal(engine, "kernel");
  assert.equal(call.url, "https://api.aimlapi.com/v1/decisions");
  assert.equal(call.auth, "Bearer aiml-key");
  assert.equal(call.body.model, "typesafe/jev");
  assert.equal(call.body.questions.route.type, "choice");
  assert.deepEqual(Object.keys(call.body.questions.route.criteria).sort(), ["browser_use", "kernel"]);
});

test("JEV straight from TypeSafe keeps its own endpoint and model", async () => {
  const { call } = await askJev(jevService({ typesafeKey: "ts-key" }));
  assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(call.auth, "Bearer ts-key");
  assert.equal(call.body.model, "jev-latest");
});

test("AI/ML API is used when both keys are set, and there is no JEV without a key", () => {
  assert.equal(jevService({ aimlapiKey: "a", typesafeKey: "t" }).url, "https://api.aimlapi.com/v1/decisions");
  assert.equal(jevService({}), undefined);
  assert.equal(jevService({ aimlapiKey: "", typesafeKey: "" }), undefined);
});
