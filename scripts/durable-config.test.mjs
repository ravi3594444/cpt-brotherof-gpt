import assert from "node:assert/strict";
import { test } from "node:test";
import { durableResearch, researchMaxCostUsd, serverConfig, testMode } from "../lib/server-config.ts";

test("the research cost cap is two dollars unless RESEARCH_MAX_COST_USD sets a positive amount", () => {
  assert.equal(researchMaxCostUsd(undefined), 2);
  assert.equal(researchMaxCostUsd(""), 2);
  assert.equal(researchMaxCostUsd("5"), 5);
  assert.equal(researchMaxCostUsd(" 0.5 "), 0.5);
  for (const bad of ["0", "-1", "abc", "Infinity", "1e9x"]) assert.equal(researchMaxCostUsd(bad), 2, bad);
  assert.equal(serverConfig({ RESEARCH_MAX_COST_USD: "3.5" }).maxCostUsd, 3.5);
});

test("durable research runs where workflows do: on Vercel or the local world, never on Cloudflare", () => {
  assert.equal(durableResearch({ VERCEL: "1" }), true);
  assert.equal(durableResearch({ WORKFLOW_TARGET_WORLD: "local" }), true);
  assert.equal(durableResearch({}), false, "vinext and plain Node have no workflow world");
  assert.equal(durableResearch({ VERCEL: "1" }, "Cloudflare-Workers"), false);
  for (const off of ["off", "0", "false", "no", "OFF"])
    assert.equal(durableResearch({ VERCEL: "1", SCOUT_DURABLE_RESEARCH: off }), false, off);
  assert.equal(durableResearch({ VERCEL: "1", SCOUT_DURABLE_RESEARCH: "on" }), true);
  assert.equal(serverConfig({ WORKFLOW_TARGET_WORLD: "local" }).durable, true);
});

test("test mode is refused on Vercel", () => {
  assert.equal(testMode({ SCOUT_TEST_MODE: "1" }), true);
  assert.equal(testMode({ SCOUT_TEST_MODE: "1", VERCEL: "1" }), false);
  assert.equal(testMode({}), false);
  assert.equal(testMode({ SCOUT_TEST_MODE: "yes" }), false);
  assert.equal(serverConfig({ SCOUT_TEST_MODE: "1" }).testMode, true);
});
