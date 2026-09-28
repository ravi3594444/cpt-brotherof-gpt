import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseResearchEngine, jevService } from "../lib/cloud-research.ts";
import { researchTask } from "../lib/research.ts";

const signal = new AbortController().signal;
const allKeys = { browserUseKey: "b", kernelKey: "k", jev: jevService({ aimlapiKey: "j" }) };
const noJevCall = async () => assert.fail("JEV should not be called");
const jevAnswers = (choice, confidence) => async () =>
  Response.json({ answers: { route: { choice, confidence } } });

const quick = researchTask("a question");
const deep = researchTask({ task: "a question", depth: "deep" });
async function choose(requested, keys, fetcher = noJevCall, request = quick) {
  const steps = [];
  const engine = await chooseResearchEngine(requested, keys, request, signal, fetcher, (s) => steps.push(s));
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

test("JEV is told plain Kernel is the default and the fastest, the vision agent for using a site, and Browser Use only when needed", async () => {
  let body;
  const jevSeeing = async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ answers: { route: { choice: "vision_agent", confidence: 0.8 } } });
  };
  await choose("auto", { ...allKeys, visionAgent: true }, jevSeeing);
  const { route } = body.questions;
  assert.match(route.instructions, /kernel is the default and the fastest/i);
  assert.match(route.criteria.kernel, /default/i);
  assert.match(route.criteria.kernel, /fastest/i);
  assert.match(route.criteria.kernel, /facts, explanations, how things work, news, reviews/);
  assert.match(route.criteria.vision_agent, /like a person/);
  assert.match(route.criteria.vision_agent, /searching inside a site, filters, menus, product listings and prices, pictures, layouts/);
  assert.match(route.criteria.browser_use, /only when/i);
  assert.match(body.state, /a question/);
  assert.match(body.state, /Research depth: quick/);
  await choose("auto", { ...allKeys, visionAgent: true }, jevSeeing, deep);
  assert.match(body.state, /Research depth: deep/);
});

test("Browser Use Cloud is used on a first try only when JEV is sure the task needs it", async () => {
  assert.deepEqual(await choose("auto", allKeys, jevAnswers("browser_use", 0.3)),
    { engine: "kernel", steps: ["JEV was unsure; using Kernel"] });
  assert.deepEqual(await choose("auto", { ...allKeys, visionAgent: true }, jevAnswers("browser_use", 0.5)),
    { engine: "kernel", steps: ["JEV was unsure; using Kernel"] });
  assert.deepEqual(await choose("auto", { ...allKeys, visionAgent: true }, jevAnswers("browser_use", 0.5), deep),
    { engine: "vision_agent", steps: ["JEV was unsure; using Vision agent"] });
  assert.deepEqual(await choose("auto", { ...allKeys, visionAgent: true }, jevAnswers("browser_use", 0.65)),
    { engine: "browser_use", steps: ["JEV selected Browser Use Cloud"] });
});

test("an unsure plain-Kernel answer stays Kernel for quick research, and browses with the vision agent for deep", async () => {
  const withAgent = { ...allKeys, visionAgent: true };
  assert.deepEqual(await choose("auto", withAgent, jevAnswers("kernel", 0.4)), { engine: "kernel", steps: ["JEV selected Kernel"] });
  assert.deepEqual(await choose("auto", withAgent, jevAnswers("kernel", 0.4), deep),
    { engine: "vision_agent", steps: ["JEV was unsure; using Vision agent"] });
  // Without the vision agent, Kernel stays Kernel.
  assert.deepEqual(await choose("auto", allKeys, jevAnswers("kernel", 0.4), deep), { engine: "kernel", steps: ["JEV selected Kernel"] });
  // A sure answer is kept whatever the depth.
  assert.deepEqual(await choose("auto", withAgent, jevAnswers("kernel", 0.9), deep), { engine: "kernel", steps: ["JEV selected Kernel"] });
  assert.deepEqual(await choose("auto", withAgent, jevAnswers("vision_agent", 0.3)), { engine: "vision_agent", steps: ["JEV selected Vision agent"] });
});

