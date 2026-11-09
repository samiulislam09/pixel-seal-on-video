// Chunked uploads: pieces are stored as storage/chunks/<videoId>/<index> and joined on complete.
import fs from "node:fs";
import path from "node:path";

export const CHUNK_BYTES = 50 * 1024 ** 2;

export const chunkCount = (sizeBytes, chunkBytes = CHUNK_BYTES) => Math.max(1, Math.ceil(sizeBytes / chunkBytes));

/** Sorted indexes of the chunks present in `dir` (empty when the dir is missing). */
export function receivedChunks(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
}

export function missingChunks(dir, total) {
  const have = new Set(receivedChunks(dir));
  const out = [];
  for (let i = 0; i < total; i++) if (!have.has(i)) out.push(i);
  return out;
}

/** Concatenate chunks 0..total-1 into outFile, remove dir, resolve to the byte count. */
export async function assemble(dir, total, outFile) {
  const out = fs.createWriteStream(outFile);
  let bytes = 0;
  try {
    for (let i = 0; i < total; i++) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(path.join(dir, String(i)));
        rs.on("data", (c) => (bytes += c.length));
        rs.on("error", reject);
        rs.on("end", resolve);
        rs.pipe(out, { end: false });
      });
    }
    await new Promise((resolve, reject) => {
      out.on("error", reject);
      out.end(resolve);
    });
  } catch (e) {
    out.destroy();
    fs.rmSync(outFile, { force: true });
    throw e;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return bytes;
}

/** In-memory claims so only one request at a time may finish an upload. */
export function createClaims() {
  const held = new Set();
  return {
    claim: (id) => (held.has(id) ? false : (held.add(id), true)),
    release: (id) => void held.delete(id),
    has: (id) => held.has(id),
  };
}
