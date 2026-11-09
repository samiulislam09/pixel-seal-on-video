// Helpers for watermarking still images (product photos), kept apart from server.js so they can be tested.
import { validLink } from "./scope.js";

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

/** Records without `kind` predate image support and are videos. */
export const isImage = (v) => v?.kind === "image";
export const isVideo = (v) => Boolean(v) && !isImage(v);

/** Lossless sources stay lossless (PNG); photos come back as high-quality JPEG. */
export function outputExt(inputExt) {
  const e = String(inputExt).toLowerCase();
  return e === ".png" || e === ".bmp" ? ".png" : ".jpg";
}

/** `link` arrives as a JSON string in a multipart form. Optional for images. */
export function parseLinkField(raw) {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return { link: undefined };
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { error: "link must be JSON, for example {\"type\":\"product\",\"productId\":12}." };
    }
  }
  return validLink(obj);
}

/** Strength from a form field: 0.05 to 1, default 0.4. */
export const clampStrength = (raw) => Math.min(1, Math.max(0.05, Number(raw) || 0.4));
