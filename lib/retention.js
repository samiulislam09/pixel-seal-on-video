// Watermarked video files are removed from disk after a retention period to save space. The
// registry record (and its watermark bits) stays, so screenshots of the video are still recognised.
// Images are small and kept.
import { isVideo } from "./images.js";

const DAY_MS = 24 * 3600 * 1000;

/** VIDEO_RETENTION_DAYS: whole days to keep a watermarked video file (default 30); 0 keeps them forever. */
export function retentionDays(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return 30;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 30;
}

/** Ready videos whose watermarked file is older than `days` and still on disk. */
export function videosToExpire(videos, now, days) {
  return videos.filter((v) => {
    if (!isVideo(v) || v.status !== "ready" || v.fileDeletedAt) return false;
    const since = Date.parse(v.completedAt ?? v.createdAt ?? "");
    return Number.isFinite(since) && now - since > days * DAY_MS;
  });
}

/** The 410 message for a removed file; `days` is the retention in force when it was removed. */
export function expiredMessage(days) {
  const after = days ? `after ${days} day${days === 1 ? "" : "s"}` : "after its storage period";
  return `The watermarked file was removed ${after}. Screenshots of it are still recognised.`;
}
