import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SealWorker } from "./lib/sealWorker.js";
import { Registry } from "./lib/registry.js";
import { matchAgainstRegistry, publicVideo, videoStage } from "./lib/match.js";
import { envPython } from "./lib/pythonPath.js";
import { locateFfmpeg, addToPath } from "./lib/ffmpegPath.js";
import { sendWebhook, validCallbackUrl } from "./lib/webhook.js";
import { scopeOf, inScope, isScope, validLink } from "./lib/scope.js";
import { openapi } from "./lib/openapi.js";
import { verifyPass } from "./lib/passes.js";
import { chunkCount, receivedChunks, missingChunks, assemble, createClaims, CHUNK_BYTES } from "./lib/chunks.js";
import { asyncRoute, isPassRoute, retryDecision } from "./lib/http.js";
import { IMAGE_EXT, isImage, isVideo, outputExt, parseLinkField, clampStrength } from "./lib/images.js";
import { expiredMessage, retentionDays, videosToExpire } from "./lib/retention.js";
import swaggerUi from "swagger-ui-express";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Settings can live in a .env file next to server.js (see .env.example). Real env vars win.
if (fs.existsSync(path.join(ROOT, ".env")) && process.loadEnvFile) process.loadEnvFile(path.join(ROOT, ".env"));
const PORT = Number(process.env.PORT || 3000);
const PYTHON = process.env.SEAL_PYTHON || envPython(ROOT);
const SCRIPT = path.join(ROOT, "worker", "seal_worker.py");
const DIRS = {
  uploads: path.join(ROOT, "storage", "uploads"),
  outputs: path.join(ROOT, "storage", "outputs"),
  screenshots: path.join(ROOT, "storage", "screenshots"),
  chunks: path.join(ROOT, "storage", "chunks"),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

if (!PYTHON || !fs.existsSync(PYTHON)) {
  console.error(`Python environment not found in ${path.join(ROOT, "pyenv")}. Run "npm run setup" first.`);
  process.exit(1);
}

const ff = locateFfmpeg();
if (ff.missing) {
  console.error(`${ff.missing.join(" and ")} not found. Install ffmpeg (Windows: winget install Gyan.FFmpeg) or set FFMPEG_DIR.`);
  process.exit(1);
}
addToPath(ff.dir); // the Python workers inherit this PATH

const cpus = os.cpus().length;
// Two workers so a long video job never blocks screenshot checks.
const embedWorker = new SealWorker({ name: "embed", python: PYTHON, script: SCRIPT, threads: Math.max(2, cpus - 2) });
const detectWorker = new SealWorker({ name: "detect", python: PYTHON, script: SCRIPT, threads: 2 });
const registry = new Registry(path.join(ROOT, "data", "videos.json"));

// Secret used to turn a custom watermark ID into 256 bits. Without it, nobody can compute
// the watermark for a given ID. The registry stores the bits, so detection never needs it.
const SECRET_FILE = path.join(ROOT, "data", "secret.key");
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim();

// API key for /api. Set API_KEY, or one is generated into data/api.key on first start.
// It also signs webhook bodies (X-Signature: sha256=HMAC(body, API key)).
const API_KEY_FILE = path.join(ROOT, "data", "api.key");
if (!process.env.API_KEY && !fs.existsSync(API_KEY_FILE)) fs.writeFileSync(API_KEY_FILE, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
const API_KEY = (process.env.API_KEY || fs.readFileSync(API_KEY_FILE, "utf8")).trim();
// The web page on this computer works without the key. Set TRUST_LOCALHOST=false when a reverse
// proxy on the same machine forwards internet traffic without adding X-Forwarded-For.
const TRUST_LOCALHOST = process.env.TRUST_LOCALHOST !== "false";

const toBits = (buf) => [...buf].map((b) => b.toString(2).padStart(8, "0")).join("");
const bitsForId = (watermarkId) => toBits(crypto.createHmac("sha256", SECRET).update(watermarkId, "utf8").digest());

function validateWatermarkId(raw) {
  const id = String(raw ?? "").trim();
  if (id === "") return { id: null };
  if (id.length > 64) return { error: "The ID can be at most 64 characters." };
  if (/[\u0000-\u001f\u007f]/.test(id)) return { error: "The ID cannot contain control characters." };
  const taken = registry.videos.find((v) => v.status !== "failed" && v.watermarkId?.toLowerCase() === id.toLowerCase());
  if (taken) return { error: `The ID "${id}" is already used by "${taken.name}". Choose another, or delete that ${taken.kind === "image" ? "photo" : "video"} first.` };
  return { id };
}

function startJob(v) {
  const started = Date.now();
  let lastSave = 0;
  embedWorker
    .run(
      "embed",
      { input: path.join(DIRS.uploads, v.input), output: path.join(DIRS.outputs, v.output), bits: v.bits, strength: v.strength, mode: v.mode },
      (progress) => {
        v.status = "processing";
        v.progress = progress;
        if (Date.now() - lastSave > 2000) (registry.save(), (lastSave = Date.now()));
      },
    )
    .then((r) => {
      const sizeOut = fs.statSync(path.join(DIRS.outputs, v.output)).size;
      registry.update(v.id, {
        status: "ready",
        progress: 1,
        frames: r.frames,
        width: r.width,
        height: r.height,
        fps: r.fps,
        selfCheck: r.self_check_bit_acc,
        sizeOut,
        seconds: Math.round((Date.now() - started) / 1000),
        completedAt: new Date().toISOString(),
      });
      console.log(`[embed] ${v.name}: ${r.frames} frames, self-check ${r.self_check_bit_acc}`);
      // The original is not needed once the watermarked copy exists.
      fs.rm(path.join(DIRS.uploads, v.input), { force: true }, () => {});
    })
    .catch((e) => {
      // Keep the original so the job can be retried; it is deleted after FAILED_KEEP_DAYS.
      registry.update(v.id, { status: "failed", error: e.message, failedAt: new Date().toISOString() });
    })
    .then(() => notify(v));
}

// Tell the caller the outcome, if they gave a callbackUrl.
async function notify(v) {
  if (!v.callbackUrl) return;
  const stage = videoStage(v);
  const event = stage === "completed" ? "video.completed" : "video.failed";
  const r = await sendWebhook(v.callbackUrl, { event, video: publicVideo(v) }, API_KEY);
  registry.update(v.id, { webhook: { event, ...r, at: new Date().toISOString() } });
  if (!r.delivered) console.error(`[webhook] gave up on ${v.callbackUrl} for ${v.name}`);
}

// An image still "processing" belonged to a request that died with the server; its caller got an error.
for (const v of registry.videos.filter((x) => isImage(x) && x.status !== "ready")) {
  registry.remove(v.id);
  fs.rm(path.join(DIRS.outputs, v.output), { force: true }, () => {});
}

// Resume jobs that a restart or crash interrupted, with the same watermark ID.
for (const v of registry.videos) if (isVideo(v) && (v.status === "processing" || v.status === "queued")) {
  if (v.input && fs.existsSync(path.join(DIRS.uploads, v.input))) {
    registry.update(v.id, { status: "queued", progress: 0 });
    console.log(`[embed] resuming interrupted job: ${v.name}`);
    startJob(v);
  } else {
    registry.update(v.id, { status: "failed", error: "Interrupted, and the uploaded file is missing.", failedAt: new Date().toISOString() });
    notify(v);
  }
}

// Originals of failed jobs are kept for Retry, then removed.
const FAILED_KEEP_MS = 7 * 24 * 3600 * 1000;
function cleanupFailedOriginals() {
  for (const v of registry.videos) {
    if (v.status !== "failed" || !v.input || !v.failedAt) continue;
    if (Date.now() - Date.parse(v.failedAt) > FAILED_KEEP_MS) fs.rm(path.join(DIRS.uploads, v.input), { force: true }, () => {});
  }
}
cleanupFailedOriginals();
setInterval(cleanupFailedOriginals, 3600_000).unref();

// Watermarked video files are deleted VIDEO_RETENTION_DAYS after they were made (default 30, 0 = never).
// The record stays, so screenshots of the video are still recognised; only re-downloading stops.
const RETENTION_DAYS = retentionDays(process.env.VIDEO_RETENTION_DAYS);
function expireOldVideos() {
  if (!RETENTION_DAYS) return;
  const expired = videosToExpire(registry.videos, Date.now(), RETENTION_DAYS);
  for (const v of expired) {
    fs.rm(path.join(DIRS.outputs, v.output), { force: true }, () => {});
    registry.update(v.id, { fileDeletedAt: new Date().toISOString(), fileRetentionDays: RETENTION_DAYS });
  }
  if (expired.length) console.log(`[retention] removed ${expired.length} watermarked video file(s) older than ${RETENTION_DAYS} days`);
}
expireOldVideos();
setInterval(expireOldVideos, 6 * 3600_000).unref();

// Stop the Python workers with the server, so none keep running orphaned.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    embedWorker.stop();
    detectWorker.stop();
    process.exit(0);
  });
}

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);
const storage = (dir) =>
  multer.diskStorage({
    destination: dir,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${path.extname(file.originalname).toLowerCase()}`),
  });
const uploadVideo = multer({
  storage: storage(DIRS.uploads),
  limits: { fileSize: 2 * 1024 ** 3 },
  fileFilter: (_req, f, cb) => cb(null, VIDEO_EXT.has(path.extname(f.originalname).toLowerCase())),
});
const imageFilter = (_req, f, cb) => cb(null, IMAGE_EXT.has(path.extname(f.originalname).toLowerCase()));
const uploadImage = multer({ storage: storage(DIRS.screenshots), limits: { fileSize: 50 * 1024 ** 2 }, fileFilter: imageFilter });
// Product photos to watermark (as opposed to screenshots to check).
const uploadPhoto = multer({ storage: storage(DIRS.uploads), limits: { fileSize: 50 * 1024 ** 2 }, fileFilter: imageFilter });

const app = express();
app.use(express.static(path.join(ROOT, "public")));

// API documentation (no key needed to read it): Swagger UI at /docs, raw spec at /openapi.json.
app.get("/openapi.json", (_req, res) => res.json(openapi));
app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(openapi, {
    customSiteTitle: "Video Watermark API",
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true, tryItOutEnabled: true },
  }),
);

// Every /api route needs the key (checked before any upload is written to disk).
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
// Tunnels and proxies (cloudflared, ngrok, nginx) connect from localhost too, so a request only
// counts as local when it carries none of the headers they add. Cloudflare always sets CF-Connecting-IP.
const PROXY_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded", "cf-connecting-ip", "cf-ray", "true-client-ip", "x-forwarded-host", "x-forwarded-proto", "via"];
const isLocal = (req) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) && !PROXY_HEADERS.some((h) => req.headers[h]);
// Browsers upload and download straight from here, authorised by a signed pass (not the key).
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
app.use("/api", (req, res, next) => {
  if (!isPassRoute(req.method, req.path)) return next();
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.set({ "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" });
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
app.use("/api", (req, res, next) => {
  if (isPassRoute(req.method, req.path) && req.query.pass) return next(); // the route verifies the pass itself
  if (TRUST_LOCALHOST && isLocal(req)) return next();
  const auth = req.headers.authorization || "";
  // The web page stores the key in the wm_key cookie, so download links and <video> work too.
  const cookie = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith("wm_key="));
  const given = auth.startsWith("Bearer ") ? auth.slice(7).trim()
    : req.headers["x-api-key"] || (cookie && decodeURIComponent(cookie.slice(7)));
  if (given && crypto.timingSafeEqual(sha(given), sha(API_KEY))) return next();
  res.status(401).json({ error: "Missing or invalid API key. Send the header  Authorization: Bearer <key>" });
});

app.get("/api/status", (_req, res) => {
  res.json({
    embedReady: embedWorker.ready,
    detectReady: detectWorker.ready,
    model: embedWorker.info?.model ?? null,
    device: embedWorker.info?.device ?? null,
    deviceName: embedWorker.info?.deviceName ?? null,
    queue: embedWorker.queued,
    // Days a watermarked video file is kept (VIDEO_RETENTION_DAYS); 0 = kept forever.
    videoRetentionDays: RETENTION_DAYS,
  });
});

// Videos and images share the registry (one watermark ID space, one detection pool); each route family sees only its kind.
const getVideo = (id) => (isVideo(registry.get(id)) ? registry.get(id) : undefined);
const getImage = (id) => (isImage(registry.get(id)) ? registry.get(id) : undefined);

app.get("/api/videos", (_req, res) => res.json(registry.videos.filter(isVideo).map(publicVideo)));

app.get("/api/videos/:id", (req, res) => {
  const v = getVideo(req.params.id);
  if (!v) return res.status(404).json({ error: "Not found" });
  res.json(publicVideo(v));
});

const MAX_VIDEO_BYTES = 2 * 1024 ** 3;
const jsonBody = express.json({ limit: "64kb" });

// Reserve a record (and its watermark ID) before the file is uploaded.
app.post("/api/videos/reserve", jsonBody, (req, res) => {
  const b = req.body || {};
  const wid = validateWatermarkId(b.watermarkId);
  if (wid.error) return res.status(400).json({ error: wid.error });
  if (!wid.id) return res.status(400).json({ error: "watermarkId is required." });
  const lk = validLink(b.link);
  if (lk.error) return res.status(400).json({ error: lk.error });
  const cb = validCallbackUrl(b.callbackUrl);
  if (cb.error) return res.status(400).json({ error: cb.error });
  const fileName = typeof b.fileName === "string" ? b.fileName.trim() : "";
  if (!fileName || fileName.length > 255) return res.status(400).json({ error: "fileName is required (up to 255 characters)." });
  if (!Number.isInteger(b.sizeBytes) || b.sizeBytes <= 0 || b.sizeBytes > MAX_VIDEO_BYTES) {
    return res.status(400).json({ error: "sizeBytes must be a positive integer of at most 2 GB." });
  }
  const id = crypto.randomBytes(6).toString("hex");
  const base = path.parse(fileName).name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "video";
  const v = registry.add({
    id,
    name: fileName,
    watermarkId: wid.id,
    link: lk.link,
    callbackUrl: cb.url,
    input: null,
    output: `${base}-watermarked-${id}.mp4`,
    sizeIn: b.sizeBytes,
    strength: 0.4,
    mode: "smooth",
    bits: bitsForId(wid.id),
    status: "awaiting_upload",
    progress: 0,
    createdAt: new Date().toISOString(),
  });
  res.status(201).json(publicVideo(v));
});

app.patch("/api/videos/:id", jsonBody, (req, res) => {
  const v = getVideo(req.params.id);
  if (!v) return res.status(404).json({ error: "Not found" });
  const lk = validLink(req.body?.link);
  if (lk.error) return res.status(400).json({ error: lk.error });
  res.json(publicVideo(registry.update(v.id, { link: lk.link })));
});

app.post("/api/videos/:id/retry", (req, res) => {
  const v = getVideo(req.params.id);
  if (!v) return res.status(404).json({ error: "Not found" });
  const d = retryDecision(v, Boolean(v.input) && fs.existsSync(path.join(DIRS.uploads, v.input)));
  if (d.kind === "not_failed") {
    // Nothing to retry; the record is left as it is.
    return res.status(409).json({ error: `The video is not failed (it is ${videoStage(v)}).`, code: "not_failed", stage: videoStage(v) });
  }
  if (d.kind === "original_gone") {
    // The original is gone: reset the record so a fresh upload pass works.
    fs.rmSync(path.join(DIRS.chunks, v.id), { recursive: true, force: true });
    registry.update(v.id, { status: "awaiting_upload", input: null, progress: 0, error: undefined, failedAt: undefined, webhook: undefined });
    return res.status(409).json({ error: "The original file is no longer on this server; upload it again.", code: "original_gone" });
  }
  const u = registry.update(v.id, { status: "queued", progress: 0, error: undefined, failedAt: undefined, webhook: undefined });
  res.status(202).json(publicVideo(u));
  startJob(u);
});

app.post("/api/videos", uploadVideo.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload a video file (mp4, mov, mkv, webm, avi)." });
  const wid = validateWatermarkId(req.body.watermarkId);
  const cb = validCallbackUrl(req.body.callbackUrl);
  if (wid.error || cb.error) {
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(400).json({ error: wid.error || cb.error });
  }
  const strength = Math.min(1, Math.max(0.05, Number(req.body.strength) || 0.4));
  const mode = req.body.mode === "robust" ? "robust" : "smooth";
  const id = crypto.randomBytes(6).toString("hex");
  const bits = wid.id ? bitsForId(wid.id) : toBits(crypto.randomBytes(32));
  const base = path.parse(req.file.originalname).name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "video";
  const v = registry.add({
    id,
    name: req.file.originalname,
    watermarkId: wid.id,
    callbackUrl: cb.url,
    input: req.file.filename,
    output: `${base}-watermarked-${id}.mp4`,
    sizeIn: req.file.size,
    strength,
    mode,
    bits,
    status: "queued",
    progress: 0,
    createdAt: new Date().toISOString(),
  });
  res.status(202).json(publicVideo(v));
  startJob(v);
});

// The watermarked file is kept, so it can be downloaded any number of times.
app.get("/api/videos/:id/download", (req, res) => {
  const v = getVideo(req.params.id);
  if (!v || v.status !== "ready") return res.status(404).json({ error: "Not ready" });
  sendOutput(res, v, true);
});

// The record says ready but the file may be gone: answer 404, never the raw filesystem error.
function sendOutput(res, v, attachment) {
  if (v.fileDeletedAt) {
    return res.status(410).json({
      // The days in force when this file was removed; older records fall back to the current setting.
      error: expiredMessage(v.fileRetentionDays ?? RETENTION_DAYS),
      code: "file_expired",
    });
  }
  const file = path.join(DIRS.outputs, v.output);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "The watermarked file is missing on this server." });
  if (attachment) return res.download(file, v.output);
  res.sendFile(file);
}

app.get("/api/videos/:id/stream", (req, res) => {
  const v = getVideo(req.params.id);
  if (!v || v.status !== "ready") return res.status(404).end();
  sendOutput(res, v, false);
});

// ---- Pass-authorised routes (browser upload / download) ----
function needPass(action, state) {
  return (req, res, next) => {
    const videoId = req.params.videoId ?? req.params.id;
    const r = verifyPass(String(req.query.pass || ""), API_KEY, { action, videoId });
    if (!r.ok) return res.status(401).json({ error: "Invalid or expired pass.", reason: r.reason });
    const v = getVideo(videoId);
    if (!v) return res.status(404).json({ error: "Not found" });
    if (claims.has(videoId)) return res.status(409).json({ error: "The upload is being finished.", code: "finishing" });
    // `status` lets a browser tell "already moved on" (e.g. a retried complete) from a real conflict.
    if (v.status !== state) return res.status(409).json({ error: `The video is ${v.status}, expected ${state}.`, status: v.status, stage: videoStage(v) });
    req.video = v;
    next();
  };
}
const claims = createClaims();
const chunkDir = (id) => path.join(DIRS.chunks, id);
const rawChunk = express.raw({ limit: "51mb", type: () => true });

app.put("/api/uploads/:videoId/chunks/:index", needPass("upload", "awaiting_upload"), rawChunk, (req, res) => {
  const total = chunkCount(req.video.sizeIn);
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= total) return res.status(400).json({ error: `index must be 0 to ${total - 1}.` });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Empty chunk." });
  const dir = chunkDir(req.video.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(index)), req.body);
  res.json({ index, received: receivedChunks(dir).length, total });
});

app.get("/api/uploads/:videoId", needPass("upload", "awaiting_upload"), (req, res) => {
  res.json({ chunkBytes: CHUNK_BYTES, total: chunkCount(req.video.sizeIn), received: receivedChunks(chunkDir(req.video.id)) });
});

app.post("/api/uploads/:videoId/complete", needPass("upload", "awaiting_upload"), asyncRoute(async (req, res) => {
  const v = req.video;
  if (!claims.claim(v.id)) return res.status(409).json({ error: "The upload is being finished.", code: "finishing" });
  try {
  const ext = path.extname(v.name).toLowerCase();
  if (!VIDEO_EXT.has(ext)) return res.status(400).json({ error: "Upload a video file (mp4, mov, m4v, mkv, webm, avi)." });
  const dir = chunkDir(v.id);
  const total = chunkCount(v.sizeIn);
  const missing = missingChunks(dir, total);
  if (missing.length) return res.status(409).json({ error: "Some chunks are missing.", missing });
  const stored = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const dest = path.join(DIRS.uploads, stored);
  let bytes;
  try {
    bytes = await assemble(dir, total, dest);
  } catch (e) {
    return res.status(500).json({ error: `Could not assemble the upload: ${e.code || e.message}` });
  }
  if (bytes !== v.sizeIn) {
    fs.rmSync(dest, { force: true });
    return res.status(400).json({ error: `Uploaded ${bytes} bytes, expected ${v.sizeIn}. Upload the file again.` });
  }
  // The record may have been deleted while the file was being assembled.
  if (!registry.get(v.id)) {
    fs.rmSync(dest, { force: true });
    return res.status(410).json({ error: "The video was deleted while the upload was being finished.", code: "deleted" });
  }
  const u = registry.update(v.id, { input: stored, sizeIn: bytes, status: "queued", progress: 0 });
  res.status(202).json(publicVideo(u));
  startJob(u);
  } finally {
    claims.release(v.id);
  }
}));

app.get("/api/videos/:id/file", needPass("download", "ready"), (req, res) => sendOutput(res, req.video, true));

app.delete("/api/videos/:id", (req, res) => {
  const v = getVideo(req.params.id);
  if (!v) return res.status(404).json({ error: "Not found" });
  if (v.status === "processing" || v.status === "queued") return res.status(409).json({ error: "Still processing." });
  if (claims.has(v.id)) return res.status(409).json({ error: "The upload is being finished; try again in a moment." });
  registry.remove(v.id);
  fs.rm(chunkDir(v.id), { recursive: true, force: true }, () => {});
  for (const f of [v.input && path.join(DIRS.uploads, v.input), path.join(DIRS.outputs, v.output)].filter(Boolean)) fs.rm(f, { force: true }, () => {});
  res.json({ ok: true });
});

// ---- Images (product photos): watermarked within the request, no queue ----
// They run on the detect worker, which is never busy for long, so a long video job cannot hold them up.
app.post("/api/images", uploadPhoto.single("image"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload an image file (png, jpg, jpeg, webp, bmp)." });
  const dropUpload = () => fs.rm(req.file.path, { force: true }, () => {});
  const wid = validateWatermarkId(req.body.watermarkId);
  const lk = parseLinkField(req.body.link);
  if (wid.error || lk.error) {
    dropUpload();
    return res.status(400).json({ error: wid.error || lk.error });
  }
  const id = crypto.randomBytes(6).toString("hex");
  const strength = clampStrength(req.body.strength);
  const bits = wid.id ? bitsForId(wid.id) : toBits(crypto.randomBytes(32));
  const base = path.parse(req.file.originalname).name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "image";
  const output = `${base}-watermarked-${id}${outputExt(path.extname(req.file.originalname))}`;
  // Added before the work starts so the watermark ID is taken at once.
  registry.add({
    id, kind: "image", name: req.file.originalname, watermarkId: wid.id, link: lk.link,
    output, sizeIn: req.file.size, strength, bits, status: "processing", progress: 0, createdAt: new Date().toISOString(),
  });
  const t0 = Date.now();
  try {
    const r = await detectWorker.run("embed_image", { input: req.file.path, output: path.join(DIRS.outputs, output), bits, strength });
    const u = registry.update(id, {
      status: "ready", progress: 1, width: r.width, height: r.height, format: r.format,
      selfCheck: r.self_check_bit_acc, sizeOut: fs.statSync(path.join(DIRS.outputs, output)).size, ms: Date.now() - t0,
    });
    console.log(`[image] ${u.name}: ${r.width}x${r.height}, self-check ${r.self_check_bit_acc}`);
    res.status(201).json(publicVideo(u));
  } catch (e) {
    // Nothing worth keeping or retrying: the caller still has the photo and can send it again.
    registry.remove(id);
    fs.rm(path.join(DIRS.outputs, output), { force: true }, () => {});
    res.status(e.badInput ? 400 : 500).json({ error: e.message });
  } finally {
    dropUpload();
  }
}));

app.get("/api/images", (_req, res) => res.json(registry.videos.filter(isImage).map(publicVideo)));

app.get("/api/images/:id", (req, res) => {
  const v = getImage(req.params.id);
  if (!v) return res.status(404).json({ error: "Not found" });
  res.json(publicVideo(v));
});

app.patch("/api/images/:id", jsonBody, (req, res) => {
  const v = getImage(req.params.id);
  if (!v) return res.status(404).json({ error: "Not found" });
  const lk = validLink(req.body?.link);
  if (lk.error) return res.status(400).json({ error: lk.error });
  res.json(publicVideo(registry.update(v.id, { link: lk.link })));
});

app.get("/api/images/:id/download", (req, res) => {
  const v = getImage(req.params.id);
  if (!v || v.status !== "ready") return res.status(404).json({ error: "Not ready" });
  sendOutput(res, v, true);
});

app.delete("/api/images/:id", (req, res) => {
  const v = getImage(req.params.id);
  if (!v) return res.status(404).json({ error: "Not found" });
  if (v.status !== "ready") return res.status(409).json({ error: "Still processing." });
  registry.remove(v.id);
  fs.rm(path.join(DIRS.outputs, v.output), { force: true }, () => {});
  res.json({ ok: true });
});

app.post("/api/detect", uploadImage.single("image"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload an image (png, jpg, webp)." });
  let crop = null;
  try {
    crop = req.body.crop ? JSON.parse(req.body.crop) : null;
  } catch {}
  const scopeRaw = req.body.scope;
  let scope = null;
  if (scopeRaw !== undefined && scopeRaw !== "") {
    scope = typeof scopeRaw === "string" && isScope(scopeRaw.trim().toLowerCase()) ? scopeRaw.trim().toLowerCase() : null;
    if (!scope) {
      fs.rm(req.file.path, { force: true }, () => {});
      return res.status(400).json({ error: "scope must look like s22 or w1a2b3c4d." });
    }
  }
  try {
    const t0 = Date.now();
    const r = await detectWorker.run("detect", { image: req.file.path, crop });
    const result = matchAgainstRegistry(r.candidates, scope ? inScope(registry.ready(), scope) : registry.ready());
    res.json({ ...result, image: { width: r.width, height: r.height }, ms: Date.now() - t0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
}));

// Upload/body errors (multer, JSON) are the caller's fault; anything else is ours.
app.use((err, _req, res, _next) => {
  const status = err instanceof multer.MulterError ? 400 : err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status >= 500) console.error("[api]", err);
  if (res.headersSent) return;
  res.status(status).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Video watermark app on http://localhost:${PORT} (loading PixelSeal...)`);
  console.log(`API docs on http://localhost:${PORT}/docs`);
  console.log(`API key: ${process.env.API_KEY ? "from API_KEY" : `in ${API_KEY_FILE}`}${TRUST_LOCALHOST ? " (not needed from this computer)" : ""}`);
});
