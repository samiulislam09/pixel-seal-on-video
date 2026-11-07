#!/usr/bin/env node
// One-time setup for Windows, macOS and Linux: `npm run setup`.
// Creates ./pyenv with PyTorch + PixelSeal and downloads the model weights (1.2 GB).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envPython } from "./lib/pythonPath.js";
import { locateFfmpeg, addToPath } from "./lib/ffmpegPath.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === "win32";
const VIDEOSEAL_ZIP = "https://github.com/facebookresearch/videoseal/archive/refs/heads/main.zip";
// Newest first. Each is tried only if an NVIDIA GPU is present, and kept only if CUDA then works.
const CUDA_INDEXES = ["cu134", "cu132", "cu130"];
const DEPS = [
  "omegaconf", "einops", "timm==0.9.16", "opencv-python-headless", "av", "pandas", "scipy",
  "scikit-image", "safetensors", "requests", "tqdm", "pytorch_msssim", "PyWavelets", "lpips",
  "pycocotools", "calflops", "transformers", "pillow",
];

const step = (msg) => console.log(`\n==> ${msg}`);
const fail = (msg) => {
  console.error(`\nSetup stopped: ${msg}`);
  process.exit(1);
};

// Run a command, streaming its output. Returns true on success.
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: opts.shell ?? false, ...opts });
  return r.status === 0;
}
// Run quietly and capture stdout; null if the command is missing or fails.
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: ROOT, ...opts });
  return r.status === 0 ? r.stdout.trim() : null;
}
const has = (cmd, args = ["-version"]) => capture(cmd, args) !== null;

// ------------------------------------------------------------------ prerequisites
step("Checking prerequisites");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 18) fail(`Node.js 18 or newer is required (found ${process.versions.node}).`);
let ff = locateFfmpeg();
if (ff.missing && WIN && has("winget", ["--version"])) {
  console.log(`Not found: ${ff.missing.join(" and ")}. Installing FFmpeg with winget...`);
  run("winget", ["install", "--id", "Gyan.FFmpeg", "-e", "--accept-source-agreements", "--accept-package-agreements"]);
  ff = locateFfmpeg(); // finds the new install even though this terminal's PATH is stale
}
if (ff.missing) {
  fail(
    `${ff.missing.join(" and ")} could not be found.\n` +
      (WIN
        ? "  Install it with:  winget install Gyan.FFmpeg\n" +
          "  Or download a build from https://www.gyan.dev/ffmpeg/builds/ , unzip it, and either add its bin\n" +
          "  folder to PATH or set FFMPEG_DIR to that folder (for example  set FFMPEG_DIR=C:\\ffmpeg\\bin ).\n" +
          "  If you already installed it, close and reopen your terminal (and VS Code, if you use its terminal)."
        : process.platform === "darwin"
          ? "  macOS: brew install ffmpeg"
          : "  Linux: sudo apt install ffmpeg  (or your distro's package manager)"),
  );
}
if (ff.dir) {
  addToPath(ff.dir);
  console.log(`ffmpeg found at ${ff.dir} (not on this terminal's PATH; the app finds it automatically).`);
}
console.log("Node.js and ffmpeg found.");

// ------------------------------------------------------------------ node modules
step("Installing Node.js packages");
if (!run(WIN ? "npm.cmd" : "npm", ["install"], { shell: WIN })) fail("npm install failed.");

