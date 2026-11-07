// OpenAPI 3.1 description of the HTTP API. Served at /openapi.json and rendered by Swagger UI at /docs.
// Keep this in step with server.js when routes or fields change.

const errorResponse = (description) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});
const videoResponse = (description) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Video" } } },
});
const idParam = {
  name: "id",
  in: "path",
  required: true,
  description: "Video id returned by `POST /api/videos`.",
  schema: { type: "string", example: "7e9f7fbb34ae" },
};
const unauthorized = { $ref: "#/components/responses/Unauthorized" };
const notFound = errorResponse("No video with this id.");

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Video Watermark API",
    version: "1.0.0",
    description: [
      "Invisible PixelSeal watermarks for videos, with detection from screenshots.",
      "",
      "**Flow:** upload a video with `POST /api/videos` → it is watermarked → uploaded to S3 → `stage` becomes `completed` and `url` holds the public download link.",
      "Learn about completion by polling `GET /api/videos/{id}`, or by passing a `callbackUrl` (see **Webhooks** below).",
      "",
      "**Authentication:** send `Authorization: Bearer <key>` (or `X-API-Key: <key>`). The key is `API_KEY`, or the one generated in `data/api.key`.",
      "Requests from the computer running the server need no key, so *Try it out* works here without authorizing.",
    ].join("\n"),
  },
  servers: [{ url: "/", description: "This server" }],
  security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
  tags: [
    { name: "Videos", description: "Watermark videos and get their public links" },
    { name: "Detection", description: "Find which video a screenshot came from" },
    { name: "Server", description: "Health and configuration" },
  ],

  paths: {
    "/api/videos": {
      post: {
        tags: ["Videos"],
        summary: "Upload a video to watermark",
        description:
          "Starts a watermarking job and returns at once (202). Follow it with `GET /api/videos/{id}` or a `callbackUrl`.\n\n" +
          "**Send the text fields before the `video` file** in the multipart body; fields after the file are ignored. " +
          "Max 2 GB. Accepted: mp4, mov, m4v, mkv, webm, avi. Audio is kept.",
        operationId: "createVideo",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["video"],
                properties: {
                  watermarkId: {
                    type: "string",
                    maxLength: 64,
                    description: "Your own label for this video, returned when a screenshot matches. Unique (case-insensitive). Empty = random watermark.",
                    example: "CLIENT-42",
                  },
                  strength: {
                    type: "number",
                    minimum: 0.05,
                    maximum: 1,
                    default: 0.4,
                    description: "Higher survives re-encoding and screenshots better but may become faintly visible.",
                  },
                  mode: {
                    type: "string",
                    enum: ["smooth", "robust"],
                    default: "smooth",
                    description: "`smooth`: less shimmer, ~2.4x faster. `robust`: every frame independent, best for heavy crops.",
                  },
                  callbackUrl: {
                    type: "string",
                    format: "uri",
                    description: "http(s) URL that receives the `videoFinished` webhook when the video is completed or fails.",
                    example: "https://yourapp.example.com/hooks/watermark",
                  },
                  video: { type: "string", format: "binary", description: "The video file. Must be the last field." },
                },
              },
              encoding: { video: { contentType: "video/*" } },
            },
          },
        },
        responses: {
          202: videoResponse("Accepted. `stage` is `queued`."),
          400: errorResponse("No video file, unsupported type, ID already used, or invalid `callbackUrl`."),
          401: unauthorized,
        },
      },
      get: {
        tags: ["Videos"],
        summary: "List all videos",
        description: "Newest first.",
        operationId: "listVideos",
        responses: {
          200: {
            description: "All videos.",
            content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Video" } } } },
          },
          401: unauthorized,
        },
      },
    },

    "/api/videos/{id}": {
      parameters: [idParam],
      get: {
        tags: ["Videos"],
        summary: "Get one video (poll this)",
        description: "Poll every few seconds until `stage` is `completed`, `failed` or `upload_failed`.",
        operationId: "getVideo",
        responses: { 200: videoResponse("The video."), 401: unauthorized, 404: notFound },
      },
      delete: {
        tags: ["Videos"],
        summary: "Delete a video",
        description:
          "Removes the files on this server, the S3 copy (its public link stops working) and the watermark record. " +
          "**Screenshots of this video are no longer recognised afterwards.**",
        operationId: "deleteVideo",
        responses: {
          200: { description: "Deleted.", content: { "application/json": { schema: { type: "object", properties: { ok: { const: true } } } } } },
          401: unauthorized,
          404: notFound,
          409: errorResponse("Still processing or uploading."),
        },
      },
    },

    "/api/videos/{id}/upload": {
      parameters: [idParam],
      post: {
        tags: ["Videos"],
        summary: "Retry the S3 upload",
        description:
          "Uploads a watermarked video to S3 again: after `upload_failed`, or for a video made before S3 was configured. " +
          "Returns at once; the `callbackUrl` (if any) is notified again when it finishes.",
        operationId: "uploadVideo",
        responses: {
          202: videoResponse("Upload started. `stage` is `uploading`."),
          400: errorResponse("S3 is not configured on this server."),
          401: unauthorized,
          404: notFound,
          409: errorResponse("Not watermarked yet, or already uploading."),
          410: errorResponse("The watermarked file is no longer on this server."),
        },
      },
    },

    "/api/videos/{id}/download": {
      parameters: [idParam],
      get: {
        tags: ["Videos"],
        summary: "Download the watermarked MP4 from this server",
        description: "Sent as an attachment. Once uploaded, the public `url` on S3 is usually the better link to share.",
        operationId: "downloadVideo",
        responses: {
          200: { description: "The MP4 file.", content: { "video/mp4": { schema: { type: "string", format: "binary" } } } },
          401: unauthorized,
          404: errorResponse("Unknown id, or not watermarked yet."),
        },
      },
    },

    "/api/videos/{id}/stream": {
      parameters: [idParam],
      get: {
        tags: ["Videos"],
        summary: "Play the watermarked MP4",
        description: "Same file as `/download`, served for playback (supports range requests).",
        operationId: "streamVideo",
        responses: {
          200: { description: "The MP4 file.", content: { "video/mp4": { schema: { type: "string", format: "binary" } } } },
          206: { description: "Partial content for a range request." },
          401: unauthorized,
          404: { description: "Unknown id, or not watermarked yet (empty body)." },
        },
      },
    },

    "/api/detect": {
      post: {
        tags: ["Detection"],
        summary: "Check a screenshot for a watermark",
        description:
          "Tries the whole image, auto-detected video areas, and your `crop` if given, and compares the bits with every completed video. " +
          "Takes about 0.5 s. This is the endpoint a chatbot calls with images received from customers.",
        operationId: "detect",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["image"],
                properties: {
                  crop: {
                    type: "string",
                    description: "Optional box around the video area, as JSON `[x, y, width, height]` in image pixels. Send before `image`.",
                    example: "[40, 310, 1000, 562]",
                  },
                  image: { type: "string", format: "binary", description: "png, jpg, jpeg, webp or bmp; max 50 MB." },
                },
              },
              encoding: { image: { contentType: "image/*" } },
            },
          },
        },
        responses: {
          200: {
            description: "Detection result. Check `verdict`.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/DetectResult" } } },
          },
          400: errorResponse("No image, or unsupported type."),
          401: unauthorized,
          500: errorResponse("The image could not be processed."),
        },
      },
    },

    "/api/status": {
      get: {
        tags: ["Server"],
        summary: "Model and server status",
        operationId: "status",
        responses: {
          200: { description: "Status.", content: { "application/json": { schema: { $ref: "#/components/schemas/Status" } } } },
          401: unauthorized,
        },
      },
    },
  },

  webhooks: {
    videoFinished: {
      post: {
        summary: "Sent to your callbackUrl when a video finishes",
        description:
          "Sent once a video reaches `completed`, `failed` or `upload_failed` (and again after a retried upload).\n\n" +
          "Reply with any 2xx within 15 s. Otherwise it is retried after 2 s, 10 s, 30 s and 2 min; the outcome is stored in the video's `webhook` field.\n\n" +
          "**Verify it:** `X-Signature` is `sha256=` + hex HMAC-SHA256 of the raw request body, keyed with the API key:\n\n" +
          "```js\nconst expected = \"sha256=\" + crypto.createHmac(\"sha256\", API_KEY).update(rawBody).digest(\"hex\");\n```",
        parameters: [
          { name: "X-Event", in: "header", required: true, schema: { type: "string", enum: ["video.completed", "video.failed"] } },
          { name: "X-Signature", in: "header", required: true, schema: { type: "string", example: "sha256=5d41402abc4b2a76b9719d911017c592..." } },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookEvent" } } },
        },
        responses: { "2XX": { description: "Received. Any other answer (or none in 15 s) is retried." } },
      },
    },
  },

  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", description: "`Authorization: Bearer <API key>`" },
      apiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key", description: "Alternative to the Bearer header." },
    },
    responses: {
      Unauthorized: errorResponse("Missing or invalid API key."),
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: { error: { type: "string", example: "Upload a video file (mp4, mov, mkv, webm, avi)." } },
      },

      Stage: {
        type: "string",
        enum: ["queued", "processing", "uploading", "completed", "failed", "upload_failed"],
        description:
          "Where the video is. `queued` → `processing` → `uploading` → `completed`.\n" +
          "`failed`: watermarking failed (see `error`). `upload_failed`: watermarked and detectable, but the S3 upload failed " +
          "(see `upload.error`; retry with `POST /api/videos/{id}/upload`). Without S3, a video goes straight from `processing` to `completed`.",
      },

      Video: {
        type: "object",
        properties: {
          id: { type: "string", example: "7e9f7fbb34ae" },
          stage: { $ref: "#/components/schemas/Stage" },
          url: {
            type: ["string", "null"],
            format: "uri",
            description: "Public download link on S3 once `stage` is `completed`. Null before that, or when S3 is off.",
            example: "https://my-bucket.s3.ap-southeast-1.amazonaws.com/watermarked/clip-watermarked-7e9f7fbb34ae.mp4",
          },
          name: { type: "string", description: "Original file name.", example: "clip.mp4" },
          watermarkId: { type: ["string", "null"], example: "CLIENT-42" },
          callbackUrl: { type: ["string", "null"], format: "uri" },
          status: {
            type: "string",
            enum: ["queued", "processing", "ready", "failed"],
            description: "Watermarking status only. Prefer `stage`, which also covers the S3 upload.",
          },
          progress: { type: "number", minimum: 0, maximum: 1, description: "Watermarking progress." },
          error: { type: "string", description: "Why watermarking failed (when `stage` is `failed`)." },
          strength: { type: "number", example: 0.4 },
          mode: { type: "string", enum: ["smooth", "robust"] },
          createdAt: { type: "string", format: "date-time" },
          sizeIn: { type: "integer", description: "Uploaded file size in bytes." },
          input: { type: "string", description: "Stored name of the uploaded file on this server." },
          output: { type: "string", description: "File name of the watermarked MP4.", example: "clip-watermarked-7e9f7fbb34ae.mp4" },
          frames: { type: "integer", example: 1421 },
          width: { type: "integer", example: 1280 },
          height: { type: "integer", example: 720 },
          fps: { type: "number", example: 30 },
          selfCheck: {
            type: ["number", "null"],
            description: "Share of watermark bits read back correctly from the encoded output. Healthy is ≥ 0.95.",
            example: 0.9971,
          },
          sizeOut: { type: "integer", description: "Watermarked file size in bytes." },
          seconds: { type: "integer", description: "Processing time." },
          upload: { $ref: "#/components/schemas/Upload" },
          webhook: { $ref: "#/components/schemas/WebhookDelivery" },
        },
      },

      Upload: {
        type: "object",
        description: "S3 upload state. Absent when S3 is off.",
        properties: {
          status: { type: "string", enum: ["uploading", "done", "failed"] },
          progress: { type: "number", minimum: 0, maximum: 1 },
          key: { type: "string", description: "Object key in the bucket.", example: "watermarked/clip-watermarked-7e9f7fbb34ae.mp4" },
          url: { type: "string", format: "uri" },
          uploadedAt: { type: "string", format: "date-time" },
          error: { type: "string", example: "Access Denied" },
        },
      },

      WebhookDelivery: {
        type: "object",
        description: "Result of the last webhook delivery. Absent without `callbackUrl`.",
        properties: {
          event: { type: "string", enum: ["video.completed", "video.failed"] },
          delivered: { type: "boolean" },
          attempts: { type: "integer", example: 1 },
          status: { type: ["integer", "null"], description: "Last HTTP status from your server; null if unreachable.", example: 200 },
          at: { type: "string", format: "date-time" },
        },
      },

      WebhookEvent: {
        type: "object",
        required: ["event", "video"],
        properties: {
          event: { type: "string", enum: ["video.completed", "video.failed"], description: "`video.failed` covers both `failed` and `upload_failed`." },
          video: { $ref: "#/components/schemas/Video" },
        },
      },

      DetectResult: {
        type: "object",
        properties: {
          verdict: {
            type: "string",
            enum: ["match", "weak", "none"],
            description: "`match`: false-match chance under 1 in a million. `weak`: under 1 in a thousand. `none`: no watermark found.",
          },
          video: {
            description: "The matched video (null when `verdict` is `none`).",
            oneOf: [{ $ref: "#/components/schemas/Video" }, { type: "null" }],
          },
          bitAccuracy: { type: "number", description: "Share of the 256 bits that agree with the best video. Random images score ~0.5.", example: 0.938 },
          matchedBits: { type: "integer", example: 240 },
          nbits: { type: "integer", example: 256 },
          log10FalsePositive: {
            type: "number",
            description: "log10 of the chance this is a false match, corrected for the number of comparisons. -6 = 1 in a million.",
            example: -48.2,
          },
          variant: { type: "string", enum: ["full", "auto-region", "manual-crop"], description: "Which image region gave the best result." },
          box: { type: ["array", "null"], items: { type: "integer" }, minItems: 4, maxItems: 4, description: "That region as [x, y, width, height]." },
          closestVideoId: { type: "string" },
          comparisons: { type: "integer", description: "Regions tried × registered videos." },
          reason: { type: "string", description: "Set when there was nothing to compare against.", example: "No watermarked videos are registered yet." },
          candidates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                variant: { type: "string", enum: ["full", "auto-region", "manual-crop"] },
                box: { type: ["array", "null"], items: { type: "integer" } },
                size: { type: "array", items: { type: "integer" }, description: "[width, height] of the region." },
                confidence: { type: "number", description: "Mean absolute detector output; higher = stronger signal." },
                bestAgree: { type: ["integer", "null"], description: "Bits agreeing with the closest video." },
                bestVideoId: { type: ["string", "null"] },
              },
            },
          },
          image: { type: "object", properties: { width: { type: "integer" }, height: { type: "integer" } } },
          ms: { type: "integer", description: "Processing time." },
        },
      },

      Status: {
        type: "object",
        properties: {
          embedReady: { type: "boolean" },
          detectReady: { type: "boolean" },
          model: { type: ["string", "null"], example: "pixelseal" },
          device: { type: ["string", "null"], enum: ["cuda", "mps", "cpu", null] },
          deviceName: { type: ["string", "null"], example: "NVIDIA GeForce RTX 3050" },
          queue: { type: "integer", description: "Videos waiting or being watermarked." },
          s3: {
            type: ["object", "null"],
            description: "Null when S3 uploads are off.",
            properties: { bucket: { type: "string" }, region: { type: "string" }, prefix: { type: "string" } },
          },
        },
      },
    },
  },
};
