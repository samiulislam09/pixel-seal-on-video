// Upload finished videos to S3 and build their public download URLs.
// Credentials come from the standard AWS chain: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY,
// ~/.aws/credentials, or an instance role.
import fs from "node:fs";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

/** Returns null when S3_BUCKET is not set (uploads disabled). */
export function s3FromEnv(env = process.env) {
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) return null;
  const region = (env.S3_REGION || env.AWS_REGION || "").trim();
  if (!region) throw new Error("S3_BUCKET is set but S3_REGION is missing.");
  const prefix = (env.S3_PREFIX ?? "watermarked/").trim().replace(/^\/+/, "");
  // S3_ENDPOINT is only for S3-compatible services (R2, MinIO, ...); AWS needs nothing here.
  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  const defaultBase = endpoint ? `${endpoint.replace(/\/+$/, "")}/${bucket}` : `https://${bucket}.s3.${region}.amazonaws.com`;
  const base = (env.S3_PUBLIC_BASE_URL?.trim() || defaultBase).replace(/\/+$/, "");
  const client = new S3Client({ region, ...(endpoint && { endpoint, forcePathStyle: true }) });

  return {
    bucket,
    region,
    prefix,
    keyFor: (fileName) => prefix + fileName,
    urlFor: (key) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`,

    async upload(file, key, { downloadName, onProgress } = {}) {
      const size = fs.statSync(file).size;
      const up = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: key,
          Body: fs.createReadStream(file),
          ContentType: "video/mp4",
          // Browsers save the file instead of playing it in the tab.
          ContentDisposition: `attachment; filename="${downloadName ?? key.split("/").pop()}"`,
          // Keys contain a unique id, so the content behind a URL never changes.
          CacheControl: "public, max-age=31536000, immutable",
        },
        partSize: 16 * 1024 * 1024,
        queueSize: 4,
      });
      up.on("httpUploadProgress", (p) => p.loaded && onProgress?.(Math.min(1, p.loaded / size)));
      await up.done();
    },

    remove: (key) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
  };
}
