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
const passParam = { name: "pass", in: "query", required: true, description: "Signed pass issued by the XChat backend.", schema: { type: "string" } };
const videoIdParam = { name: "videoId", in: "path", required: true, schema: { type: "string", example: "7e9f7fbb34ae" } };
const unauthorized = { $ref: "#/components/responses/Unauthorized" };
const notFound = errorResponse("No video with this id.");
const imageResponse = (description) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Image" } } },
});
const imageIdParam = { name: "id", in: "path", required: true, description: "Image id returned by `POST /api/images`.", schema: { type: "string", example: "a41c09d2e7b3" } };
const imageNotFound = errorResponse("No image with this id.");

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Video Watermark API",
    version: "1.0.0",
    description: [
      "Invisible PixelSeal watermarks for videos and images (product photos), with detection from screenshots.",
      "",
      "**Flow:** upload a video with `POST /api/videos` → it is watermarked → `stage` becomes `completed` → download it with `GET /api/videos/{id}/download` (as often as you like; the file is kept until you delete the video).",
      "A caller can first reserve a record with `POST /api/videos/reserve` (`stage` `awaiting_upload`). A failed job keeps its original for 7 days; `POST /api/videos/{id}/retry` runs it again.",
      "Learn about completion by polling `GET /api/videos/{id}`, or by passing a `callbackUrl` (see **Webhooks** below).",
      "",
      "**Images:** `POST /api/images` watermarks a photo within the request (about a second) and returns it already `completed`; download it from `downloadUrl`.",
      "Videos and images share one watermark ID space, and `POST /api/detect` matches screenshots against both.",
      "",
      "**Authentication:** send `Authorization: Bearer <key>` (or `X-API-Key: <key>`). The key is `API_KEY`, or the one generated in `data/api.key`.",
      "Requests from the computer running the server need no key, so *Try it out* works here without authorizing.",
    ].join("\n"),
  },
  servers: [{ url: "/", description: "This server" }],
  security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
  tags: [
    { name: "Videos", description: "Watermark and download videos" },
    { name: "Images", description: "Watermark and download images (product photos)" },
    { name: "Detection", description: "Find which video or image a screenshot came from" },
    { name: "Server", description: "Health and configuration" },
  ],

  paths: {
    "/api/videos": {
      post: {
        tags: ["Videos"],
        summary: "Upload a video to watermark",
        description:
          "Starts a watermarking job and returns at once (202). Follow it with `GET /api/videos/{id}` or a `callbackUrl`.\n\n" +
          "Text fields can come before or after the `video` file in the multipart body. " +
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
                  video: { type: "string", format: "binary", description: "The video file." },
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

    "/api/videos/reserve": {
      post: {
        tags: ["Videos"],
        summary: "Reserve a video record before uploading the file",
        description: "Creates a record with `stage` `awaiting_upload` and the watermark bits for `watermarkId`. The file is uploaded afterwards.",
        operationId: "reserveVideo",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["watermarkId", "link", "fileName", "sizeBytes"],
                properties: {
                  watermarkId: { type: "string", maxLength: 64, example: "s22-k7f3qa9m" },
                  link: { $ref: "#/components/schemas/Link" },
                  fileName: { type: "string", example: "clip.mp4" },
                  sizeBytes: { type: "integer", maximum: 2147483648, example: 10485760 },
                  callbackUrl: { type: "string", format: "uri" },
                },
              },
            },
          },
        },
        responses: { 201: videoResponse("Reserved. `stage` is `awaiting_upload`."), 400: errorResponse("Invalid field."), 401: unauthorized },
      },
    },

    "/api/videos/{id}/retry": {
      parameters: [idParam],
      post: {
        tags: ["Videos"],
        summary: "Run a failed job again",
        description: "Only for `failed` videos whose original file is still on the server (kept 7 days after the failure).",
        operationId: "retryVideo",
        responses: {
          202: videoResponse("Queued again."),
          401: unauthorized,
          404: notFound,
          409: {
            description:
              "`code: not_failed`: the video is not `failed` (its current `stage` is returned; the record is not changed). " +
              "`code: original_gone`: the original is no longer on the server; the failed record is reset to `awaiting_upload` so the video can be uploaded again.",
            content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/Error" }, { type: "object", properties: { code: { enum: ["not_failed", "original_gone"] }, stage: { type: "string", description: "Only with `not_failed`." } } }] } } },
          },
        },
      },
    },

    "/api/videos/{id}": {
      parameters: [idParam],
      patch: {
        tags: ["Videos"],
        summary: "Change what a video is linked to",
        operationId: "updateVideoLink",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["link"], properties: { link: { $ref: "#/components/schemas/Link" } } } } },
        },
        responses: { 200: videoResponse("The updated video."), 400: errorResponse("Invalid link."), 401: unauthorized, 404: notFound },
      },
      get: {
        tags: ["Videos"],
        summary: "Get one video (poll this)",
        description: "Poll every few seconds until `stage` is `completed` or `failed`.",
        operationId: "getVideo",
        responses: { 200: videoResponse("The video."), 401: unauthorized, 404: notFound },
      },
      delete: {
        tags: ["Videos"],
        summary: "Delete a video",
        description:
          "Removes the files on this server and the watermark record. " +
          "**Screenshots of this video are no longer recognised afterwards.**",
        operationId: "deleteVideo",
        responses: {
          200: { description: "Deleted.", content: { "application/json": { schema: { type: "object", properties: { ok: { const: true } } } } } },
          401: unauthorized,
          404: notFound,
          409: errorResponse("Still processing, or the upload is being finished."),
        },
      },
    },

    "/api/videos/{id}/download": {
      parameters: [idParam],
      get: {
        tags: ["Videos"],
        summary: "Download the watermarked MP4 from this server",
        description:
          "Sent as an attachment. The file is kept, so it can be downloaded any number of times.",
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
        description: "Same file as `/download`, served for playback (supports range requests). Playing it does not change it.",
        operationId: "streamVideo",
        responses: {
          200: { description: "The MP4 file.", content: { "video/mp4": { schema: { type: "string", format: "binary" } } } },
          206: { description: "Partial content for a range request." },
          401: unauthorized,
          404: { description: "Unknown id, or the video is not watermarked yet (empty body)." },
        },
      },
    },

    "/api/uploads/{videoId}/chunks/{index}": {
      put: {
        tags: ["Browser upload"],
        summary: "Upload one piece (50 MB) with an upload pass",
        description: "Authorised by `?pass=` (upload pass signed with the API key, valid 1 h), not the key. Send the raw bytes. The same index again overwrites it. CORS: origins in `CORS_ORIGINS`.",
        operationId: "putChunk",
        security: [],
        parameters: [passParam, videoIdParam, { name: "index", in: "path", required: true, schema: { type: "integer", minimum: 0 } }],
        requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
        responses: { 200: { description: "Stored." }, 400: errorResponse("Index out of range, or empty body."), 401: errorResponse("Bad or expired pass (`reason`)."), 409: errorResponse("Video is not `awaiting_upload`.") },
      },
    },
    "/api/uploads/{videoId}": {
      get: {
        tags: ["Browser upload"],
        summary: "Which pieces are already here (resume)",
        operationId: "uploadProgress",
        security: [],
        parameters: [passParam, videoIdParam],
        responses: { 200: { description: "`{ chunkBytes, total, received: number[] }`." }, 401: errorResponse("Bad or expired pass."), 409: errorResponse("Video is not `awaiting_upload`.") },
      },
    },
    "/api/uploads/{videoId}/complete": {
      post: {
        tags: ["Browser upload"],
        summary: "Join the pieces and start watermarking",
        operationId: "completeUpload",
        security: [],
        parameters: [passParam, videoIdParam],
        responses: { 202: videoResponse("Queued."), 400: errorResponse("Assembled size differs from the reserved size, or not a video extension."), 401: errorResponse("Bad or expired pass."), 409: errorResponse("Pieces are missing (`missing`), the upload is being finished (`code: finishing`), or the video is not `awaiting_upload` (`status` and `stage` give its current state)."), 410: errorResponse("The video was deleted while the upload was being finished (`code: deleted`).") },
      },
    },
    "/api/videos/{id}/file": {
      parameters: [idParam],
      get: {
        tags: ["Browser upload"],
        summary: "Download the watermarked MP4 with a download pass",
        description: "Authorised by `?pass=` (download pass, valid 10 min). Can be used any number of times.",
        operationId: "downloadWithPass",
        security: [],
        parameters: [passParam],
        responses: { 200: { description: "The MP4 file.", content: { "video/mp4": { schema: { type: "string", format: "binary" } } } }, 401: errorResponse("Bad or expired pass."), 404: errorResponse("Unknown id, or the file is missing."), 409: errorResponse("Video is not `completed`."), 410: errorResponse("The watermarked file was removed after `VIDEO_RETENTION_DAYS` (`code: file_expired`). Screenshots of it are still recognised.") },
      },
    },

    "/api/images": {
      post: {
        tags: ["Images"],
        summary: "Watermark an image",
        description:
          "Watermarks the image within the request and returns the record with `stage` `completed` (201). There is no queue and no webhook.\n\n" +
          "Accepted: png, jpg, jpeg, webp, bmp; max 50 MB and 50 megapixels. PNG and BMP come back as PNG (transparency kept); " +
          "JPEG and WebP come back as JPEG quality 95. EXIF rotation is applied. The uploaded original is not kept.",
        operationId: "createImage",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["image"],
                properties: {
                  watermarkId: { type: "string", maxLength: 64, description: "Your own label, returned when a screenshot matches. Unique across videos and images (case-insensitive). Empty = random watermark.", example: "s22-p9x2" },
                  strength: { type: "number", minimum: 0.05, maximum: 1, default: 0.4, description: "Higher survives compression and screenshots better but may become faintly visible in flat areas." },
                  link: { type: "string", description: "Optional. A `Link` object as JSON.", example: "{\"type\":\"product\",\"productId\":12}" },
                  image: { type: "string", format: "binary", description: "The image file." },
                },
              },
              encoding: { image: { contentType: "image/*" } },
            },
          },
        },
        responses: {
          201: imageResponse("Watermarked. `stage` is `completed`."),
          400: errorResponse("No image, unsupported type, unreadable or too large/small image, ID already used, or invalid `link`."),
          401: unauthorized,
          500: errorResponse("Watermarking failed on the server."),
        },
      },
      get: {
        tags: ["Images"],
        summary: "List all images",
        description: "Newest first.",
        operationId: "listImages",
        responses: {
          200: { description: "All images.", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Image" } } } } },
          401: unauthorized,
        },
      },
    },

    "/api/images/{id}": {
      parameters: [imageIdParam],
      get: { tags: ["Images"], summary: "Get one image", operationId: "getImage", responses: { 200: imageResponse("The image."), 401: unauthorized, 404: imageNotFound } },
      patch: {
        tags: ["Images"],
        summary: "Change what an image is linked to",
        operationId: "updateImageLink",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["link"], properties: { link: { $ref: "#/components/schemas/Link" } } } } },
        },
        responses: { 200: imageResponse("The updated image."), 400: errorResponse("Invalid link."), 401: unauthorized, 404: imageNotFound },
      },
      delete: {
        tags: ["Images"],
        summary: "Delete an image",
        description: "Removes the file and the watermark record. **Screenshots of this image are no longer recognised afterwards.**",
        operationId: "deleteImage",
        responses: {
          200: { description: "Deleted.", content: { "application/json": { schema: { type: "object", properties: { ok: { const: true } } } } } },
          401: unauthorized,
          404: imageNotFound,
          409: errorResponse("Still processing."),
        },
      },
    },

    "/api/images/{id}/download": {
      parameters: [imageIdParam],
      get: {
        tags: ["Images"],
        summary: "Download the watermarked image",
        description: "Sent as an attachment. The file is kept, so it can be downloaded any number of times.",
        operationId: "downloadImage",
        responses: {
          200: { description: "The image.", content: { "image/png": { schema: { type: "string", format: "binary" } }, "image/jpeg": { schema: { type: "string", format: "binary" } } } },
          401: unauthorized,
          404: errorResponse("Unknown id, or the file is missing."),
        },
      },
    },

    "/api/detect": {
      post: {
        tags: ["Detection"],
        summary: "Check a screenshot for a watermark",
        description:
          "Tries the whole image, auto-detected picture areas, and your `crop` if given, and compares the bits with every completed video and image. " +
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
                  scope: {
                    type: "string",
                    description: "Optional. Compare only with videos and images whose watermark ID starts with this scope (for example `s22` for `s22-k7f3qa9m`). Another value gives 400.",
                    example: "s22",
                  },
                  crop: {
                    type: "string",
                    description: "Optional box around the video area, as JSON `[x, y, width, height]` in image pixels.",
                    example: "[40, 310, 1000, 562]",
                  },
                  image: { type: "string", format: "binary", description: "png, jpg, jpeg, webp or bmp; max 50 MB. Deleted from this server after the check." },
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
          400: errorResponse("No image, unsupported type, or invalid scope."),
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
          "Sent once a video reaches `completed` or `failed`.\n\n" +
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

      Link: {
        description: "What the video is about. A product (optionally one variant), a knowledge document by title, or a free note. `note` is up to 1000 characters.",
        oneOf: [
          { type: "object", required: ["type", "productId"], properties: { type: { const: "product" }, productId: { type: "integer" }, variantId: { type: "integer" }, note: { type: "string", maxLength: 1000 } } },
          { type: "object", required: ["type", "knowledgeTitle"], properties: { type: { const: "knowledge" }, knowledgeTitle: { type: "string" }, note: { type: "string", maxLength: 1000 } } },
          { type: "object", required: ["type", "note"], properties: { type: { const: "note" }, note: { type: "string", maxLength: 1000 } } },
        ],
      },

      Stage: {
        type: "string",
        enum: ["awaiting_upload", "queued", "processing", "completed", "failed"],
        description: "Where the video is. `awaiting_upload` (reserved, no file yet) → `queued` → `processing` → `completed` (ready to download). `failed`: watermarking failed (see `error`).",
      },

      Video: {
        type: "object",
        properties: {
          id: { type: "string", example: "7e9f7fbb34ae" },
          kind: { const: "video" },
          stage: { $ref: "#/components/schemas/Stage" },
          name: { type: "string", description: "Original file name.", example: "clip.mp4" },
          watermarkId: { type: ["string", "null"], example: "CLIENT-42" },
          callbackUrl: { type: ["string", "null"], format: "uri" },
          link: { $ref: "#/components/schemas/Link" },
          failedAt: { type: "string", format: "date-time", description: "When the job failed. The original is kept 7 days after this." },
          status: {
            type: "string",
            enum: ["awaiting_upload", "queued", "processing", "ready", "failed"],
            description: "Internal status (`ready` = `completed`). Prefer `stage`.",
          },
          progress: { type: "number", minimum: 0, maximum: 1, description: "Watermarking progress." },
          error: { type: "string", description: "Why watermarking failed (when `stage` is `failed`)." },
          strength: { type: "number", example: 0.4 },
          mode: { type: "string", enum: ["smooth", "robust"] },
          createdAt: { type: "string", format: "date-time" },
          sizeIn: { type: "integer", description: "Uploaded file size in bytes." },
          input: { type: ["string", "null"], description: "Stored name of the uploaded file (null until uploaded). Deleted once watermarking succeeds; kept 7 days after a failure." },
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
          webhook: { $ref: "#/components/schemas/WebhookDelivery" },
        },
      },

      Image: {
        type: "object",
        properties: {
          id: { type: "string", example: "a41c09d2e7b3" },
          kind: { const: "image" },
          stage: { type: "string", enum: ["processing", "completed"], description: "`completed` in every response of `POST /api/images`." },
          name: { type: "string", description: "Original file name.", example: "shirt-front.jpg" },
          watermarkId: { type: ["string", "null"], example: "s22-p9x2" },
          link: { $ref: "#/components/schemas/Link" },
          downloadUrl: { type: "string", description: "Where to download the watermarked image (needs the API key).", example: "/api/images/a41c09d2e7b3/download" },
          output: { type: "string", description: "File name of the watermarked image.", example: "shirt-front-watermarked-a41c09d2e7b3.jpg" },
          format: { type: "string", enum: ["png", "jpeg"] },
          width: { type: "integer", example: 2048 },
          height: { type: "integer", example: 2048 },
          strength: { type: "number", example: 0.4 },
          selfCheck: { type: ["number", "null"], description: "Share of watermark bits read back correctly from the saved file. Healthy is ≥ 0.95.", example: 1 },
          sizeIn: { type: "integer", description: "Uploaded file size in bytes." },
          sizeOut: { type: "integer", description: "Watermarked file size in bytes." },
          ms: { type: "integer", description: "Processing time in milliseconds." },
          createdAt: { type: "string", format: "date-time" },
          status: { type: "string", enum: ["processing", "ready"], description: "Internal status (`ready` = `completed`). Prefer `stage`." },
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
          event: { type: "string", enum: ["video.completed", "video.failed"],  },
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
            description: "The matched video or image (null when `verdict` is `none`). Its `kind` says which.",
            oneOf: [{ $ref: "#/components/schemas/Video" }, { $ref: "#/components/schemas/Image" }, { type: "null" }],
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
          videoRetentionDays: { type: "integer", description: "Days a watermarked video file is kept before it is deleted (`VIDEO_RETENTION_DAYS`, default 30; 0 = kept forever). Records stay, so screenshots still match.", example: 30 },
        },
      },
    },
  },
};
