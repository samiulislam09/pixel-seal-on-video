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
| POST | `/api/videos` | multipart `video`, optional `watermarkId` (up to 64 characters, unique), `strength` (0.05 to 1, default 0.4), `mode` (`smooth` or `robust`) and `callbackUrl`. **Send text fields before the file.** Returns the video record (202). |
| GET | `/api/videos`, `/api/videos/:id` | List, or poll one video |
| GET | `/api/videos/:id/download` | Watermarked MP4 from this server |
| POST | `/api/videos/:id/upload` | Retry a failed S3 upload, or upload a video made before S3 was set up |
| DELETE | `/api/videos/:id` | Remove the video, its watermark record and its S3 copy |
| POST | `/api/detect` | multipart `image`, optional `crop` as `[x,y,w,h]` JSON. Returns `verdict` (`match`, `weak`, `none`), `video`, `bitAccuracy`, `log10FalsePositive` |
| GET | `/api/status` | Model, device, queue length, S3 settings |

`/api/detect` is the endpoint your chatbot can call with images received in Messenger.

### Video lifecycle

Read `stage` and `url` on a video record:

| `stage` | Meaning |
|---|---|
| `queued`, `processing` | Waiting for, or being watermarked (`progress` 0 to 1) |
| `uploading` | Copying to S3 (`upload.progress` 0 to 1) |
| `completed` | Done. `url` is the public download link (null when S3 is off) |
| `failed` | Watermarking failed, see `error` |
| `upload_failed` | Watermarked, but the S3 upload failed (see `upload.error`). Fix it and call `POST /api/videos/:id/upload` |

### Example

```bash
curl -H "Authorization: Bearer $KEY" \
  -F watermarkId=CLIENT-42 \
  -F callbackUrl=https://yourapp.example.com/hooks/watermark \
  -F video=@clip.mp4 \
  http://your-server:3000/api/videos
# -> {"id":"7e9f7fbb34ae","stage":"queued","url":null,...}

curl -H "Authorization: Bearer $KEY" http://your-server:3000/api/videos/7e9f7fbb34ae
# -> {"stage":"completed","url":"https://bucket.s3.region.amazonaws.com/watermarked/clip-watermarked-7e9f7fbb34ae.mp4",...}
```

### Webhook

With `callbackUrl`, the server POSTs JSON when the video reaches `completed`, `failed` or `upload_failed`:

```json
{ "event": "video.completed", "video": { "id": "...", "stage": "completed", "url": "https://...", "watermarkId": "CLIENT-42", ... } }
```

`event` is `video.completed` or `video.failed`. Failed deliveries (non-2xx or no answer within 15 s) are retried
after 2 s, 10 s, 30 s and 2 min. The outcome is stored in the record's `webhook` field.
Verify a delivery by checking the `X-Signature` header, which is `sha256=` + hex HMAC-SHA256 of the raw body with the API key:

```js
const expected = "sha256=" + crypto.createHmac("sha256", API_KEY).update(rawBody).digest("hex");
```

### S3 setup

1. Create a bucket. Under **Permissions**, turn off *Block public access* for bucket policies (keep ACLs disabled).
2. Add a bucket policy so anyone can download from the upload folder:
   ```json
   { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Principal": "*",
     "Action": "s3:GetObject", "Resource": "arn:aws:s3:::YOUR-BUCKET/watermarked/*" }] }
   ```
3. Create an IAM user with only `s3:PutObject` and `s3:DeleteObject` on `arn:aws:s3:::YOUR-BUCKET/watermarked/*`, and an access key for it.
4. Set `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in `.env`, then restart. The startup log shows `S3 uploads: on`.

Optional: `S3_PREFIX` (folder, default `watermarked/`), `S3_PUBLIC_BASE_URL` (links on CloudFront or your own domain),
`S3_ENDPOINT` (S3-compatible services such as Cloudflare R2). Files are served with `Content-Disposition: attachment`, so browsers download them.
The local copy in `storage/outputs` is kept after upload.

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
