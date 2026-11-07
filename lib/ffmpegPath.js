// Find ffmpeg + ffprobe even when they are not on PATH (common on Windows right after
// installing, because open terminals keep their old PATH).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";
const exe = (name) => (WIN ? `${name}.exe` : name);

function runs(cmd) {
  const r = spawnSync(cmd, ["-version"], { encoding: "utf8", windowsHide: true });
  return r.status === 0;
}

function dirHasBoth(dir) {
  return (
    dir &&
    fs.existsSync(path.join(dir, exe("ffmpeg"))) &&
    fs.existsSync(path.join(dir, exe("ffprobe"))) &&
    runs(path.join(dir, exe("ffmpeg"))) &&
    runs(path.join(dir, exe("ffprobe")))
  );
}

const safeList = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
};

// winget unpacks FFmpeg zips into Packages\Gyan.FFmpeg_<id>\ffmpeg-<version>-<build>\bin
function wingetPackageBins(packagesDir) {
  const bins = [];
  for (const pkg of safeList(packagesDir).filter((p) => /ffmpeg/i.test(path.basename(p)))) {
    bins.push(path.join(pkg, "bin"));
    for (const inner of safeList(pkg)) bins.push(path.join(inner, "bin"));
  }
  return bins;
}

function candidateDirs() {
  if (!WIN) return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"];
  const env = process.env;
  const local = env.LOCALAPPDATA || "";
  const pf = env.ProgramFiles || "C:\\Program Files";
  const user = env.USERPROFILE || "";
  return [
    path.join(local, "Microsoft", "WinGet", "Links"),
    ...wingetPackageBins(path.join(local, "Microsoft", "WinGet", "Packages")),
    path.join(pf, "WinGet", "Links"),
    ...wingetPackageBins(path.join(pf, "WinGet", "Packages")),
    path.join(env.ChocolateyInstall || "C:\\ProgramData\\chocolatey", "bin"),
    path.join(user, "scoop", "shims"),
    path.join(user, "scoop", "apps", "ffmpeg", "current", "bin"),
    "C:\\ffmpeg\\bin",
    path.join(pf, "ffmpeg", "bin"),
    path.join(user, "ffmpeg", "bin"),
  ];
}

/**
 * Returns { dir, onPath } when both tools are usable, otherwise { missing: [...] }.
 * dir is the folder to add to PATH (null when they already run from PATH).
 * FFMPEG_DIR overrides the search.
 */
export function locateFfmpeg() {
  if (process.env.FFMPEG_DIR) {
    if (dirHasBoth(process.env.FFMPEG_DIR)) return { dir: process.env.FFMPEG_DIR, onPath: false };
  }
  const onPath = { ffmpeg: runs("ffmpeg"), ffprobe: runs("ffprobe") };
  if (onPath.ffmpeg && onPath.ffprobe) return { dir: null, onPath: true };
  for (const dir of candidateDirs()) if (dirHasBoth(dir)) return { dir, onPath: false };
  return { missing: Object.entries(onPath).filter(([, ok]) => !ok).map(([name]) => name) };
}

// Make ffmpeg visible to this process and every child it starts (the Python workers).
export function addToPath(dir) {
  if (!dir) return;
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  process.env[key] = dir + path.delimiter + (process.env[key] || "");
}
