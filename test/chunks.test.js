import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chunkCount, receivedChunks, missingChunks, assemble } from "../lib/chunks.js";

const MB50 = 50 * 1024 ** 2;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "chunks-"));

test("chunkCount", () => {
  assert.equal(chunkCount(0), 1);
  assert.equal(chunkCount(MB50), 1);
  assert.equal(chunkCount(MB50 + 1), 2);
  assert.equal(chunkCount(10, 4), 3);
});

test("receivedChunks and missingChunks", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "2"), "x");
  fs.writeFileSync(path.join(dir, "0"), "x");
  fs.writeFileSync(path.join(dir, "junk"), "x");
  assert.deepEqual(receivedChunks(dir), [0, 2]);
  assert.deepEqual(missingChunks(dir, 3), [1]);
  assert.deepEqual(receivedChunks(path.join(dir, "nope")), []);
  fs.rmSync(dir, { recursive: true });
});

test("assemble joins in order, returns bytes, removes the dir", async () => {
  const base = tmp();
  const dir = path.join(base, "c");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "2"), "e");
  fs.writeFileSync(path.join(dir, "0"), "ab");
  fs.writeFileSync(path.join(dir, "1"), "cd");
  const out = path.join(base, "out.bin");
  assert.equal(await assemble(dir, 3, out), 5);
  assert.equal(fs.readFileSync(out, "utf8"), "abcde");
  assert.equal(fs.existsSync(dir), false);
  fs.rmSync(base, { recursive: true });
});

import { createClaims } from "../lib/chunks.js";
test("claims: second claim fails until released", () => {
  const c = createClaims();
  assert.equal(c.claim("a"), true);
  assert.equal(c.claim("a"), false);
  assert.equal(c.claim("b"), true);
  c.release("a");
  assert.equal(c.has("a"), false);
  assert.equal(c.claim("a"), true);
});
