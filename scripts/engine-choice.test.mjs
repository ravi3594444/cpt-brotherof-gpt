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

test("Auto with both browsers and no JEV key uses Kernel", async () => {
  assert.deepEqual(
    await choose("auto", { ...allKeys, jev: undefined }),
    { engine: "kernel", steps: ["Selected Kernel"] },
  );
});

test("a confident JEV answer is logged as JEV's choice", async () => {
  assert.deepEqual(
    await choose("auto", allKeys, jevAnswers("kernel", 0.88)),
    { engine: "kernel", steps: ["JEV selected Kernel"] },
  );
  assert.deepEqual(
    await choose("auto", allKeys, jevAnswers("browser_use", 0.9)),
    { engine: "browser_use", steps: ["JEV selected Browser Use Cloud"] },
  );
});

test("JEV is told Kernel is the default and Browser Use is only for tasks that need it", async () => {
  let route;
  const jevSeeing = async (_url, init) => {
    route = JSON.parse(init.body).questions.route;
    return Response.json({ answers: { route: { choice: "vision_agent", confidence: 0.8 } } });
  };
  await choose("auto", { ...allKeys, visionAgent: true }, jevSeeing);
  assert.match(route.instructions, /Kernel/);
  assert.match(route.criteria.vision_agent, /most research/i);
  assert.match(route.criteria.browser_use, /only when/i);
});

test("Browser Use Cloud is used only when JEV is sure the task needs it", async () => {
  assert.deepEqual(await choose("auto", allKeys, jevAnswers("browser_use", 0.3)),
    { engine: "kernel", steps: ["JEV was unsure; using Kernel"] });
  assert.deepEqual(await choose("auto", { ...allKeys, visionAgent: true }, jevAnswers("browser_use", 0.5)),
    { engine: "vision_agent", steps: ["JEV was unsure; using Vision agent"] });
});

test("a low-confidence Kernel answer browses with the vision agent instead", async () => {
  const { engine, steps } = await choose("auto", { ...allKeys, visionAgent: true }, jevAnswers("kernel", 0.4));
  assert.equal(engine, "vision_agent");
  assert.deepEqual(steps, ["JEV was unsure; using Vision agent"]);
  // Without the vision agent, Kernel stays Kernel.
  assert.deepEqual(await choose("auto", allKeys, jevAnswers("kernel", 0.4)), { engine: "kernel", steps: ["JEV selected Kernel"] });
});

test("a JEV failure is logged as a fallback, not as JEV's choice", async () => {
  for (const fetcher of [
    async () => new Response("overloaded", { status: 529 }),
    async () => { throw new TypeError("network down"); },
  ]) {
    const { engine, steps } = await choose("auto", { ...allKeys, visionAgent: true }, fetcher);
    assert.equal(engine, "vision_agent");
    assert.deepEqual(steps, ["JEV was unavailable; using Vision agent"]);
  }
});

test("the vision agent can be chosen directly, or by JEV in Auto", async () => {
  const withAgent = { ...allKeys, visionAgent: true };
  assert.deepEqual(await choose("vision_agent", withAgent), { engine: "vision_agent", steps: ["Selected Vision agent"] });
  assert.deepEqual(
    await choose("auto", withAgent, jevAnswers("vision_agent", 0.7)),
    { engine: "vision_agent", steps: ["JEV selected Vision agent"] },
  );
});

test("JEV is offered only the engines that are connected", async () => {
  let criteria;
  const jevSeeing = async (_url, init) => {
    criteria = Object.keys(JSON.parse(init.body).questions.route.criteria).sort();
    return Response.json({ answers: { route: { choice: "vision_agent", confidence: 0.8 } } });
  };
  await choose("auto", { browserUseKey: "", kernelKey: "k", jev: allKeys.jev, visionAgent: true }, jevSeeing);
  assert.deepEqual(criteria, ["kernel", "vision_agent"]);
});

test("Auto leaves out browser agents that need more time than research has left", async () => {
  const keys = { ...allKeys, visionAgent: true };
  const pick = async (timeLeft, fetcher = noJevCall) => {
    const steps = [];
    const engine = await chooseResearchEngine("auto", keys, "a question", signal, fetcher, (s) => steps.push(s), timeLeft);
    return { engine, steps };
  };
  assert.deepEqual(await pick(40_000), {
    engine: "kernel",
    steps: ["Not enough time is left for Browser Use Cloud or Vision agent", "Selected Kernel"],
  });
  let criteria;
  const jevSeeing = async (_url, init) => {
    criteria = Object.keys(JSON.parse(init.body).questions.route.criteria).sort();
    return Response.json({ answers: { route: { choice: "vision_agent", confidence: 0.8 } } });
  };
  assert.equal((await pick(50_000, jevSeeing)).engine, "vision_agent");
  assert.deepEqual(criteria, ["kernel", "vision_agent"]);
  // With time for all of them, or when no engine fits, nothing is left out.
  assert.equal((await pick(120_000, jevAnswers("browser_use", 0.9))).engine, "browser_use");
  assert.deepEqual(await pick(10_000, jevAnswers("kernel", 0.9)), { engine: "kernel", steps: ["JEV selected Kernel"] });
  // An engine the user chose is kept; it says itself when time is too short.
  assert.equal(await chooseResearchEngine("browser_use", keys, "q", signal, noJevCall, undefined, 10_000), "browser_use");
});

test("Auto without JEV prefers the vision agent, then Kernel, then Browser Use Cloud", async () => {
  assert.equal((await choose("auto", { ...allKeys, jev: undefined, visionAgent: true })).engine, "vision_agent");
  assert.equal((await choose("auto", { ...allKeys, jev: undefined })).engine, "kernel");
  assert.equal((await choose("auto", { ...allKeys, kernelKey: "", jev: undefined })).engine, "browser_use");
});

test("a second try leaves out the engine that failed, and Browser Use Cloud is the backup", async () => {
  const keys = { ...allKeys, visionAgent: true };
  const again = async (avoid, fetcher = noJevCall, k = keys) => {
    const steps = [];
    const engine = await chooseResearchEngine("auto", k, "a question", signal, fetcher, (s) => steps.push(s), Infinity, avoid);
    return { engine, steps };
  };
  let criteria;
  const jevSeeing = (choice, confidence) => async (_url, init) => {
    criteria = Object.keys(JSON.parse(init.body).questions.route.criteria).sort();
    return Response.json({ answers: { route: { choice, confidence } } });
  };
  // JEV no longer sees the vision agent, and an unsure answer goes to the backup.
  assert.deepEqual(await again(["vision_agent"], jevSeeing("kernel", 0.4)),
    { engine: "browser_use", steps: ["JEV was unsure; using Browser Use Cloud"] });
  assert.deepEqual(criteria, ["browser_use", "kernel"]);
  assert.deepEqual(await again(["vision_agent"], async () => new Response("down", { status: 503 })),
    { engine: "browser_use", steps: ["JEV was unavailable; using Browser Use Cloud"] });
  // Without JEV the backup is Browser Use Cloud too.
  assert.equal((await again(["vision_agent"], noJevCall, { ...keys, jev: undefined })).engine, "browser_use");
  // When every engine was tried, the choice is made as usual; a chosen engine is kept.
  assert.equal((await again(["vision_agent", "kernel", "browser_use"], noJevCall, { ...keys, jev: undefined })).engine, "vision_agent");
  assert.equal(await chooseResearchEngine("kernel", keys, "q", signal, noJevCall, undefined, Infinity, ["kernel"]), "kernel");
});
