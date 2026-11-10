// Keeps the cloud matching service (xchat/videoimagematch) in step with this registry, so
// screenshots are still recognised while this PC is off. Only what matching needs is sent:
// no file names on disk, callback URLs or webhook results.
import crypto from "node:crypto";
import zlib from "node:zlib";

const FIELDS = ["id", "kind", "name", "watermarkId", "bits", "status", "link", "createdAt", "completedAt"];
const CHECK_MS = 60_000;
const DEBOUNCE_MS = 2_000;
const TIMEOUT_MS = 30_000;

/** The ready records, trimmed to the fields the cloud copy keeps. Records without `kind` are videos. */
export function replicaRecords(videos) {
  return videos
    .filter((v) => v.status === "ready" && typeof v.bits === "string")
    .map((v) => {
      const r = {};
      for (const f of FIELDS) if (v[f] !== undefined && v[f] !== null) r[f] = v[f];
      r.kind = v.kind ?? "video";
      return r;
    });
}

/** Same hash as videoimagematch's snapshotHash. */
export const snapshotHash = (records) => crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex");

/**
 * Pushes the registry whenever it changes (after a short pause) and checks the cloud copy every
 * minute, so a push missed while offline, or a cloud copy that was reset, is caught up.
 */
export function startReplica({ registry, url, key, allowMassRemoval = false, fetchImpl = fetch, log = console }) {
  const base = url.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${key}` };
  let remoteHash = null; // null = unknown, ask the cloud first
  let running = null;
  let again = false;
  let failing = false;
  let timer = null;

  async function syncOnce() {
    const records = replicaRecords(registry.videos);
    const hash = snapshotHash(records);
    if (remoteHash === null) {
      const res = await fetchImpl(`${base}/api/sync/state`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`state: HTTP ${res.status}`);
      remoteHash = (await res.json()).hash;
    }
    if (hash === remoteHash) return false;
    const body = zlib.gzipSync(JSON.stringify({ records, ...(allowMassRemoval ? { force: true } : {}) }));
    const res = await fetchImpl(`${base}/api/sync/snapshot`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json", "Content-Encoding": "gzip" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const out = await res.json().catch(() => ({}));
    if (res.status === 409 && out.code === "mass_removal") {
      remoteHash = null;
      throw new Error(`${out.error} If you really deleted them, set REPLICA_ALLOW_MASS_REMOVAL=true once and restart.`);
    }
    if (!res.ok) throw new Error(`snapshot: HTTP ${res.status} ${out.error ?? ""}`.trim());
    remoteHash = out.hash;
    log.log(`[replica] pushed ${out.count} records (+${out.added} -${out.removed})`);
    return true;
  }

  /** Runs one sync, or queues one more if a sync is already running. Never throws. */
  function sync() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          await syncOnce();
          if (failing) log.log("[replica] cloud copy is up to date again");
          failing = false;
        } catch (e) {
          remoteHash = null;
          if (!failing) log.error(`[replica] could not update the cloud copy (retrying every minute): ${e.message}`);
          failing = true;
          again = false;
        }
      } while (again);
      running = null;
    })();
    return running;
  }

  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(sync, DEBOUNCE_MS);
    timer.unref?.();
  };
  registry.onSave = changed;
  const interval = setInterval(() => {
    remoteHash = null; // re-read the cloud's hash: it may have been restored or reset
    sync();
  }, CHECK_MS);
  interval.unref?.();
  sync();

  return {
    sync,
    stop() {
      clearTimeout(timer);
      clearInterval(interval);
      registry.onSave = null;
    },
  };
}
