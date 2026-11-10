"""
PixelSeal worker. Runs as a long-lived process controlled by the Node server.

Protocol: one JSON object per line on stdin, one JSON object per line on stdout.
  request : {"id": "...", "cmd": "embed" | "detect" | "ping", ...args}
  replies : {"id": "...", "type": "progress", "progress": 0.42}
            {"id": "...", "type": "result", ...}
            {"id": "...", "type": "error", "error": "..."}
Anything that is not protocol output goes to stderr.
"""
import lib.session
import json
import os
import subprocess
import sys
import time
import traceback

import numpy as np

# Let Apple's MPS backend fall back to CPU for any op it lacks instead of raising.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
import torch  # noqa: E402
import torch.nn.functional as F

# Keep stdout clean for the protocol: anything printed by libraries goes to stderr.
PROTO_OUT = sys.stdout
sys.stdout = sys.stderr

torch.set_num_threads(int(os.environ.get("SEAL_THREADS", os.cpu_count() or 4)))

import videoseal  # noqa: E402
from PIL import Image, ImageOps  # noqa: E402

MODEL_NAME = os.environ.get("SEAL_MODEL", "pixelseal")
# On Windows, start ffmpeg/ffprobe without a console. Otherwise they inherit the console of
# the terminal that launched the server, and fail silently at startup once that terminal is closed.
NO_CONSOLE = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
CHUNK = 16  # frames processed per batch


def send(obj):
    try:
        PROTO_OUT.write(json.dumps(obj) + "\n")
        PROTO_OUT.flush()
    except (BrokenPipeError, ValueError):
        # The Node server is gone; nobody can receive results, so stop instead of running orphaned.
        os._exit(0)


def load_model():
    m = videoseal.load(MODEL_NAME)
    m.eval()
    # Embed every frame from its own key frame instead of propagating one key frame
    # over several frames: any single frame (a screenshot) then carries a residual
    # computed for exactly that image.
    m.step_size = 1
    m.chunk_size = CHUNK
    return m


def _self_test_image():
    g = torch.Generator().manual_seed(0)
    yy, xx = torch.meshgrid(torch.linspace(0, 1, 360), torch.linspace(0, 1, 640), indexing="ij")
    base = torch.stack([xx, yy, (xx + yy) / 2])
    return (base * 0.7 + torch.rand(3, 360, 640, generator=g) * 0.3)[None]


def _run_self_test(m, device):
    x = _self_test_image().to(device)
    msg = torch.Generator().manual_seed(1)
    msg = torch.randint(0, 2, (1, NBITS), generator=msg).float()
    with torch.no_grad():
        res = (m.embed(x, msgs=msg, is_video=False)["imgs_w"] - x).cpu()
        bits = (m.detect((x + res.to(device)).clamp(0, 1), is_video=False)["preds"][0, 1:] > 0).float().cpu()
    return res, bits, msg[0]


def pick_device(m):
    """
    SEAL_DEVICE=auto (default) tries cuda, then mps, then cpu. Any GPU must reproduce the
    CPU result on a test image (same bits, near-identical watermark) or it is skipped.
    """
    want = os.environ.get("SEAL_DEVICE", "auto").lower()
    order = ["cuda", "mps", "cpu"] if want == "auto" else [want, "cpu"]
    ref = None
    for dev in order:
        if dev == "cpu":
            return "cpu", "cpu"
        if dev == "cuda" and not torch.cuda.is_available():
            continue
        if dev == "mps" and not torch.backends.mps.is_available():
            continue
        try:
            if ref is None:
                ref = _run_self_test(m.to("cpu"), "cpu")
            res, bits, msg = _run_self_test(m.to(dev), dev)
            diff = (res - ref[0]).abs().max().item()
            ok = torch.isfinite(res).all() and diff < 0.02 and bool((bits == ref[1]).all()) and (bits == msg).float().mean() > 0.95
            if ok:
                name = torch.cuda.get_device_name(0) if dev == "cuda" else "Apple Metal (MPS)"
                return dev, name
            print(f"[device] {dev} failed self-test (max diff {diff:.4f}); skipping", file=sys.stderr)
        except Exception as e:  # driver/op problems -> try the next device
            print(f"[device] {dev} unusable: {e}", file=sys.stderr)
        m.to("cpu")
    return "cpu", "cpu"


