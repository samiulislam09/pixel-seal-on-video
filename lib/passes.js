import crypto from "node:crypto";

const sign = (payload, secret) => crypto.createHmac("sha256", secret).update(payload).digest("hex");

export function signPass({ action, videoId, exp }, secret) {
  const payload = Buffer.from(JSON.stringify({ a: action, v: videoId, e: exp })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyPass(pass, secret, expect, now = Date.now() / 1000) {
  if (typeof pass !== "string") return { ok: false, reason: "malformed" };
  const parts = pass.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, sig] = parts;
  const want = Buffer.from(sign(payload, secret));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return { ok: false, reason: "bad_signature" };
  }
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!data || typeof data !== "object" || typeof data.a !== "string" || typeof data.v !== "string" || typeof data.e !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (data.a !== expect.action) return { ok: false, reason: "wrong_action" };
  if (data.v !== expect.videoId) return { ok: false, reason: "wrong_video" };
  if (now > data.e) return { ok: false, reason: "expired" };
  return { ok: true };
}
