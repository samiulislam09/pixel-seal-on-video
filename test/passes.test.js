import test from "node:test";
import assert from "node:assert/strict";
import { signPass, verifyPass } from "../lib/passes.js";

const S = "secret-key";
const now = 1_000_000;
const mk = (o = {}) => signPass({ action: "upload", videoId: "s22-abc", exp: now + 60, ...o }, S);

test("valid pass verifies", () => {
  assert.deepEqual(verifyPass(mk(), S, { action: "upload", videoId: "s22-abc" }, now), { ok: true });
});
test("wrong_video", () => {
  assert.equal(verifyPass(mk(), S, { action: "upload", videoId: "other" }, now).reason, "wrong_video");
});
test("wrong_action", () => {
  assert.equal(verifyPass(mk(), S, { action: "download", videoId: "s22-abc" }, now).reason, "wrong_action");
});
test("expired", () => {
  assert.equal(verifyPass(mk(), S, { action: "upload", videoId: "s22-abc" }, now + 61).reason, "expired");
});
test("bad_signature on flipped char and wrong secret", () => {
  const p = mk();
  const last = p.slice(-1) === "0" ? "1" : "0";
  assert.equal(verifyPass(p.slice(0, -1) + last, S, { action: "upload", videoId: "s22-abc" }, now).reason, "bad_signature");
  assert.equal(verifyPass(p, "nope", { action: "upload", videoId: "s22-abc" }, now).reason, "bad_signature");
});
test("malformed", () => {
  const e = { action: "upload", videoId: "s22-abc" };
  for (const p of ["abc", "", null]) assert.equal(verifyPass(p, S, e, now).reason, "malformed");
  const payload = Buffer.from("not json").toString("base64url");
  const { createHmac } = await_crypto();
  const sig = createHmac("sha256", S).update(payload).digest("hex");
  assert.equal(verifyPass(`${payload}.${sig}`, S, e, now).reason, "malformed");
});
import * as crypto from "node:crypto";
function await_crypto() { return crypto; }
