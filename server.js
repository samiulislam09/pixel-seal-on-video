import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SealWorker } from "./lib/sealWorker.js";
import { Registry } from "./lib/registry.js";
import { matchAgainstRegistry, publicVideo } from "./lib/match.js";
import { envPython } from "./lib/pythonPath.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PYTHON = process.env.SEAL_PYTHON || envPython(ROOT);
const SCRIPT = path.join(ROOT, "worker", "seal_worker.py");
const DIRS = {
  uploads: path.join(ROOT, "storage", "uploads"),
  outputs: path.join(ROOT, "storage", "outputs"),
  screenshots: path.join(ROOT, "storage", "screenshots"),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

if (!PYTHON || !fs.existsSync(PYTHON)) {
  console.error(`Python environment not found in ${path.join(ROOT, "pyenv")}. Run "npm run setup" first.`);
  process.exit(1);
}

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

const toBits = (buf) => [...buf].map((b) => b.toString(2).padStart(8, "0")).join("");
const bitsForId = (watermarkId) => toBits(crypto.createHmac("sha256", SECRET).update(watermarkId, "utf8").digest());

function validateWatermarkId(raw) {
  const id = String(raw ?? "").trim();
  if (id === "") return { id: null };
  if (id.length > 64) return { error: "The ID can be at most 64 characters." };
  if (/[\u0000-\u001f\u007f]/.test(id)) return { error: "The ID cannot contain control characters." };
  const taken = registry.videos.find((v) => v.status !== "failed" && v.watermarkId?.toLowerCase() === id.toLowerCase());
  if (taken) return { error: `The ID "${id}" is already used by "${taken.name}". Choose another, or delete that video first.` };
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
      });
      console.log(`[embed] ${v.name}: ${r.frames} frames, self-check ${r.self_check_bit_acc}`);
    })
    .catch((e) => registry.update(v.id, { status: "failed", error: e.message }));
}

// Resume jobs that a restart or crash interrupted, with the same watermark ID.
for (const v of registry.videos) if (v.status === "processing" || v.status === "queued") {
  if (fs.existsSync(path.join(DIRS.uploads, v.input))) {
    registry.update(v.id, { status: "queued", progress: 0 });
    console.log(`[embed] resuming interrupted job: ${v.name}`);
    startJob(v);
  } else {
    registry.update(v.id, { status: "failed", error: "Interrupted, and the uploaded file is missing." });
  }
}

// Stop the Python workers with the server, so none keep running orphaned.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    embedWorker.stop();
    detectWorker.stop();
    process.exit(0);
  });
}

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);
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
const uploadImage = multer({
  storage: storage(DIRS.screenshots),
  limits: { fileSize: 50 * 1024 ** 2 },
  fileFilter: (_req, f, cb) => cb(null, IMAGE_EXT.has(path.extname(f.originalname).toLowerCase())),
});

const app = express();
app.use(express.static(path.join(ROOT, "public")));

app.get("/api/status", (_req, res) => {
  res.json({
    embedReady: embedWorker.ready,
    detectReady: detectWorker.ready,
    model: embedWorker.info?.model ?? null,
    device: embedWorker.info?.device ?? null,
    deviceName: embedWorker.info?.deviceName ?? null,
    queue: embedWorker.queued,
  });
});

app.get("/api/videos", (_req, res) => res.json(registry.videos.map(publicVideo)));

app.get("/api/videos/:id", (req, res) => {
  const v = registry.get(req.params.id);
  if (!v) return res.status(404).json({ error: "Not found" });
  res.json(publicVideo(v));
});

app.post("/api/videos", uploadVideo.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload a video file (mp4, mov, mkv, webm, avi)." });
  const wid = validateWatermarkId(req.body.watermarkId);
  if (wid.error) {
    fs.rm(req.file.path, { force: true }, () => {});
    return res.status(400).json({ error: wid.error });
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

app.get("/api/videos/:id/download", (req, res) => {
  const v = registry.get(req.params.id);
  if (!v || v.status !== "ready") return res.status(404).json({ error: "Not ready" });
  res.download(path.join(DIRS.outputs, v.output), v.output);
});

app.get("/api/videos/:id/stream", (req, res) => {
  const v = registry.get(req.params.id);
  if (!v || v.status !== "ready") return res.status(404).end();
  res.sendFile(path.join(DIRS.outputs, v.output));
});

app.delete("/api/videos/:id", (req, res) => {
  const v = registry.get(req.params.id);
  if (!v) return res.status(404).json({ error: "Not found" });
  if (v.status === "processing" || v.status === "queued") return res.status(409).json({ error: "Still processing." });
  registry.remove(v.id);
  for (const f of [path.join(DIRS.uploads, v.input), path.join(DIRS.outputs, v.output)]) fs.rm(f, { force: true }, () => {});
  res.json({ ok: true });
});

app.post("/api/detect", uploadImage.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Upload an image (png, jpg, webp)." });
  let crop = null;
  try {
    crop = req.body.crop ? JSON.parse(req.body.crop) : null;
  } catch {}
  try {
    const t0 = Date.now();
    const r = await detectWorker.run("detect", { image: req.file.path, crop });
    const result = matchAgainstRegistry(r.candidates, registry.ready());
    res.json({ ...result, image: { width: r.width, height: r.height }, ms: Date.now() - t0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((err, _req, res, _next) => res.status(400).json({ error: err.message }));

app.listen(PORT, () => console.log(`Video watermark app on http://localhost:${PORT} (loading PixelSeal...)`));
