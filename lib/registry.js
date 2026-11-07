// Tiny JSON-file registry of watermarked videos and the 256-bit message each one carries.
import fs from "node:fs";
import path from "node:path";

export class Registry {
  constructor(file) {
    this.file = file;
    this.backup = file + ".bak";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.videos = this.load();
  }

  load() {
    const text = fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : "";
    if (text.trim() === "") {
      // Empty file: fall back to the last good backup if there is one.
      const bak = this.readBackup();
      if (bak) console.warn(`[registry] ${this.file} was empty; restored ${bak.length} videos from ${this.backup}`);
      return bak ?? [];
    }
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error("registry is not a list");
      return data;
    } catch (e) {
      // Never overwrite a damaged registry: it holds the only copy of each video's watermark ID.
      const kept = `${this.file}.corrupt-${Date.now()}`;
      fs.copyFileSync(this.file, kept);
      const bak = this.readBackup();
      console.warn(`[registry] ${this.file} is unreadable (${e.message}); kept a copy at ${kept}` +
        (bak ? `, restored ${bak.length} videos from backup` : ", starting empty"));
      return bak ?? [];
    }
  }

  readBackup() {
    try {
      const data = JSON.parse(fs.readFileSync(this.backup, "utf8"));
      return Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.videos, null, 2));
    if (fs.existsSync(this.file) && fs.statSync(this.file).size > 0) fs.copyFileSync(this.file, this.backup);
    fs.renameSync(tmp, this.file);
  }
  add(v) {
    this.videos.unshift(v);
    this.save();
    return v;
  }
  update(id, patch) {
    const v = this.get(id);
    if (v) Object.assign(v, patch);
    this.save();
    return v;
  }
  get(id) {
    return this.videos.find((v) => v.id === id);
  }
  remove(id) {
    const v = this.get(id);
    this.videos = this.videos.filter((x) => x.id !== id);
    this.save();
    return v;
  }
  ready() {
    return this.videos.filter((v) => v.status === "ready");
  }
}