model = load_model()
NBITS = int(model.get_random_msg().shape[1])
DEVICE, DEVICE_NAME = pick_device(model)
model.to(DEVICE)
print(f"[device] using {DEVICE} ({DEVICE_NAME})", file=sys.stderr)


# ---------------------------------------------------------------- video helpers
def probe(path):
    cmd = ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]
    # A failure to even start ffprobe (e.g. the PC is out of memory) is transient: retry before blaming the file.
    for attempt in range(3):
        p = subprocess.run(cmd, capture_output=True, text=True, errors="replace", **NO_CONSOLE)
        if p.returncode == 0 or p.stderr.strip():
            break
        print(f"[probe] ffprobe exited with {p.returncode:#x} and no message; retrying", file=sys.stderr)
        time.sleep(1 + attempt)
    if p.returncode != 0:
        detail = p.stderr.strip().splitlines()[-1] if p.stderr.strip() else (
            f"ffprobe could not run (exit code {p.returncode:#x}); the computer may be low on memory")
        raise ValueError(f"This file could not be read as a video. ({detail})")
    info = json.loads(p.stdout)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if v is None:
        raise ValueError("No video stream found in the uploaded file.")
    has_audio = any(s["codec_type"] == "audio" for s in info["streams"])

    w, h = int(v["width"]), int(v["height"])
    rotation = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(float(sd["rotation"]))
    if "rotate" in (v.get("tags") or {}):
        rotation = int(v["tags"]["rotate"])
    if abs(rotation) % 180 == 90:  # ffmpeg auto-rotates on decode
        w, h = h, w
    w, h = w - (w % 2), h - (h % 2)  # yuv420p needs even dimensions

    num, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den) if float(den) else 30.0
    if not (1 <= fps <= 240):
        fps = 30.0
    fps_str = v.get("avg_frame_rate") if v.get("avg_frame_rate", "0/0") != "0/0" else f"{fps:.3f}"

    # Colour matrix used to turn the source YUV into RGB. Untagged HD video is BT.709 by convention.
    cs = (v.get("color_space") or "").lower()
    matrix = {"bt709": "bt709", "smpte170m": "bt601", "bt470bg": "bt601", "bt2020nc": "bt2020",
              "bt2020c": "bt2020", "smpte240m": "smpte240m"}.get(cs, "bt709" if h >= 720 else "bt601")
    rng = "pc" if v.get("color_range") == "pc" else "tv"
    vfr = (v.get("r_frame_rate") or "") != (v.get("avg_frame_rate") or "")

    duration = float(v.get("duration") or info["format"].get("duration") or 0)
    nb = int(v.get("nb_frames") or 0) or int(round(duration * fps)) or 1
    return {"w": w, "h": h, "fps": fps, "fps_str": fps_str, "frames": nb, "has_audio": has_audio,
            "matrix": matrix, "range": rng, "vfr": vfr}


def to_tensor(frames_u8):
    # Frames go to the model's device: the library runs attenuation on the input's device.
    t = torch.from_numpy(np.ascontiguousarray(frames_u8).copy()).to(DEVICE)
    return t.permute(0, 3, 1, 2).float().div_(255.0)


def to_u8(t):
    return t.clamp(0, 1).mul(255.0).round().byte().permute(0, 2, 3, 1).contiguous().cpu().numpy()


def bits_tensor(bits_str):
    if len(bits_str) != NBITS or set(bits_str) - {"0", "1"}:
        raise ValueError(f"Message must be {NBITS} bits.")
    return torch.tensor([[int(c) for c in bits_str]], dtype=torch.float32)


