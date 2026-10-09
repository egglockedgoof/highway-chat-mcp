/**
 * cloudinary-upload.ts — server-side file uploads to Cloudinary.
 *
 * Free tier (no card, created 2026-10-09): 25 credits/month shared pool —
 * 25 GB storage OR 25 GB CDN bandwidth. No card on file = no surprise
 * charges possible. Firebase Storage is dead for us (Blaze takes $30
 * upfront — lesson #40), so Cloudinary is the binary storage layer.
 *
 * The API secret NEVER leaves the server: uploads happen here, the
 * frontend only ever sees the public secure_url.
 *
 * Pure-ish module: config comes from env, the HTTP call is injectable
 * for tests. Tested by cloudinary-upload.test.ts via `node --test`
 * (Node 24 strips types natively; no build step).
 */

import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";

export type CloudResourceType = "image" | "video" | "raw";

export interface CloudinaryUploadInput {
  /** data:<mime>;base64,... — avoids temp files */
  dataUri: string;
  filename: string;
  mimeType: string;
}

export interface CloudinaryUploadResult {
  secure_url: string;
  public_id: string;
  resource_type: CloudResourceType;
  folder: string;
  bytes: number;
}

/** Injectable uploader — the real one calls the Cloudinary SDK. */
export type UploaderFn = (
  dataUri: string,
  opts: { folder: string; resource_type: CloudResourceType; public_id: string },
) => Promise<UploadApiResponse>;

/** Folder convention: highway-chat/{images|audio|video|files}/ */
export function folderForMime(mimeType: string): string {
  const m = (mimeType || "").toLowerCase();
  if (m.startsWith("image/")) return "highway-chat/images";
  if (m.startsWith("audio/")) return "highway-chat/audio";
  if (m.startsWith("video/")) return "highway-chat/video";
  return "highway-chat/files";
}

/**
 * Cloudinary treats audio as `video` resource_type. `raw` for documents —
 * delivered as-is, no transformation pipeline.
 */
export function resourceTypeForMime(mimeType: string): CloudResourceType {
  const m = (mimeType || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/") || m.startsWith("video/")) return "video";
  return "raw";
}

export function cloudinaryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

/** URL-safe public id: sanitized filename stem + timestamp + random. */
export function makePublicId(filename: string, nowMs: number = Date.now()): string {
  const stem = (filename || "file").split(".")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "file";
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stem}-${nowMs.toString(36)}-${rand}`;
}

let _configured = false;
function ensureConfigured(env: NodeJS.ProcessEnv): void {
  if (_configured) return;
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  _configured = true;
}

const defaultUploader: UploaderFn = async (dataUri, opts) => {
  return cloudinary.uploader.upload(dataUri, {
    folder: opts.folder,
    resource_type: opts.resource_type,
    public_id: opts.public_id,
  });
};

export interface UploadDeps {
  uploader?: UploaderFn;
  env?: NodeJS.ProcessEnv;
  nowMs?: () => number;
}

export async function uploadToCloudinary(
  input: CloudinaryUploadInput,
  deps: UploadDeps = {},
): Promise<CloudinaryUploadResult> {
  const env = deps.env ?? process.env;
  if (!cloudinaryConfigured(env)) {
    throw new Error("Cloudinary not configured (CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET)");
  }
  if (!input.dataUri.startsWith("data:")) {
    throw new Error("dataUri must be a data: URI");
  }
  ensureConfigured(env);

  const folder = folderForMime(input.mimeType);
  const resource_type = resourceTypeForMime(input.mimeType);
  const public_id = makePublicId(input.filename, deps.nowMs ? deps.nowMs() : Date.now());
  const uploader = deps.uploader ?? defaultUploader;

  let res: UploadApiResponse;
  try {
    res = await uploader(input.dataUri, { folder, resource_type, public_id });
  } catch (e) {
    throw new Error(`Cloudinary upload failed: ${(e as Error)?.message ?? String(e)}`);
  }
  if (!res?.secure_url) {
    throw new Error("Cloudinary upload returned no secure_url");
  }
  return {
    secure_url: res.secure_url,
    public_id: res.public_id || public_id,
    resource_type: (res.resource_type as CloudResourceType) || resource_type,
    folder,
    bytes: typeof res.bytes === "number" ? res.bytes : 0,
  };
}