// ------------------------------------------------------------------ python env
function findSystemPython() {
  // Prefer 3.12; PyTorch and all dependencies have wheels for 3.10 to 3.14.
  const tries = WIN
    ? [["py", ["-3.12"]], ["py", ["-3.13"]], ["py", ["-3.14"]], ["py", ["-3.11"]], ["py", ["-3.10"]], ["python", []], ["python3", []]]
    : [["python3.12", []], ["python3.13", []], ["python3.14", []], ["python3.11", []], ["python3.10", []], ["python3", []], ["python", []]];
  for (const [cmd, pre] of tries) {
    const v = capture(cmd, [...pre, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"]);
    if (!v) continue;
    const [maj, min] = v.split(".").map(Number);
    if (maj === 3 && min >= 10 && min <= 14) return { cmd, pre, version: v };
    console.log(`  Skipping ${cmd} ${pre.join(" ")} (Python ${v}; need 3.10 to 3.14).`);
  }
  return null;
}

step("Preparing the Python environment in ./pyenv");
let py = envPython(ROOT);
if (py) {
  console.log(`Using existing environment: ${py}`);
} else if (process.platform === "darwin" && process.arch === "x64" && has("conda", ["--version"])) {
  // PyTorch stopped publishing pip wheels for Intel Macs; conda-forge still builds them.
  if (!run("conda", ["create", "-y", "-p", path.join(ROOT, "pyenv"), "-c", "conda-forge", "python=3.12", "pytorch", "torchvision"]))
    fail("conda could not create the environment.");
  py = envPython(ROOT);
} else {
  const sys = findSystemPython();
  if (!sys)
    fail(
      "Python 3.10 to 3.14 was not found.\n" +
        (WIN
          ? "  Install Python 3.12 from https://www.python.org/downloads/windows/ and tick\n" +
            '  "Add python.exe to PATH" during installation, then open a NEW terminal.'
          : "  Install Python 3.12 with your package manager."),
    );
  console.log(`Creating a virtual environment with Python ${sys.version}`);
  if (!run(sys.cmd, [...sys.pre, "-m", "venv", path.join(ROOT, "pyenv")])) fail("Could not create the virtual environment.");
  py = envPython(ROOT);
}
if (!py) fail("The Python environment was created but its interpreter could not be found.");
run(py, ["-m", "pip", "install", "--upgrade", "pip"]);
// Large wheels (PyTorch CUDA is over 2 GB) can stall or drop mid-download: give up on a
// silent connection after 60 s and resume interrupted downloads instead of starting over.
const pip = (args) => run(py, ["-m", "pip", "--timeout", "60", "--retries", "10", ...args, ...(args[0] === "install" ? ["--resume-retries", "20"] : [])]);

// ------------------------------------------------------------------ pytorch
step("Installing PyTorch");
const torchInfo = () => capture(py, ["-c", "import torch; print(torch.__version__, torch.cuda.is_available())"]);
const nvidia = has("nvidia-smi", ["-L"]);
if (torchInfo()) {
  console.log(`PyTorch already installed: ${torchInfo()}`);
} else if (nvidia && process.platform !== "darwin") {
  console.log("NVIDIA GPU detected; trying CUDA builds of PyTorch.");
  let ok = false;
  for (const idx of CUDA_INDEXES) {
    console.log(`  Trying ${idx}...`);
    const url = `https://download.pytorch.org/whl/${idx}`;
    if (pip(["install", "--upgrade", "--force-reinstall", "torch", "torchvision", "--index-url", url]) && torchInfo()?.endsWith("True")) {
      ok = true;
      break;
    }
    console.log(`  ${idx} did not give a working GPU. A newer NVIDIA driver may be needed for it.`);
  }
  if (!ok) {
    console.log("Falling back to the CPU build of PyTorch.");
    if (!pip(["install", "--upgrade", "--force-reinstall", "torch", "torchvision"])) fail("PyTorch could not be installed.");
  }
} else if (!pip(["install", "torch", "torchvision"])) {
  fail("PyTorch could not be installed.");
}

// ------------------------------------------------------------------ videoseal + deps
step("Installing PixelSeal (videoseal) and its dependencies");
if (!pip(["install", ...DEPS])) fail("Installing Python dependencies failed.");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "videoseal-"));
const zip = path.join(tmp, "videoseal.zip");
console.log("Downloading videoseal source...");
const res = await fetch(VIDEOSEAL_ZIP);
if (!res.ok) fail(`Download failed (${res.status}) from ${VIDEOSEAL_ZIP}`);
fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
// Python's zipfile does the extraction, so no unzip tool is needed on any platform.
if (!run(py, ["-c", "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zip, tmp]))
  fail("Could not extract the videoseal download.");
const src = fs.readdirSync(tmp).map((d) => path.join(tmp, d)).find((d) => fs.existsSync(path.join(d, "pyproject.toml")));
if (!src) fail("The videoseal download did not contain the expected files.");
// videoseal pins training-only packages (decord, tensorboard); install it without them.
if (!pip(["install", "--no-deps", "--force-reinstall", src])) fail("Installing videoseal failed.");
// The package does not ship configs/ (needed for JND attenuation); copy it next to the package.
const pkg = capture(py, ["-c", "import videoseal, os; print(os.path.dirname(videoseal.__file__))"]);
if (!pkg) fail("videoseal was installed but cannot be imported.");
fs.rmSync(path.join(pkg, "configs"), { recursive: true, force: true });
fs.cpSync(path.join(src, "configs"), path.join(pkg, "configs"), { recursive: true });
fs.rmSync(tmp, { recursive: true, force: true });

// ------------------------------------------------------------------ weights + check
step("Downloading PixelSeal weights (1.2 GB, first time only) and checking the model");
if (!run(py, ["-c", "import videoseal; videoseal.load('pixelseal'); print('PixelSeal loads correctly.')"]))
  fail("PixelSeal could not be loaded.");
console.log(`PyTorch: ${torchInfo()?.replace(/ (True|False)$/, "")}, NVIDIA GPU (CUDA) usable: ${torchInfo()?.endsWith("True") ? "yes" : "no"}`);

console.log("\nSetup complete. Start the app with:  npm start");
