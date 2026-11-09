# Video Watermark

Invisible watermarking for videos and product photos with Meta's **PixelSeal**, built to recognise
screenshots that clients take of your Facebook posts and send in Messenger.

1. Upload a video. Every frame gets an invisible 256-bit watermark that is unique to that video.
   Optionally give it your own ID; matches then report that ID.
   Photos (PNG, JPG, WebP, BMP) work the same way and are done in about a second.
2. Download the watermarked MP4 or photo and post it on Facebook.
3. Upload or paste a screenshot. The app finds the picture area, extracts the bits and tells you which video or photo it came from.

## Run

```bash
npm run setup   # once: Node packages, Python env in ./pyenv, PixelSeal weights (1.2 GB in ./ckpts)
npm start       # http://localhost:3000
```

Setup is a Node script, so it works the same on Windows, macOS and Linux. It needs Node 18+,
ffmpeg, and Python 3.10 to 3.14 (or conda on an Intel Mac).

### Windows

1. Install Node.js LTS from https://nodejs.org.
2. Install Python 3.12 from https://www.python.org/downloads/windows/ and tick **"Add python.exe to PATH"**.
3. Install ffmpeg: `winget install Gyan.FFmpeg`. If you skip this, setup installs it for you with winget.
   ffmpeg is found even when it is not on PATH yet; you can also point to it with `FFMPEG_DIR`.
4. Open a **new** terminal (so PATH updates apply) in the project folder, then run `npm run setup` and `npm start`.

With an NVIDIA graphics card, setup installs a CUDA build of PyTorch and checks that the GPU works,
falling back to CPU otherwise. Keep the NVIDIA driver up to date.

**Moving from another computer:** do not copy `pyenv/` or `node_modules/`, they only work on the machine that built them.
Copy `ckpts/` to skip the 1.2 GB download, and copy `data/` (registry and secret key) so existing videos are still recognised.

`PORT`, `SEAL_PYTHON`, `SEAL_MODEL` (default `pixelseal`) and `SEAL_DEVICE` can be set as env vars.

## Hosting from this computer (Cloudflare Tunnel)

The app runs on this PC (for the GPU) and Cloudflare Tunnel makes it reachable over HTTPS, with no port forwarding.
Watermarked videos are downloaded from this PC through the tunnel.

```powershell
winget install Cloudflare.cloudflared                                         # once
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1        # start at sign-in
Start-ScheduledTask -TaskName "Video Watermark Host"                           # start now
```

`scripts\host.ps1` (run by that task) starts the app and the tunnel, and restarts either within about 20 s if it stops.
Logs: `storage\host.log`, `storage\server.log`, `storage\tunnel.log`. To stop everything: end the task in Task Scheduler,
then end `node` (`server.js`) and `cloudflared` in Task Manager. Remove auto-start with `scripts\install-autostart.ps1 -Remove`.

**Address.** Without configuration you get a free quick tunnel: a random `https://….trycloudflare.com` address, written to
`storage\public-url.txt`, that **changes whenever the tunnel restarts** (reboot, crash, network loss). Fine for testing. For a fixed address:

1. Add your domain to a free Cloudflare account.
2. Cloudflare dashboard → Zero Trust → Networks → Tunnels → *Create a tunnel* (Cloudflared) and copy its token.
3. Under *Public hostname*, add e.g. `watermark.example.com` → service `http://localhost:3000`.
4. Put `CLOUDFLARE_TUNNEL_TOKEN=<token>` in `.env`, end the running `cloudflared`, and the supervisor reconnects with the named tunnel.

**Limits and notes.**
- Cloudflare's free plan accepts requests up to **100 MB**, so larger videos cannot be uploaded through the tunnel.
- Requests through the tunnel always need the API key (the localhost exemption ignores anything carrying proxy headers such as `CF-Connecting-IP`).
- The task runs while you are signed in to Windows (no administrator rights needed). The API is offline while the PC sleeps or is off; set Windows to never sleep.

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
| Registry | `data/videos.json` | Which 256-bit message belongs to which video or photo (photos have `kind: "image"`). **Back this up**: without it, screenshots cannot be traced. |

Two workers run: one for video jobs, one for screenshot checks and photos, so both stay fast while a video is processing.

## API

**Interactive documentation:** open `http://localhost:3000/docs` (Swagger UI) to read every endpoint, field and the webhook,
and try requests from the browser. The OpenAPI 3.1 spec is at `/openapi.json` (import it into Postman, Insomnia or a client generator)
and is defined in `lib/openapi.js`; update it there when the API changes.

Settings go in a `.env` file next to `server.js` (copy `.env.example`) or in environment variables.

### Authentication

Every `/api` request needs the API key:

```
Authorization: Bearer <key>        (or  X-API-Key: <key>)
```

The key is `API_KEY` if set, otherwise the one generated in `data/api.key` on first start.
Requests from the computer running the server (the web page) need no key. If a reverse proxy on the
same machine forwards internet traffic to the app, make sure it sets `X-Forwarded-For`, or set `TRUST_LOCALHOST=false`.

### Endpoints

