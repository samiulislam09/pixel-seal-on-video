import { test } from "node:test";
import assert from "node:assert/strict";
import { isImage, isVideo, outputExt, parseLinkField, clampStrength } from "../lib/images.js";
import { publicVideo } from "../lib/match.js";

test("records without kind are videos", () => {
  assert.equal(isVideo({ id: "a" }), true);
  assert.equal(isImage({ id: "a" }), false);
  assert.equal(isImage({ id: "a", kind: "image" }), true);
  assert.equal(isVideo({ id: "a", kind: "image" }), false);
  assert.equal(isVideo(undefined), false);
});

test("outputExt keeps lossless sources as PNG and turns the rest into JPEG", () => {
  assert.equal(outputExt(".png"), ".png");
  assert.equal(outputExt(".BMP"), ".png");
  assert.equal(outputExt(".jpg"), ".jpg");
  assert.equal(outputExt(".jpeg"), ".jpg");
  assert.equal(outputExt(".webp"), ".jpg");
});

test("parseLinkField: empty is no link, JSON is validated", () => {
  assert.deepEqual(parseLinkField(undefined), { link: undefined });
  assert.deepEqual(parseLinkField("  "), { link: undefined });
  assert.deepEqual(parseLinkField('{"type":"product","productId":12}'), { link: { type: "product", productId: 12 } });
  assert.match(parseLinkField("{oops").error, /JSON/);
  assert.match(parseLinkField('{"type":"product"}').error, /productId/);
});

test("clampStrength defaults to 0.4 and stays within 0.05 to 1", () => {
  assert.equal(clampStrength(undefined), 0.4);
  assert.equal(clampStrength("0.3"), 0.3);
  assert.equal(clampStrength("5"), 1);
  assert.equal(clampStrength("0.01"), 0.05);
});

test("publicVideo marks the kind and gives images a download URL", () => {
  const v = publicVideo({ id: "v1", status: "ready", bits: "0101" });
  assert.equal(v.kind, "video");
  assert.equal(v.bits, undefined);
  assert.equal(v.downloadUrl, undefined);
  const i = publicVideo({ id: "i1", kind: "image", status: "ready", bits: "0101" });
  assert.equal(i.kind, "image");
  assert.equal(i.stage, "completed");
  assert.equal(i.downloadUrl, "/api/images/i1/download");
});
