import assert from "node:assert/strict";
import { test } from "node:test";
import { planReplace, separatorBefore } from "../src/text.ts";

test("separator: space only after a non-space character", () => {
  assert.equal(separatorBefore("a", false), " ");
  assert.equal(separatorBefore(" ", false), "");
  assert.equal(separatorBefore("", false), "");
  assert.equal(separatorBefore("a", true), "");
});

test("planReplace: a growing transcript is a pure append", () => {
  assert.deepEqual(planReplace(" This is", " This is a test"), { backspaces: 0, insert: " a test" });
});

test("planReplace: a revised word only rewrites the changed tail", () => {
  assert.deepEqual(planReplace(" for pie", " for Pi."), { backspaces: 3, insert: "Pi." });
});

test("planReplace: clearing removes everything", () => {
  assert.deepEqual(planReplace(" hello", ""), { backspaces: 6, insert: "" });
});

test("planReplace: counts graphemes, not code units", () => {
  assert.deepEqual(planReplace(" café 👍🏽", " café"), { backspaces: 2, insert: "" });
});