| Method | Path | |
|---|---|---|
| POST | `/api/videos` | multipart `video`, optional `watermarkId` (up to 64 characters, unique), `strength` (0.05 to 1, default 0.4), `mode` (`smooth` or `robust`) and `callbackUrl`. Returns the video record (202). |
| GET | `/api/videos`, `/api/videos/:id` | List, or poll one video |
| POST | `/api/videos/reserve` | JSON `watermarkId`, `link`, `fileName`, `sizeBytes` (up to 2 GB), optional `callbackUrl`. Creates a record with `stage` `awaiting_upload` (201); the file is uploaded afterwards. `link` is `{type:"product",productId,variantId?,note?}`, `{type:"knowledge",knowledgeTitle,note?}` or `{type:"note",note}` (note up to 1000 characters) |
| PATCH | `/api/videos/:id` | JSON `{ link }`: change what the video is linked to |
| POST | `/api/videos/:id/retry` | Run a `failed` video again (202). 409 with `code: "original_gone"` if the original was already removed (kept 7 days after the failure; the record is reset to `awaiting_upload`), or `code: "not_failed"` with the current `stage` if the video is not failed |
| GET | `/api/videos/:id/download` | Watermarked MP4 from this server. The file is kept: download it as often as you like |
| PUT | `/api/uploads/:videoId/chunks/:index?pass=` | Browser upload: raw body, one 50 MB piece (the last may be smaller), authorised by an upload pass (signed with the API key, 1 h) instead of the key. Same index again overwrites it. 400 if the index is out of range |
| GET | `/api/uploads/:videoId?pass=` | Resume: `{ chunkBytes, total, received: [indexes] }` |
| POST | `/api/uploads/:videoId/complete?pass=` | Join the pieces and start watermarking (202). 409 `{ missing }` if pieces are missing, 400 if the size or extension is wrong |
| GET | `/api/videos/:id/file?pass=` | Download the watermarked MP4 with a download pass (10 min), as often as needed |
| DELETE | `/api/videos/:id` | Remove the video and its watermark record |
| POST | `/api/images` | multipart `image` (png, jpg, jpeg, webp, bmp; up to 50 MB and 50 megapixels), optional `watermarkId`, `strength` and `link` (a link object as JSON). Watermarks within the request and returns the record with `stage` `completed` and `downloadUrl` (201). 400 for an unreadable image or bad field |
| GET | `/api/images`, `/api/images/:id` | List, or get one image |
| GET | `/api/images/:id/download` | Watermarked image. PNG and BMP come back as PNG (transparency kept), JPEG and WebP as JPEG quality 95. The file is kept |
| PATCH | `/api/images/:id` | JSON `{ link }`: change what the image is linked to |
| DELETE | `/api/images/:id` | Remove the image and its watermark record |
| POST | `/api/detect` | multipart `image`, optional `crop` as `[x,y,w,h]` JSON, optional `scope` (for example `s22`: only compare with videos and photos whose watermark ID starts with `s22-`; anything not like `s22` or `w1a2b3c4d` gives 400). Returns `verdict` (`match`, `weak`, `none`), `video` (the matched video or photo; its `kind` is `video` or `image`), `bitAccuracy`, `log10FalsePositive` |
| GET | `/api/status` | Model, device, queue length |

**Video file retention.** Watermarked video files are deleted `VIDEO_RETENTION_DAYS` (default 30, `0` = never) after they finish, checked every 6 hours. The record and its watermark stay, so screenshots are still recognised; downloads then answer 410 `code: file_expired` and the record shows `fileDeletedAt`. Images are kept.

Pass routes answer 401 `{ error, reason }` for a bad or expired pass and 409 when the video is in the wrong state. Browsers may call them only from origins listed in `CORS_ORIGINS`.

`/api/detect` is the endpoint your chatbot can call with images received in Messenger.

Videos and photos share one registry: a watermark ID can be used once across both, and every record carries `kind`.
The `/api/videos` routes only see videos and the `/api/images` routes only see photos.

### Video lifecycle

Read `stage` on a video record:

| `stage` | Meaning |
|---|---|
| `awaiting_upload` | Reserved with `/api/videos/reserve`, no file yet |
| `queued`, `processing` | Waiting for, or being watermarked (`progress` 0 to 1) |
| `completed` | Done. Download it (any number of times) from `/api/videos/:id/download` |
| `failed` | Watermarking failed, see `error`. Use `/api/videos/:id/retry` within 7 days |

Lifecycle: `awaiting_upload` → `queued` → `processing` → `completed` or `failed`.

### Example

```bash
curl -H "Authorization: Bearer $KEY" \
  -F watermarkId=CLIENT-42 \
  -F callbackUrl=https://yourapp.example.com/hooks/watermark \
  -F video=@clip.mp4 \
  http://your-server:3000/api/videos
# -> {"id":"7e9f7fbb34ae","stage":"queued",...}

curl -H "Authorization: Bearer $KEY" http://your-server:3000/api/videos/7e9f7fbb34ae
# -> {"stage":"completed",...}

curl -H "Authorization: Bearer $KEY" -OJ http://your-server:3000/api/videos/7e9f7fbb34ae/download
# saves clip-watermarked-7e9f7fbb34ae.mp4; the server then deletes its copy
```

### Webhook

With `callbackUrl`, the server POSTs JSON when the video reaches `completed` or `failed`:

```json
{ "event": "video.completed", "video": { "id": "...", "stage": "completed", "watermarkId": "CLIENT-42", ... } }
```

`event` is `video.completed` or `video.failed`. Failed deliveries (non-2xx or no answer within 15 s) are retried
after 2 s, 10 s, 30 s and 2 min. The outcome is stored in the record's `webhook` field.
Verify a delivery by checking the `X-Signature` header, which is `sha256=` + hex HMAC-SHA256 of the raw body with the API key:

```js
const expected = "sha256=" + crypto.createHmac("sha256", API_KEY).update(rawBody).digest("hex");
```

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