# Exact rounding in colour conversion; the default rounding darkens every pixel by ~0.8 levels.
SWS = "bicubic+accurate_rnd+full_chroma_int+full_chroma_inp"

# Output colour: always BT.709, limited range, and tagged so players do not guess.
ENC_COLOR = ["-vf", "scale=out_color_matrix=bt709:out_range=tv:flags=" + SWS + ",format=yuv420p,"
             "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
             "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]


def decode_filter(info):
    return (f"scale={info['w']}:{info['h']}:in_color_matrix={info['matrix']}:in_range={info['range']}"
            f":flags={SWS},format=rgb24")


def set_mode(mode):
    """
    smooth : temporal pooling in the U-Net (groups of 4 frames share the deep features)
             plus residual smoothing in still areas. Less shimmer, ~2.4x faster,
             slightly lower robustness on hard screenshots (measured ~3 points of bit accuracy).
    robust : every frame gets a fully independent watermark. Strongest, slowest, more shimmer.
    """
    u = model.embedder.unet
    if mode == "robust":
        u.time_pooling = False
    else:
        u.time_pooling = True
        u.time_pooling_depth = 1
        u.temporal_pool.kernel_size = 4
        u.temporal_pool.stride = 4
    model.step_size = 1


class StillAreaSmoother:
    """Blend each frame's watermark residual with the previous one where the picture is not moving."""

    def __init__(self, keep=0.8, thresh=3 / 255):
        self.keep, self.thresh = keep, thresh
        self.prev_x = self.prev_res = None

    def __call__(self, x, res):
        for n in range(len(x)):
            if self.prev_x is not None and self.prev_x.shape == x[n].shape:
                motion = (x[n] - self.prev_x).abs().mean(0, keepdim=True)[None]
                motion = F.max_pool2d(F.avg_pool2d(motion, 9, 1, 4), 9, 1, 4)[0]
                w = self.keep * (1 - (motion / self.thresh).clamp(0, 1))
                res[n] = w * self.prev_res + (1 - w) * res[n]
            self.prev_x, self.prev_res = x[n], res[n]
        return res


def cmd_embed(req):
    src, dst = req["input"], req["output"]
    msg = bits_tensor(req["bits"])
    strength = float(req.get("strength", 0.4))
    crf = int(req.get("crf", 16))
    mode = req.get("mode", "smooth")
    model.blender.scaling_w = strength
    set_mode(mode)
    smoother = StillAreaSmoother() if mode != "robust" else None

    info = probe(src)
    w, h = info["w"], info["h"]
    # Only resample timing for variable-frame-rate sources; otherwise keep frames 1:1.
    timing = ["-fps_mode", "cfr", "-r", info["fps_str"]] if info["vfr"] else ["-fps_mode", "passthrough"]
    decoder = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", src, "-map", "0:v:0", "-vf", decode_filter(info), *timing,
         "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:"],
        stdout=subprocess.PIPE, **NO_CONSOLE,
    )
    enc_cmd = ["ffmpeg", "-v", "error", "-y",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", info["fps_str"], "-i", "pipe:"]
    if info["has_audio"]:
        enc_cmd += ["-i", src, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]
    enc_cmd += [*ENC_COLOR, "-c:v", "libx264", "-preset", "slow", "-crf", str(crf),
                "-movflags", "+faststart", dst]
    encoder = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE, **NO_CONSOLE)

    frame_bytes = w * h * 3
    buf, done = [], 0

    def flush():
        nonlocal done
        x = to_tensor(np.stack(buf))
        res = model.embed(x, msgs=msg, is_video=True)["imgs_w"] - x
        if smoother is not None:
            res = smoother(x, res)
        encoder.stdin.write(to_u8(x + res).tobytes())
        done += len(buf)
        buf.clear()
        send({"id": req["id"], "type": "progress", "progress": min(done / info["frames"], 0.99)})

    try:
        while True:
            raw = decoder.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            buf.append(np.frombuffer(raw, np.uint8).reshape(h, w, 3))
            if len(buf) == CHUNK:
                flush()
        if buf:
            flush()
    finally:
        decoder.stdout.close()
        decoder.wait()
        encoder.stdin.close()
        rc = encoder.wait()
    if rc != 0:
        raise RuntimeError("ffmpeg failed to encode the watermarked video.")
    if done == 0:
        raise RuntimeError("Could not decode any frames from the video.")

    # Self-check: read back a few frames of the encoded output and decode the message.
    check = verify_video(dst, info, msg)
    return {"frames": done, "width": w, "height": h, "fps": info["fps"], "mode": mode, "self_check_bit_acc": check}


