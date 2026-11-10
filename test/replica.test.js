import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { replicaRecords, snapshotHash, startReplica } from "../lib/replica.js";

const BITS = "01".repeat(128);
const quiet = { log() {}, error() {} };

test("only ready records are sent, trimmed to what matching needs", () => {
  const out = replicaRecords([
    { id: "a", status: "ready", bits: BITS, watermarkId: "s1-a", name: "a.mp4", link: { type: "note", note: "n" },
      input: "x.mp4", output: "y.mp4", callbackUrl: "https://secret.example", webhook: {}, progress: 1, createdAt: "t" },
    { id: "b", status: "processing", bits: BITS },
    { id: "c", status: "failed", bits: BITS },
    { id: "d", kind: "image", status: "ready", bits: BITS, watermarkId: null },
  ]);
  assert.deepEqual(out, [
    { id: "a", kind: "video", name: "a.mp4", watermarkId: "s1-a", bits: BITS, status: "ready", link: { type: "note", note: "n" }, createdAt: "t" },
    { id: "d", kind: "image", bits: BITS, status: "ready" },
  ]);
});

// A fake videoimagematch: keeps what it is sent and answers like the real one.
function fakeCloud() {
  const cloud = { records: [], puts: 0, down: false, refuse: false };
  cloud.fetch = async (url, init = {}) => {
    if (cloud.down) throw new Error("fetch failed");
    if (url.endsWith("/api/sync/state")) return Response.json({ hash: snapshotHash(cloud.records) });
    cloud.puts++;
    const body = JSON.parse(zlib.gunzipSync(init.body));
    if (cloud.refuse && !body.force) return Response.json({ code: "mass_removal", error: "too many" }, { status: 409 });
    cloud.records = body.records;
    cloud.force = body.force;
    return Response.json({ count: body.records.length, added: 0, removed: 0, hash: snapshotHash(body.records) });
  };
  return cloud;
}

test("pushes on start, skips when nothing matching-related changed, catches up after an outage", async () => {
  const cloud = fakeCloud();
  const registry = { videos: [{ id: "a", status: "ready", bits: BITS }] };
  const r = startReplica({ registry, url: "https://m.example/", key: "k", fetchImpl: cloud.fetch, log: quiet });
  await r.sync();
  assert.equal(cloud.records.length, 1);
  assert.equal(cloud.puts, 1);

  registry.videos[0].progress = 0.5; // progress saves must not cause pushes
  await r.sync();
  assert.equal(cloud.puts, 1);

  cloud.down = true;
  registry.videos.push({ id: "b", status: "ready", bits: BITS });
  await r.sync(); // fails quietly
  cloud.down = false;
  await r.sync();
  assert.deepEqual(cloud.records.map((x) => x.id), ["a", "b"]);
  r.stop();
});

test("a refused mass removal is only forced when allowed", async () => {
  const cloud = fakeCloud();
  cloud.refuse = true;
  const registry = { videos: [{ id: "a", status: "ready", bits: BITS }] };
  const r = startReplica({ registry, url: "https://m.example", key: "k", fetchImpl: cloud.fetch, log: quiet });
  await r.sync();
  assert.equal(cloud.records.length, 0);
  r.stop();

  const r2 = startReplica({ registry, url: "https://m.example", key: "k", allowMassRemoval: true, fetchImpl: cloud.fetch, log: quiet });
  await r2.sync();
  assert.equal(cloud.records.length, 1);
  assert.equal(cloud.force, true);
  r2.stop();
});
