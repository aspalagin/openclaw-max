/**
 * Remote media → temporary local file, for MAX uploads that need a path.
 * One place for the download, the file name policy and the cleanup.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getMaxRuntime } from "./runtime.js";

/** Upper bound for a sanitized file name (bytes of UTF-8 stay well under 255). */
export const MAX_TEMP_FILE_NAME_LENGTH = 120;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/opus": "opus",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

/**
 * A remote file name reduced to one safe path segment: no directories, no
 * `..`, no control or path-reserved characters, bounded length, extension
 * kept. Falls back to `file` (plus an extension from contentType if known).
 */
export function sanitizeMaxFileName(name: string | undefined, contentType?: string): string {
  let base = (name ?? "").normalize("NFC");
  // Last path segment only (both separators; URL-encoded ones too).
  base = base.replace(/%2f|%5c/gi, "/").split(/[/\\]/).pop() ?? "";
  base = base
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\s]+|[.\s]+$/g, "");

  const dot = base.lastIndexOf(".");
  let stem = dot > 0 ? base.slice(0, dot) : base;
  let ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (!/^[a-z0-9]{1,10}$/.test(ext)) {
    if (ext) stem = base;
    ext = "";
  }
  if (!ext && contentType) ext = EXTENSION_BY_CONTENT_TYPE[contentType.split(";")[0].trim().toLowerCase()] ?? "";

  if (!stem) stem = "file";
  const room = MAX_TEMP_FILE_NAME_LENGTH - (ext ? ext.length + 1 : 0);
  stem = Array.from(stem).slice(0, room).join("").trim() || "file";
  return ext ? `${stem}.${ext}` : stem;
}

export type MaxTempMedia = { path: string; contentType?: string; fileName: string };

/**
 * Download `url` through the runtime media fetcher (size-capped), write it to
 * a private temp directory under a sanitized name, run `use`, then remove the
 * directory whatever happens.
 */
export async function withRemoteMediaTempFile<T>(
  url: string,
  maxBytes: number,
  use: (media: MaxTempMedia) => Promise<T>,
): Promise<T> {
  const loaded = await getMaxRuntime().channel.media.fetchRemoteMedia({ url, maxBytes });
  const fileName = sanitizeMaxFileName(loaded.fileName ?? fileNameFromUrl(url), loaded.contentType);
  const dir = await mkdtemp(join(tmpdir(), "max-media-"));
  try {
    const path = join(dir, fileName);
    await writeFile(path, loaded.buffer, { mode: 0o600 });
    return await use({ path, contentType: loaded.contentType, fileName });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function fileNameFromUrl(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || undefined;
  } catch {
    return undefined;
  }
}
