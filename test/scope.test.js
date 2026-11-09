import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeOf, inScope, validLink } from "../lib/scope.js";

test("scopeOf", () => {
  assert.equal(scopeOf("s22-k7f3qa9m"), "s22");
  assert.equal(scopeOf("W1a2b3c4d-x"), "w1a2b3c4d");
  assert.equal(scopeOf("CLIENT-42"), null);
  assert.equal(scopeOf(null), null);
});

test("inScope keeps only the exact scope", () => {
  const vs = [{ watermarkId: "s22-a" }, { watermarkId: "s220-b" }, { watermarkId: "s3-c" }, { watermarkId: null }, { watermarkId: "S22-d" }];
  assert.deepEqual(inScope(vs, "s22").map((v) => v.watermarkId), ["s22-a", "S22-d"]);
  assert.equal(inScope(vs, "S22").length, 2);
});

test("validLink accepts the three types", () => {
  assert.deepEqual(validLink({ type: "product", productId: 12 }), { link: { type: "product", productId: 12 } });
  assert.deepEqual(validLink({ type: "product", productId: 12, variantId: 3, note: " hi " }), { link: { type: "product", productId: 12, variantId: 3, note: "hi" } });
  assert.deepEqual(validLink({ type: "knowledge", knowledgeTitle: " Sizes ", note: "  " }), { link: { type: "knowledge", knowledgeTitle: "Sizes" } });
  assert.deepEqual(validLink({ type: "note", note: "hello" }), { link: { type: "note", note: "hello" } });
});

test("validLink rejects bad input", () => {
  for (const bad of [
    { type: "product", productId: "12" },
    { type: "product", productId: 1.5 },
    { type: "product", productId: 0 },
    { type: "product", productId: 1, variantId: "2" },
    { type: "note", note: "x".repeat(1001) },
    { type: "note", note: "  " },
    { type: "knowledge", knowledgeTitle: "" },
    { type: "other" },
    null,
    "x",
  ]) assert.ok(validLink(bad).error, JSON.stringify(bad));
  assert.ok(validLink({ type: "note", note: "x".repeat(1000) }).link);
});

import { isScope } from "../lib/scope.js";
import { test as t2 } from "node:test";
import assert2 from "node:assert/strict";
t2("isScope is strict", () => {
  assert2.equal(isScope("s22"), true);
  assert2.equal(isScope("w1a2b3c4d"), true);
  assert2.equal(isScope("s22-x"), false);
  assert2.equal(isScope(""), false);
  assert2.equal(isScope(5), false);
});
