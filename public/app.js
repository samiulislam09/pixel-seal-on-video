const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const mb = (n) => (n ? `${(n / 1048576).toFixed(1)} MB` : "");

let ready = false;
let videoFile = null;
let imageFile = null;
let crop = null; // [x, y, w, h] in natural image pixels

// ------------------------------------------------------------------ status
async function pollStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    ready = s.embedReady && s.detectReady;
    const el = $("#status");
    const dev = s.device === "cpu" ? "CPU" : `GPU: ${s.deviceName}`;
    el.textContent = ready ? `${s.model} ready · ${dev}${s.queue ? ` · ${s.queue} in queue` : ""}` : "Loading model…";
    el.title = s.device === "cpu" ? "No usable GPU found; running on CPU" : "";
    el.classList.toggle("ok", ready);
  } catch {
    $("#status").textContent = "Server offline";
  }
  updateButtons();
}
function updateButtons() {
  $("#videoBtn").disabled = !(ready && videoFile);
  $("#imgBtn").disabled = !(ready && imageFile);
}

// ------------------------------------------------------------------ drop zones
function wireDrop(zone, input, onFile) {
  input.addEventListener("change", () => input.files[0] && onFile(input.files[0]));
  zone.addEventListener("dragover", (e) => (e.preventDefault(), zone.classList.add("over")));
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
}

wireDrop($("#videoDrop"), $("#videoInput"), (f) => {
  videoFile = f;
  $("#videoDrop").classList.add("has");
  $("#videoDrop strong").textContent = f.name;
  $("#videoDrop small").textContent = `${mb(f.size)} · click to change`;
  updateButtons();
});

wireDrop($("#imgDrop"), $("#imgInput"), setImage);
document.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) setImage(new File([item.getAsFile()], "pasted-screenshot.png", { type: item.type }));
});

function setImage(f) {
  imageFile = f;
  crop = null;
  $("#cropBox").classList.add("hidden");
  $("#foundBox").classList.add("hidden");
  $("#result").innerHTML = "";
  $("#imgDrop").classList.add("has");
  $("#imgDrop strong").textContent = f.name;
  $("#preview").src = URL.createObjectURL(f);
  $("#previewWrap").classList.remove("hidden");
  updateButtons();
}

$("#strength").addEventListener("input", (e) => ($("#strengthVal").textContent = Number(e.target.value).toFixed(2)));

// ------------------------------------------------------------------ upload video
$("#videoBtn").addEventListener("click", () => {
  if (!videoFile) return;
  const fd = new FormData();
  fd.append("strength", $("#strength").value);
  fd.append("mode", $("#mode").value);
  fd.append("watermarkId", $("#watermarkId").value.trim());
  fd.append("video", videoFile);
  const xhr = new XMLHttpRequest();
  const bar = $("#uploadBar");
  bar.classList.remove("hidden");
  $("#videoBtn").disabled = true;
  xhr.upload.onprogress = (e) => e.lengthComputable && (bar.firstElementChild.style.width = `${(100 * e.loaded) / e.total}%`);
  xhr.onload = () => {
    bar.classList.add("hidden");
    bar.firstElementChild.style.width = "0";
    if (xhr.status >= 300) alert(JSON.parse(xhr.responseText || "{}").error || "Upload failed");
    else $("#watermarkId").value = "";
    loadVideos();
    updateButtons();
  };
  xhr.onerror = () => (alert("Upload failed"), bar.classList.add("hidden"), updateButtons());
  xhr.open("POST", "/api/videos");
  xhr.send(fd);
});

// ------------------------------------------------------------------ video list
const openPreviews = new Set();
async function loadVideos() {
  const list = await (await fetch("/api/videos")).json();
  const ul = $("#videos");
  if (!list.length) return (ul.innerHTML = `<li class="empty">Nothing yet.</li>`);
  ul.innerHTML = list.map(renderVideo).join("");
  const busy = list.some((v) => ["queued", "processing", "uploading"].includes(v.stage));
  clearTimeout(loadVideos.t);
  if (busy) loadVideos.t = setTimeout(loadVideos, 1500);
}

