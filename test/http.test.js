import { test } from "node:test";
import assert from "node:assert/strict";
import { asyncRoute, isPassRoute, retryDecision } from "../lib/http.js";

test("asyncRoute turns a rejected handler into next(err)", async () => {
  const boom = new Error("boom");
  let got;
  const h = asyncRoute(async () => {
    throw boom;
  });
  await h({}, {}, (e) => (got = e));
  assert.equal(got, boom);
});

test("asyncRoute passes sync throws to next and leaves success alone", async () => {
  let got = "unset";
  await asyncRoute(() => {
    throw new Error("sync");
  })({}, {}, (e) => (got = e.message));
  assert.equal(got, "sync");
  let called = false;
  await asyncRoute(async (_q, res) => (res.ok = true))({}, {}, () => (called = true));
  assert.equal(called, false);
});

test("isPassRoute checks the method as well as the path", () => {
  assert.equal(isPassRoute("GET", "/uploads/abc"), true);
  assert.equal(isPassRoute("OPTIONS", "/uploads/abc"), true);
  assert.equal(isPassRoute("DELETE", "/uploads/abc"), false);
  assert.equal(isPassRoute("POST", "/uploads/abc"), false);
  assert.equal(isPassRoute("PUT", "/uploads/abc/chunks/3"), true);
  assert.equal(isPassRoute("OPTIONS", "/uploads/abc/chunks/3"), true);
  assert.equal(isPassRoute("GET", "/uploads/abc/chunks/3"), false);
  assert.equal(isPassRoute("POST", "/uploads/abc/complete"), true);
  assert.equal(isPassRoute("OPTIONS", "/uploads/abc/complete"), true);
  assert.equal(isPassRoute("GET", "/uploads/abc/complete"), false);
  assert.equal(isPassRoute("GET", "/videos/abc/file"), true);
  assert.equal(isPassRoute("OPTIONS", "/videos/abc/file"), true);
  assert.equal(isPassRoute("DELETE", "/videos/abc/file"), false);
  assert.equal(isPassRoute("GET", "/videos/abc"), false);
  assert.equal(isPassRoute("DELETE", "/videos/abc"), false);
  assert.equal(isPassRoute("GET", "/videos"), false);
});

test("retryDecision: not failed, original gone, or run", () => {
  assert.deepEqual(retryDecision({ status: "ready" }, true), { kind: "not_failed" });
  assert.deepEqual(retryDecision({ status: "awaiting_upload" }, false), { kind: "not_failed" });
  assert.deepEqual(retryDecision({ status: "failed", input: null }, false), { kind: "original_gone" });
  assert.deepEqual(retryDecision({ status: "failed", input: "a.mp4" }, false), { kind: "original_gone" });
  assert.deepEqual(retryDecision({ status: "failed", input: "a.mp4" }, true), { kind: "run" });
});
