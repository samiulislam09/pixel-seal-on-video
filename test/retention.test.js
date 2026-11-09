import { test } from "node:test";
import assert from "node:assert/strict";
import { retentionDays, videosToExpire, expiredMessage } from "../lib/retention.js";

const DAY = 24 * 3600 * 1000;
const now = Date.parse("2026-12-31T00:00:00Z");
const ago = (days) => new Date(now - days * DAY).toISOString();

test("a ready video older than the retention period is expired", () => {
  const v = { id: "a", status: "ready", completedAt: ago(31) };
  assert.deepEqual(videosToExpire([v], now, 30).map((x) => x.id), ["a"]);
});

test("a ready video younger than the retention period is kept", () => {
  assert.deepEqual(videosToExpire([{ id: "a", status: "ready", completedAt: ago(29) }], now, 30), []);
});

test("age falls back to createdAt for records made before completedAt existed", () => {
  assert.deepEqual(videosToExpire([{ id: "a", status: "ready", createdAt: ago(40) }], now, 30).map((x) => x.id), ["a"]);
});

test("images are never expired", () => {
  assert.deepEqual(videosToExpire([{ id: "i", kind: "image", status: "ready", completedAt: ago(400) }], now, 30), []);
});

test("videos not ready, or whose file was already removed, are skipped", () => {
  const list = [
    { id: "q", status: "queued", createdAt: ago(60) },
    { id: "p", status: "processing", createdAt: ago(60) },
    { id: "f", status: "failed", createdAt: ago(60) },
    { id: "w", status: "awaiting_upload", createdAt: ago(60) },
    { id: "d", status: "ready", completedAt: ago(60), fileDeletedAt: ago(1) },
  ];
  assert.deepEqual(videosToExpire(list, now, 30), []);
});

test("a record with no usable date is kept", () => {
  assert.deepEqual(videosToExpire([{ id: "a", status: "ready" }], now, 30), []);
});

test("retentionDays reads VIDEO_RETENTION_DAYS, default 30, 0 turns cleanup off", () => {
  assert.equal(retentionDays(undefined), 30);
  assert.equal(retentionDays(""), 30);
  assert.equal(retentionDays("45"), 45);
  assert.equal(retentionDays("0"), 0);
  assert.equal(retentionDays("abc"), 30);
  assert.equal(retentionDays("-3"), 30);
});

test("expiredMessage uses singular/plural and the days in force when the file was removed", () => {
  assert.equal(expiredMessage(1), "The watermarked file was removed after 1 day. Screenshots of it are still recognised.");
  assert.equal(expiredMessage(30), "The watermarked file was removed after 30 days. Screenshots of it are still recognised.");
  assert.equal(expiredMessage(undefined), "The watermarked file was removed after its storage period. Screenshots of it are still recognised.");
  assert.equal(expiredMessage(0), "The watermarked file was removed after its storage period. Screenshots of it are still recognised.");
});