function renderVideo(v) {
  let status = "";
  if (v.status === "ready") {
    const sc = v.selfCheck != null ? `${(v.selfCheck * 100).toFixed(1)}% self-check` : "ready";
    status = `<span class="tag ${v.selfCheck >= 0.95 ? "ok" : "bad"}">${sc}</span>`;
    if (v.stage === "uploading") status += `<span class="tag">uploading ${Math.round((v.upload.progress || 0) * 100)}%</span>`;
    else if (v.stage === "upload_failed") status += `<span class="tag bad" title="${esc(v.upload.error)}">upload failed</span>`;
  } else if (v.status === "failed") status = `<span class="tag bad">failed</span>`;
  else status = `<span class="tag">${v.status === "queued" ? "queued" : `${Math.round(v.progress * 100)}%`}</span>`;
  const link = v.url
    ? `<div class="meta">Public link <a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.url)}</a></div>`
    : v.stage === "upload_failed" ? `<div class="meta">${esc(v.upload.error)}</div>` : "";

  const meta =
    v.status === "ready"
      ? `${v.width}×${v.height} · ${v.frames} frames · ${v.mode === "robust" ? "max robustness" : "smooth"} · strength ${v.strength} · ${mb(v.sizeOut)} · ${v.seconds}s to process`
      : v.status === "failed"
        ? esc(v.error)
        : `strength ${v.strength} · watermarking every frame…`;

  const bar = v.status === "processing" || v.status === "queued" ? `<div class="bar"><div style="width:${v.progress * 100}%"></div></div>` : "";
  const actions =
    v.status === "ready"
      ? `<a class="btn" href="/api/videos/${v.id}/download">Download</a>
         ${v.url ? `<button class="ghost" onclick="copyLink('${v.id}', this)">Copy link</button>` : ""}
         ${v.stage === "upload_failed" ? `<button class="ghost" onclick="retryUpload('${v.id}')">Retry upload</button>` : ""}
         <button class="ghost" onclick="togglePreview('${v.id}')">${openPreviews.has(v.id) ? "Hide" : "Preview"}</button>
         ${v.stage === "uploading" ? "" : `<button class="ghost" onclick="delVideo('${v.id}')">Delete</button>`}`
      : v.status === "failed"
        ? `<button class="ghost" onclick="delVideo('${v.id}')">Delete</button>`
        : "";
  const preview = openPreviews.has(v.id) ? `<video src="/api/videos/${v.id}/stream" controls playsinline></video>` : "";
  return `<li class="vid" id="v-${v.id}">
    <div class="top"><span class="name" title="${esc(v.name)}">${esc(v.name)}</span>${status}</div>
    ${v.watermarkId ? `<div class="meta">ID <span class="wid">${esc(v.watermarkId)}</span></div>` : ""}
    <div class="meta">${meta}</div>${link}${bar}
    ${actions ? `<div class="actions">${actions}</div>` : ""}${preview}
  </li>`;
}

window.togglePreview = (id) => (openPreviews.has(id) ? openPreviews.delete(id) : openPreviews.add(id), loadVideos());
window.copyLink = async (id, btn) => {
  const v = (await (await fetch(`/api/videos/${id}`)).json());
  await navigator.clipboard.writeText(v.url);
  btn.textContent = "Copied";
};
window.retryUpload = async (id) => {
  const res = await fetch(`/api/videos/${id}/upload`, { method: "POST" });
  if (!res.ok) alert((await res.json()).error || "Retry failed");
  loadVideos();
};
window.delVideo = async (id) => {
  if (!confirm("Delete this video, its watermark record and its public S3 copy? Screenshots of it will no longer be recognised.")) return;
  await fetch(`/api/videos/${id}`, { method: "DELETE" });
  loadVideos();
};

// ------------------------------------------------------------------ crop box
(() => {
  const stage = $("#stage");
  const img = $("#preview");
  const box = $("#cropBox");
  let start = null;
  const pos = (e) => {
    const r = img.getBoundingClientRect();
    return { x: Math.min(Math.max(e.clientX - r.left, 0), r.width), y: Math.min(Math.max(e.clientY - r.top, 0), r.height) };
  };
  stage.addEventListener("pointerdown", (e) => {
    start = pos(e);
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!start) return;
    const p = pos(e);
    Object.assign(box.style, {
      left: `${Math.min(start.x, p.x)}px`, top: `${Math.min(start.y, p.y)}px`,
      width: `${Math.abs(p.x - start.x)}px`, height: `${Math.abs(p.y - start.y)}px`,
    });
    box.classList.remove("hidden");
  });
  stage.addEventListener("pointerup", (e) => {
    if (!start) return;
    const p = pos(e);
    const r = img.getBoundingClientRect();
    const sx = img.naturalWidth / r.width;
    const sy = img.naturalHeight / r.height;
    const w = Math.abs(p.x - start.x), h = Math.abs(p.y - start.y);
    crop = w > 10 && h > 10 ? [Math.min(start.x, p.x) * sx, Math.min(start.y, p.y) * sy, w * sx, h * sy].map(Math.round) : null;
    if (!crop) box.classList.add("hidden");
    start = null;
  });
  $("#clearCrop").addEventListener("click", (e) => (e.preventDefault(), (crop = null), box.classList.add("hidden")));
})();

