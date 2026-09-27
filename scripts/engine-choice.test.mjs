import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseResearchEngine, jevService } from "../lib/cloud-research.ts";

const signal = new AbortController().signal;
const allKeys = { browserUseKey: "b", kernelKey: "k", jev: jevService({ aimlapiKey: "j" }) };
const noJevCall = async () => assert.fail("JEV should not be called");
const jevAnswers = (choice, confidence) => async () =>
  Response.json({ answers: { route: { choice, confidence } } });

async function choose(requested, keys, fetcher = noJevCall) {
  const steps = [];
  const engine = await chooseResearchEngine(requested, keys, "a question", signal, fetcher, (s) => steps.push(s));
  return { engine, steps };
}

test("an explicit engine choice wins without asking JEV", async () => {
  assert.deepEqual(await choose("kernel", allKeys), { engine: "kernel", steps: ["Selected Kernel"] });
  assert.deepEqual(await choose("tavily", allKeys), { engine: "tavily", steps: ["Selected Search API"] });
});

test("Auto uses the only connected browser, or the Search API with none", async () => {
  assert.deepEqual(
    await choose("auto", { ...allKeys, browserUseKey: "", jev: undefined }),
    { engine: "kernel", steps: ["Selected Kernel"] },
  );
  assert.deepEqual(
    await choose("auto", { ...allKeys, kernelKey: "" }),
    { engine: "browser_use", steps: ["Selected Browser Use Cloud"] },
  );
  assert.deepEqual(
    await choose("auto", { browserUseKey: "", kernelKey: "", jev: jevService({ aimlapiKey: "j" }) }),
    { engine: "tavily", steps: ["Selected Search API"] },
  );
});

test("Auto with both browsers and no JEV key uses Browser Use Cloud", async () => {
  assert.deepEqual(
    await choose("auto", { ...allKeys, jev: undefined }),
    { engine: "browser_use", steps: ["Selected Browser Use Cloud"] },
  );
});

test("a confident JEV answer is logged as JEV's choice", async () => {
  assert.deepEqual(
    await choose("auto", allKeys, jevAnswers("kernel", 0.88)),
    { engine: "kernel", steps: ["JEV selected Kernel"] },
  );
  assert.deepEqual(
    await choose("auto", allKeys, jevAnswers("browser_use", 0.3)),
    { engine: "browser_use", steps: ["JEV selected Browser Use Cloud"] },
  );
});

test("a low-confidence Kernel answer is logged as a fallback, not as JEV's choice", async () => {
  const { engine, steps } = await choose("auto", allKeys, jevAnswers("kernel", 0.4));
  assert.equal(engine, "browser_use");
  assert.deepEqual(steps, ["JEV was unsure; using Browser Use Cloud"]);
});

test("a JEV failure is logged as a fallback, not as JEV's choice", async () => {
  for (const fetcher of [
    async () => new Response("overloaded", { status: 529 }),
    async () => { throw new TypeError("network down"); },
  ]) {
    const { engine, steps } = await choose("auto", allKeys, fetcher);
    assert.equal(engine, "browser_use");
    assert.deepEqual(steps, ["JEV was unavailable; using Browser Use Cloud"]);
  }
});
