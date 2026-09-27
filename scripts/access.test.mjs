import assert from "node:assert/strict";
import { test } from "node:test";
import { accessAllowed } from "../lib/access.ts";

test("with no access code set, everyone may use Scout", () => {
  assert.equal(accessAllowed("", null), true);
  assert.equal(accessAllowed("", "anything"), true);
});

test("with an access code set, only the exact code is let in", () => {
  assert.equal(accessAllowed("river-lantern-42", "river-lantern-42"), true);
  for (const wrong of [null, "", "river-lantern-4", "river-lantern-421", "River-lantern-42", " river-lantern-42"])
    assert.equal(accessAllowed("river-lantern-42", wrong), false, String(wrong));
});