def verify_video(path, info, msg, n=8):
    w, h = info["w"], info["h"]
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-frames:v", str(n),
         "-vf", f"scale=in_color_matrix=bt709:in_range=tv:flags={SWS},format=rgb24", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:"],
        capture_output=True, check=True, **NO_CONSOLE,
    )
    frames = np.frombuffer(p.stdout, np.uint8)
    k = len(frames) // (w * h * 3)
    if k == 0:
        return None
    frames = frames[: k * w * h * 3].reshape(k, h, w, 3)
    preds = model.detect(to_tensor(frames), is_video=False)["preds"][:, 1:].cpu()
    acc = ((preds > 0).float() == msg).float().mean().item()
    return round(acc, 4)


# ---------------------------------------------------------------- image helpers
def _runs(active, max_gap):
    """Contiguous runs of True, bridging gaps of up to max_gap False entries."""
    runs, start, gap = [], None, 0
    for i, on in enumerate(active):
        if on:
            if start is None:
                start = i
            gap, end = 0, i
        elif start is not None:
            gap += 1
            if gap > max_gap:
                runs.append((start, end))
                start, gap = None, 0
    if start is not None:
        runs.append((start, end))
    return runs


def video_regions(arr, flat_std=6.0, max_regions=3):
    """
    Find rectangles in a screenshot that look like video content.

    App UI is mostly flat colour and thin text lines; a video frame is a tall block of
    textured rows. Rows (then columns) whose pixel spread is below flat_std count as
    background; the tallest textured blocks are returned as [x, y, w, h].
    """
    g = arr.astype(np.float32).mean(axis=2)
    H, W = g.shape
    row_active = g.std(axis=1) > flat_std
    boxes = []
    for y0, y1 in _runs(row_active, max_gap=max(2, H // 100)):
        h = y1 - y0 + 1
        if h < max(64, 0.08 * H):
            continue
        block = g[y0: y1 + 1]
        col_runs = _runs(block.std(axis=0) > flat_std, max_gap=max(2, W // 100))
        if not col_runs:
            continue
        x0, x1 = max(col_runs, key=lambda r: r[1] - r[0])
        w = x1 - x0 + 1
        if w < max(64, 0.2 * W):
            continue
        boxes.append([int(x0), int(y0), int(w), int(h)])
    boxes.sort(key=lambda b: b[2] * b[3], reverse=True)
    # Drop a region that is essentially the whole image (the "full" candidate covers it).
    return [b for b in boxes[:max_regions] if b[2] * b[3] < 0.97 * W * H]


def cmd_detect(req):
    img = Image.open(req["image"])
    img = img.convert("RGB")
    arr = np.asarray(img)
    candidates = [("full", arr, None)]
    for x, y, w, h in video_regions(arr):
        candidates.append(("auto-region", arr[y: y + h, x: x + w], [x, y, w, h]))
    if req.get("crop"):
        x, y, cw, ch = [int(v) for v in req["crop"]]
        if cw > 16 and ch > 16:
            candidates.append(("manual-crop", arr[y: y + ch, x: x + cw], [x, y, cw, ch]))

    out = []
    for name, a, b in candidates:
        t = to_tensor(np.ascontiguousarray(a)[None])
        preds = model.detect(t, is_video=False)["preds"][0, 1:].cpu()
        out.append({
            "variant": name,
            "box": b,
            "size": [int(a.shape[1]), int(a.shape[0])],
            "bits": "".join("1" if v > 0 else "0" for v in preds.tolist()),
            "confidence": round(float(preds.abs().mean()), 4),
        })
    return {"width": int(arr.shape[1]), "height": int(arr.shape[0]), "candidates": out}


# ---------------------------------------------------------------- still images (product photos)
MAX_IMAGE_PIXELS = 50_000_000  # about 8660x5770; larger photos are refused rather than risking memory


def open_image(path):
    try:
        img = Image.open(path)
        img.load()
    except Image.DecompressionBombError:
        raise ValueError("This image is too large to watermark.")
    except Exception:
        raise ValueError("This file could not be read as an image.")
    return img


def cmd_embed_image(req):
    """Watermark one still image. PNG output stays lossless; anything else is saved as JPEG quality 95, 4:4:4."""
    src, dst = req["input"], req["output"]
    msg = bits_tensor(req["bits"])
    model.blender.scaling_w = float(req.get("strength", 0.4))
    model.embedder.unet.time_pooling = False  # a single frame: no pooling across frames

    img = open_image(src)
    icc = img.info.get("icc_profile")
    img = ImageOps.exif_transpose(img)  # phone photos store rotation in EXIF; bake it in
    if img.width * img.height > MAX_IMAGE_PIXELS:
        raise ValueError(f"This image is too large to watermark (max {MAX_IMAGE_PIXELS // 1_000_000} megapixels).")
    if img.width < 32 or img.height < 32:
        raise ValueError("This image is too small to watermark (min 32x32 pixels).")

    as_png = dst.lower().endswith(".png")
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    alpha = img.convert("RGBA").getchannel("A") if (has_alpha and as_png) else None
    rgb = np.asarray(img.convert("RGB"))

    x = to_tensor(rgb[None])
    with torch.no_grad():
        out = to_u8(model.embed(x, msgs=msg, is_video=False)["imgs_w"])[0]
    res = Image.fromarray(out, "RGB")
    if alpha is not None:
        res.putalpha(alpha)
    extra = {"icc_profile": icc} if icc else {}
    if as_png:
        res.save(dst, "PNG", optimize=True, **extra)
    else:
        res.save(dst, "JPEG", quality=95, subsampling=0, optimize=True, **extra)

    # Self-check: read the saved file back, as a viewer would, and decode the message.
    back = np.asarray(Image.open(dst).convert("RGB"))
    with torch.no_grad():
        preds = model.detect(to_tensor(back[None]), is_video=False)["preds"][0, 1:].cpu()
    acc = ((preds > 0).float() == msg[0]).float().mean().item()
    return {"width": int(rgb.shape[1]), "height": int(rgb.shape[0]), "format": "png" if as_png else "jpeg",
            "self_check_bit_acc": round(acc, 4)}


HANDLERS = {"embed": cmd_embed, "embed_image": cmd_embed_image, "detect": cmd_detect, "ping": lambda r: {"model": MODEL_NAME, "nbits": NBITS, "device": DEVICE}}

send({"type": "ready", "model": MODEL_NAME, "nbits": NBITS, "device": DEVICE, "deviceName": DEVICE_NAME})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = {}
    try:
        req = json.loads(line)
        result = HANDLERS[req["cmd"]](req)
        send({"id": req.get("id"), "type": "result", **result})
    except Exception as e:  # report and keep serving
        traceback.print_exc()
        # ValueError means the input itself is unusable (the caller's fault), anything else is ours.
        send({"id": req.get("id"), "type": "error", "error": str(e), "bad_input": isinstance(e, ValueError)})
