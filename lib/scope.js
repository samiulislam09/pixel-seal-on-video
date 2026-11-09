// Scoping of watermark IDs per store, and validation of the link a video carries.

const SCOPE_RE = /^(s\d+|w[a-z0-9]{1,16})$/;
const NOTE_MAX = 1000;

/** True when the whole value is a scope such as s22 or w1a2b3c4d. */
export const isScope = (s) => typeof s === "string" && SCOPE_RE.test(s);

/** `s22-k7f3qa9m` -> `s22`. Null when the ID has no recognised scope. */
export function scopeOf(watermarkId) {
  if (typeof watermarkId !== "string") return null;
  const i = watermarkId.indexOf("-");
  if (i < 0) return null;
  const s = watermarkId.slice(0, i).toLowerCase();
  return SCOPE_RE.test(s) ? s : null;
}

export function inScope(videos, scope) {
  const want = String(scope).toLowerCase();
  return videos.filter((v) => scopeOf(v.watermarkId) === want);
}

const isId = (n) => Number.isInteger(n) && n > 0;

export function validLink(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "link must be an object." };
  let note;
  if (raw.note !== undefined && raw.note !== null) {
    if (typeof raw.note !== "string") return { error: "link.note must be a string." };
    note = raw.note.trim();
    if (note.length > NOTE_MAX) return { error: `link.note can be at most ${NOTE_MAX} characters.` };
  }
  if (raw.type === "product") {
    if (!isId(raw.productId)) return { error: "link.productId must be a positive integer." };
    const link = { type: "product", productId: raw.productId };
    if (raw.variantId !== undefined && raw.variantId !== null) {
      if (!isId(raw.variantId)) return { error: "link.variantId must be a positive integer." };
      link.variantId = raw.variantId;
    }
    if (note) link.note = note;
    return { link };
  }
  if (raw.type === "knowledge") {
    const title = typeof raw.knowledgeTitle === "string" ? raw.knowledgeTitle.trim() : "";
    if (!title) return { error: "link.knowledgeTitle is required." };
    const link = { type: "knowledge", knowledgeTitle: title };
    if (note) link.note = note;
    return { link };
  }
  if (raw.type === "note") {
    if (!note) return { error: "link.note is required." };
    return { link: { type: "note", note } };
  }
  return { error: "link.type must be product, knowledge or note." };
}
