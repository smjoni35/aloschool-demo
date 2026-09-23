// R2 (Cloudflare) photo storage — resizes/compresses images before upload so
// the 10 GB free tier stretches as far as possible, then returns a public
// URL. Student/teacher/admission records store that URL instead of a raw
// base64 data:// string, which is what used to bloat every record saved to
// Upstash.
//
// Needs these env vars (see .env.example):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME,
//   R2_PUBLIC_URL  (the bucket's public r2.dev URL or a custom domain, no
//                   trailing slash)
//
// If these aren't set, uploadPhoto() returns null and callers fall back to
// the old behaviour (storing the base64 data URL directly) so the app keeps
// working without R2 configured.

const crypto = require("crypto");

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET_NAME = process.env.R2_BUCKET_NAME;
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");

const configured = Boolean(ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET_NAME && PUBLIC_URL);

let s3Client = null;
let sharp = null;

function getClient() {
  if (!configured) return null;
  if (!s3Client) {
    const { S3Client } = require("@aws-sdk/client-s3");
    s3Client = new S3Client({
      region: "auto",
      endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    });
  }
  return s3Client;
}

function getSharp() {
  if (!sharp) sharp = require("sharp");
  return sharp;
}

// Accepts either a multer file buffer or a base64 data: URL string.
// folder: e.g. "students", "teachers", "admissions" — keeps the bucket tidy.
// Returns the public URL, or null if R2 isn't configured / upload failed.
async function uploadPhoto(input, folder = "photos") {
  if (!configured) return null;

  let buffer;
  if (Buffer.isBuffer(input)) {
    buffer = input;
  } else if (typeof input === "string" && input.startsWith("data:")) {
    const base64 = input.split(",")[1] || "";
    buffer = Buffer.from(base64, "base64");
  } else {
    return null;
  }

  try {
    // Resize to a sensible max size and re-encode as JPEG — a face/ID photo
    // never needs to be bigger than this, and this is what keeps 10 GB
    // stretching to tens of thousands of photos instead of a few thousand.
    const resized = await getSharp()(buffer)
      .rotate() // respect EXIF orientation before stripping it
      .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer();

    const key = `${folder}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}.jpg`;

    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    await getClient().send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: resized,
        ContentType: "image/jpeg",
        CacheControl: "public, max-age=31536000, immutable",
      })
    );

    return `${PUBLIC_URL}/${key}`;
  } catch (err) {
    console.error("R2 photo upload failed:", err.message);
    return null;
  }
}

module.exports = { uploadPhoto, configured };
