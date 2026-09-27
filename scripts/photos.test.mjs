import assert from "node:assert/strict";
import { test } from "node:test";
import { fitWithin } from "../lib/photos.ts";

test("shrinks a photo so its longer side fits, keeping its shape", () => {
  assert.deepEqual(fitWithin(4000, 3000, 1280), { width: 1280, height: 960 });
  assert.deepEqual(fitWithin(1000, 3000, 1280), { width: 427, height: 1280 });
});

test("never enlarges a photo that already fits", () => {
  assert.deepEqual(fitWithin(800, 600, 1280), { width: 800, height: 600 });
});
