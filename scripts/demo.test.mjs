import assert from "node:assert/strict";
import { test } from "node:test";
import { demoAnswer, withoutCitations } from "../lib/demo.ts";

test("removes a citation whose URL contains parentheses", () => {
  const { text } = demoAnswer("Show me a photo source card");
  const plain = withoutCitations(text);
  assert.doesNotMatch(plain, /\]\(|\.jpg\)/);
  assert.match(plain, /credited to Tom Sodoge\.\n\nTap the photo card/);
});

test("removes several citations in a row", () => {
  assert.equal(
    withoutCitations("React is a library. [1](https://react.dev/learn) [2](https://nextjs.org/docs)\n\nNext"),
    "React is a library.\n\nNext",
  );
});

test("keeps ordinary markdown links that are not numbered citations", () => {
  assert.equal(
    withoutCitations("See [the docs](https://react.dev/learn) today."),
    "See [the docs](https://react.dev/learn) today.",
  );
});

test("every prepared answer reads cleanly with web search off", () => {
  for (const question of [
    "How do AI agents search the web?",
    "Compare React and Next.js for a new app",
    "How can I check if a source is reliable?",
    "Show me a photo source card",
  ])
    assert.doesNotMatch(withoutCitations(demoAnswer(question).text), /\[\d+\]|\]\(https?:/, question);
});