function showFoundBox(b) {
  const el = $("#foundBox");
  if (!b) return el.classList.add("hidden");
  const img = $("#preview");
  const r = img.getBoundingClientRect();
  const sx = r.width / img.naturalWidth, sy = r.height / img.naturalHeight;
  Object.assign(el.style, { left: `${b[0] * sx}px`, top: `${b[1] * sy}px`, width: `${b[2] * sx}px`, height: `${b[3] * sy}px` });
  el.classList.remove("hidden");
}

// ------------------------------------------------------------------ detect
const VARIANT = { full: "whole image", "auto-region": "auto-detected video area", "manual-crop": "your selected box" };
const odds = (l) => (l <= -15 ? "less than 1 in 10¹⁵" : `about 1 in ${Math.round(10 ** -l).toLocaleString()}`);

$("#imgBtn").addEventListener("click", async () => {
  if (!imageFile) return;
  const fd = new FormData();
  fd.append("image", imageFile);
  if (crop) fd.append("crop", JSON.stringify(crop));
  $("#imgBtn").disabled = true;
  $("#imgBtn").textContent = "Checking…";
  try {
    const res = await fetch("/api/detect", { method: "POST", body: fd });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error || "Detection failed");
    renderResult(r);
  } catch (e) {
    $("#result").innerHTML = `<div class="verdict err"><h4>Error</h4><p>${esc(e.message)}</p></div>`;
  } finally {
    $("#imgBtn").textContent = "Check for watermark";
    updateButtons();
  }
});

function renderResult(r) {
  showFoundBox(r.verdict !== "none" && r.variant !== "full" ? r.box : null);
  if (r.bitAccuracy == null) {
    $("#result").innerHTML = `<div class="verdict none"><h4>Nothing to compare against</h4><p>${esc(r.reason)}</p></div>`;
    return;
  }
  const acc = `${(r.bitAccuracy * 100).toFixed(1)}%`;
  const head =
    r.verdict === "match"
      ? `<h4>Watermark found</h4><p>${r.video.watermarkId ? `ID <span class="wid">${esc(r.video.watermarkId)}</span> · ` : ""}This screenshot comes from <b>${esc(r.video.name)}</b>.</p>`
      : r.verdict === "weak"
        ? `<h4>Possible match</h4><p>Weak signal for ${r.video.watermarkId ? `ID <span class="wid">${esc(r.video.watermarkId)}</span>, ` : ""}<b>${esc(r.video.name)}</b>. Try a less cropped screenshot or draw a box around the video.</p>`
        : `<h4>No watermark found</h4><p>The closest registered video only agrees on ${acc} of bits, which is what a random image gives.</p>`;
  const detail = r.verdict === "none" ? "" :
    `<p>${r.matchedBits} of ${r.nbits} bits match (${acc}), using the ${VARIANT[r.variant]}. Chance this is a false match: ${odds(r.log10FalsePositive)}.</p>`;
  const rows = r.candidates
    .map((c) => `<tr><td>${VARIANT[c.variant]}</td><td class="num">${c.size.join("×")}</td><td class="num">${c.bestAgree != null ? ((100 * c.bestAgree) / r.nbits).toFixed(1) + "%" : "—"}</td><td class="num">${c.confidence}</td></tr>`)
    .join("");
  $("#result").innerHTML = `<div class="verdict ${r.verdict}">${head}${detail}</div>
    <table><thead><tr><th>Region tried</th><th>Size</th><th>Best bit match</th><th>Signal</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">Random images score about 50%. A real watermark usually scores above 75%. Checked in ${r.ms} ms.</p>`;
}

pollStatus();
setInterval(pollStatus, 3000);
loadVideos();
