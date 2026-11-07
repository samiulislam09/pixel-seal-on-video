// POST a JSON event to a caller's callback URL, signed so the receiver can verify it came from us.
import crypto from "node:crypto";

const DELAYS = [2, 10, 30, 120]; // seconds between attempts (5 attempts in total)

export function signBody(body, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function validCallbackUrl(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return { url: null };
  if (s.length > 2048) return { error: "callbackUrl is too long." };
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    return { url: u.href };
  } catch {
    return { error: "callbackUrl must be an http(s) URL." };
  }
}

/** Resolves to { delivered, attempts, status }. Never throws. */
export async function sendWebhook(url, payload, secret) {
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json", "X-Event": payload.event, "X-Signature": signBody(body, secret) };
  let status = null;
  for (let attempt = 1; attempt <= DELAYS.length + 1; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(15000) });
      status = res.status;
      if (res.ok) return { delivered: true, attempts: attempt, status };
      console.warn(`[webhook] ${url} answered ${res.status} (attempt ${attempt})`);
    } catch (e) {
      status = null;
      console.warn(`[webhook] ${url} unreachable: ${e.cause?.code || e.message} (attempt ${attempt})`);
    }
    if (attempt <= DELAYS.length) await new Promise((r) => setTimeout(r, DELAYS[attempt - 1] * 1000));
  }
  return { delivered: false, attempts: DELAYS.length + 1, status };
}
