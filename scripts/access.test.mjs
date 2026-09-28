import assert from "node:assert/strict";
import { test } from "node:test";
import { accessAllowed, refuse } from "../lib/access.ts";

test("the Research job routes refuse other sites and requests without the code, like the chat route", async () => {
  const request = (headers) => new Request("https://scout.example/api/jobs/x/stream", { headers });
  assert.equal(refuse(request({ "x-scout-access": "code" }), "code"), undefined);
  assert.equal(refuse(request({}), ""), undefined);
  const missing = refuse(request({}), "code");
  assert.equal(missing.status, 401);
  assert.equal(await missing.text(), "Scout needs its access code. Reload Scout and enter it again.");
  assert.equal(refuse(request({ "x-scout-access": "cod" }), "code").status, 401);
  const elsewhere = refuse(request({ origin: "https://evil.example", "x-scout-access": "code" }), "code");
  assert.equal(elsewhere.status, 403);
});

test("with no access code set, everyone may use Scout", () => {
  assert.equal(accessAllowed("", null), true);
  assert.equal(accessAllowed("", "anything"), true);
});

test("with an access code set, only the exact code is let in", () => {
  assert.equal(accessAllowed("river-lantern-42", "river-lantern-42"), true);
  for (const wrong of [null, "", "river-lantern-4", "river-lantern-421", "River-lantern-42", " river-lantern-42"])
    assert.equal(accessAllowed("river-lantern-42", wrong), false, String(wrong));
});