test("a JEV failure says why, uses the engine the depth prefers, and logs the cause without the key", async () => {
  const withAgent = { ...allKeys, visionAgent: true, jev: jevService({ aimlapiKey: "secret-jev-key" }) };
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    const cases = [
      [async () => new Response(`{"error":"insufficient credit for secret-jev-key"}`, { status: 402 }), "unavailable (HTTP 402)"],
      [async () => new Response("overloaded", { status: 529 }), "unavailable (HTTP 529)"],
      [async () => { throw new TypeError("network down"); }, "unavailable (network error)"],
      [async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }, "unavailable (timed out)"],
      [async () => Response.json({ answers: { route: { choice: "teleport", confidence: 0.9 } } }), "unavailable (unexpected answer)"],
      [async () => new Response("not json", { status: 200 }), "unavailable (unexpected answer)"],
    ];
    for (const [fetcher, why] of cases) {
      assert.deepEqual(await choose("auto", withAgent, fetcher), { engine: "kernel", steps: [`JEV was ${why}; using Kernel`] });
      assert.deepEqual(await choose("auto", withAgent, fetcher, deep), { engine: "vision_agent", steps: [`JEV was ${why}; using Vision agent`] });
    }
  } finally {
    console.warn = warn;
  }
  assert.ok(warned.some((w) => /HTTP 402/.test(w) && /insufficient credit/.test(w)), warned.join("\n"));
  assert.ok(warned.some((w) => /HTTP 529/.test(w) && /overloaded/.test(w)));
  assert.ok(warned.some((w) => /timed out/.test(w)));
  assert.ok(warned.some((w) => /network down/.test(w)));
  assert.ok(warned.some((w) => /teleport/.test(w)));
  assert.ok(warned.every((w) => !w.includes("secret-jev-key")), "the key never reaches the log");
});

test("the logged JEV response body is cut to about 300 characters", async () => {
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    await choose("auto", allKeys, async () => new Response("x".repeat(5000), { status: 500 }));
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.ok(warned[0].length < 400, String(warned[0].length));
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
    const engine = await chooseResearchEngine("auto", keys, quick, signal, fetcher, (s) => steps.push(s), timeLeft);
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
  assert.equal(await chooseResearchEngine("browser_use", keys, quick, signal, noJevCall, undefined, 10_000), "browser_use");
});

test("Auto without JEV prefers Kernel, then the vision agent, for quick research, and the vision agent first for deep", async () => {
  const noJev = { ...allKeys, jev: undefined };
  assert.equal((await choose("auto", { ...noJev, visionAgent: true })).engine, "kernel");
  assert.equal((await choose("auto", { ...noJev, visionAgent: true }, noJevCall, deep)).engine, "vision_agent");
  assert.equal((await choose("auto", noJev, noJevCall, deep)).engine, "kernel");
  assert.equal((await choose("auto", { ...noJev, kernelKey: "" })).engine, "browser_use");
  assert.equal((await choose("auto", { ...noJev, kernelKey: "" }, noJevCall, deep)).engine, "browser_use");
});

test("a second try leaves out the engine that failed, and Browser Use Cloud is the backup", async () => {
  const keys = { ...allKeys, visionAgent: true };
  const again = async (avoid, fetcher = noJevCall, k = keys, request = quick) => {
    const steps = [];
    const engine = await chooseResearchEngine("auto", k, request, signal, fetcher, (s) => steps.push(s), Infinity, avoid);
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
  assert.deepEqual(await again(["vision_agent"], jevSeeing("kernel", 0.4), keys, deep),
    { engine: "browser_use", steps: ["JEV was unsure; using Browser Use Cloud"] });
  assert.deepEqual(await again(["vision_agent"], async () => new Response("down", { status: 503 })),
    { engine: "browser_use", steps: ["JEV was unavailable (HTTP 503); using Browser Use Cloud"] });
  // Browser Use Cloud needs no confidence on a second try; a sure answer is kept.
  assert.deepEqual(await again(["kernel"], jevSeeing("browser_use", 0.3)),
    { engine: "browser_use", steps: ["JEV selected Browser Use Cloud"] });
  assert.deepEqual(await again(["kernel"], jevSeeing("vision_agent", 0.9)),
    { engine: "vision_agent", steps: ["JEV selected Vision agent"] });
  // Without JEV the backup is Browser Use Cloud too.
  assert.equal((await again(["vision_agent"], noJevCall, { ...keys, jev: undefined })).engine, "browser_use");
  assert.equal((await again(["kernel"], noJevCall, { ...keys, jev: undefined }, deep)).engine, "browser_use");
  // Without Browser Use Cloud, the untried engine.
  assert.equal((await again(["kernel"], noJevCall, { ...keys, browserUseKey: "", jev: undefined })).engine, "vision_agent");
  // When every engine was tried, the choice is made as usual; a chosen engine is kept.
  assert.equal((await again(["vision_agent", "kernel", "browser_use"], noJevCall, { ...keys, jev: undefined })).engine, "kernel");
  assert.equal((await again(["vision_agent", "kernel", "browser_use"], noJevCall, { ...keys, jev: undefined }, deep)).engine, "vision_agent");
  assert.equal(await chooseResearchEngine("kernel", keys, quick, signal, noJevCall, undefined, Infinity, ["kernel"]), "kernel");
});
