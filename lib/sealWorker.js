// Manages one long-lived Python PixelSeal process and a FIFO job queue for it.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import path from "node:path";

export class SealWorker extends EventEmitter {
  constructor({ name, python, script, threads }) {
    super();
    this.name = name;
    this.python = python;
    this.script = script;
    this.threads = threads;
    this.ready = false;
    this.pending = new Map(); // id -> { resolve, reject, onProgress }
    this.queue = [];
    this.busy = false;
    this.seq = 0;
    this.start();
  }

  start() {
    this.ready = false;
    this.proc = spawn(this.python, [this.script], {
      cwd: path.dirname(path.dirname(this.script)), // videoseal caches weights in ./ckpts
      env: { ...process.env, SEAL_THREADS: String(this.threads), PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.onLine(line));
    this.proc.stderr.on("data", (d) => process.stderr.write(`[${this.name}] ${d}`));
    this.proc.on("exit", (code) => {
      if (this.stopped) return;
      console.error(`[${this.name}] worker exited with code ${code}, restarting in 2s`);
      this.ready = false;
      for (const p of this.pending.values()) p.reject(new Error("Watermark worker crashed."));
      this.pending.clear();
      this.busy = false;
      setTimeout(() => this.start(), 2000);
    });
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "ready") {
      this.ready = true;
      this.info = { model: msg.model, nbits: msg.nbits, device: msg.device, deviceName: msg.deviceName };
      console.log(`[${this.name}] ready (${msg.model}, ${msg.nbits} bits, ${msg.device}: ${msg.deviceName})`);
      this.emit("ready", this.info);
      this.pump();
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === "progress") {
      p.onProgress?.(msg.progress);
      return;
    }
    this.pending.delete(msg.id);
    this.busy = false;
    if (msg.type === "error") p.reject(new Error(msg.error));
    else p.resolve(msg);
    this.pump();
  }

  stop() {
    this.stopped = true;
    this.proc?.kill("SIGTERM");
  }

  whenReady() {
    return this.ready ? Promise.resolve(this.info) : new Promise((r) => this.once("ready", r));
  }

  run(cmd, args, onProgress) {
    return new Promise((resolve, reject) => {
      const id = `${this.name}-${++this.seq}`;
      this.queue.push({ id, payload: { id, cmd, ...args }, resolve, reject, onProgress });
      this.pump();
    });
  }

  get queued() {
    return this.queue.length + (this.busy ? 1 : 0);
  }

  pump() {
    if (!this.ready || this.busy || this.queue.length === 0) return;
    const job = this.queue.shift();
    this.busy = true;
    this.pending.set(job.id, job);
    this.proc.stdin.write(JSON.stringify(job.payload) + "\n");
  }
}
