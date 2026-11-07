# Video Watermark

Invisible watermarking for videos with Meta's **PixelSeal**, built to recognise
screenshots that clients take of your Facebook videos and send in Messenger.

1. Upload a video. Every frame gets an invisible 256-bit watermark that is unique to that video.
   Optionally give it your own ID; matches then report that ID.
2. Download the watermarked MP4 and post it on Facebook.
3. Upload or paste a screenshot. The app finds the video area, extracts the bits and tells you which video it came from.

## Run

```bash
npm run setup   # once: Node packages, Python env in ./pyenv, PixelSeal weights (1.2 GB in ./ckpts)
npm start       # http://localhost:3000
```

Setup is a Node script, so it works the same on Windows, macOS and Linux. It needs Node 18+,
ffmpeg, and Python 3.10 to 3.13 (or conda on an Intel Mac).

### Windows

1. Install Node.js LTS from https://nodejs.org.
2. Install Python 3.12 from https://www.python.org/downloads/windows/ and tick **"Add python.exe to PATH"**.
3. Install ffmpeg: `winget install Gyan.FFmpeg`
4. Open a **new** terminal (so PATH updates apply) in the project folder, then run `npm run setup` and `npm start`.

With an NVIDIA graphics card, setup installs a CUDA build of PyTorch and checks that the GPU works,
falling back to CPU otherwise. Keep the NVIDIA driver up to date.

**Moving from another computer:** do not copy `pyenv/` or `node_modules/`, they only work on the machine that built them.
Copy `ckpts/` to skip the 1.2 GB download, and copy `data/` (registry and secret key) so existing videos are still recognised.

`PORT`, `SEAL_PYTHON`, `SEAL_MODEL` (default `pixelseal`) and `SEAL_DEVICE` can be set as env vars.

## GPU

The worker picks a device at startup: NVIDIA CUDA first, then Apple Silicon (MPS), then CPU.
Each GPU must reproduce the CPU result on a test image (same 256 bits, near-identical watermark)
before it is used; otherwise the worker logs why and falls back to CPU. The page header shows the device in use.
Force a choice with `SEAL_DEVICE=cuda`, `mps` or `cpu`.

Intel Macs report MPS as available, but it fails because it needs Apple Silicon's unified memory,
so they run on CPU. On a Linux server, install a CUDA build of PyTorch: pip's default Linux wheels include CUDA, and
conda-forge picks a CUDA build when it detects an NVIDIA driver. `npm run setup` prints whether CUDA is available.

## How it fits together

| Part | File | Job |
|---|---|---|
| Web page | `public/` | Upload, progress, download, screenshot check (drop, pick or paste) |
| Server | `server.js` | Express API, uploads, job queue, registry |
| Model worker | `worker/seal_worker.py` | Long-running PixelSeal process; Node talks to it with JSON lines over stdin/stdout |
| Matching | `lib/match.js` | Compares extracted bits with every registered video and computes false-match odds |
| Secret | `data/secret.key` | Turns a custom watermark ID into its 256 bits (HMAC-SHA256), so nobody else can compute the watermark for an ID. Created on first start. |
| Registry | `data/videos.json` | Which 256-bit message belongs to which video. **Back this up**: without it, screenshots cannot be traced. |

Two workers run: one for video jobs, one for screenshot checks, so checks stay fast while a video is processing.

## API

| Method | Path | |
|---|---|---|
| POST | `/api/videos` | multipart `video`, optional `watermarkId` (up to 64 characters, unique), `strength` (0.05 to 1, default 0.4) and `mode` (`smooth` or `robust`). Send text fields before the file. Returns the job; poll it. |
| GET | `/api/videos`, `/api/videos/:id` | List or poll status and progress |
| GET | `/api/videos/:id/download` | Watermarked MP4 |
| DELETE | `/api/videos/:id` | Remove video and its watermark record |
| POST | `/api/detect` | multipart `image`, optional `crop` as `[x,y,w,h]` JSON. Returns `verdict` (`match`, `weak`, `none`), `video`, `bitAccuracy`, `log10FalsePositive` |

`/api/detect` is the endpoint your chatbot can call with images received in Messenger.

## Measured results

Test: a 1080p clip, watermarked at strength 0.4, re-encoded to 720p at 1.5 Mbit/s (Facebook-like),
pasted into a simulated phone screenshot with app UI, downscaled and saved as JPEG quality 70.

| Screenshot | Bits matching | Verdict |
|---|---|---|
| Plain screenshot | 94.5% | match |
| Play button and progress bar over the video | 80.9% | match |
| Video zoomed or cropped to 70% | 84.0% | match |
| Same video without watermark | 53.1% | no match |

A random image matches about 50% of bits. "Match" requires the false-match chance to be under
one in a million after accounting for how many videos are registered.

Things that matter:

- **Strength.** At 0.2 (PixelSeal's default) the plain screenshot only reached about 73%. 0.4 is the default here.
- **Two modes.** *Smooth* (default) shares the deep U-Net features across groups of 4 frames (PixelSeal's temporal pooling)
  and smooths the watermark in still areas. It has about 55% less shimmer, is 2.4x faster, and loses about 3 points of bit accuracy
  on hard screenshots. *Max robustness* computes every frame independently.
- **Do not skip frames.** Propagating one key frame over 4 frames dropped screenshot accuracy from 93% to 77%.
- **Colour handling.** Decoding uses the source's colour matrix, the output is tagged BT.709, and conversions use exact
  rounding. Without this, colours shifted toward magenta and every pixel came out about 0.8 levels darker.
- **Finding the video area is essential.** The whole phone screenshot scores at chance; the app auto-detects the textured video block. If it picks the wrong area, drag a box around the video before checking.
- **Heavy crops are the weak point.** Below about half the frame, expect misses.

## Speed

On an Intel i9 CPU, Smooth mode takes about 0.65 s per frame and Max robustness about 1.1 s per frame, including encoding.
A 1-minute 30 fps video takes about 20 minutes in Smooth mode. The embedder runs at 256x256 internally, so cost barely depends on resolution. A machine with an
NVIDIA GPU is roughly 50 to 100 times faster. Screenshot checks take about 0.5 s.

## Notes for this Mac

PyTorch stopped publishing pip wheels for Intel Macs after 2.2, and videoseal needs 2.3 or newer, so setup uses
conda-forge PyTorch. The videoseal package is installed without its training-only dependencies, and its
`configs/` folder is copied into the installed package because the wheel leaves it out.
