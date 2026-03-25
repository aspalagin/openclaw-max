/**
 * MAX Messenger Bot — media download module
 *
 * Downloads incoming attachments (photos, files, audio, video)
 * from MAX API URLs with bot token authorization.
 *
 * Zero external dependencies — Node 18+ built-in fetch + fs/promises.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";

// ─── Constants ──────────────────────────────────────────────────

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// ─── Helpers ────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[max-media] ${new Date().toISOString()} ${msg}\n`);
}

/**
 * Extract filename from Content-Disposition header.
 * Supports both `filename="name.ext"` and `filename*=UTF-8''encoded` forms.
 */
function parseContentDisposition(header: string | null): string | null {
  if (!header) return null;

  // Try filename*=UTF-8''encoded (RFC 5987)
  const starMatch = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?'[^']*'(.+?)(?:;|$)/i);
  if (starMatch) {
    try {
      return decodeURIComponent(starMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Try filename="name.ext" or filename=name.ext
  const match = header.match(/filename\s*=\s*"?([^";\n]+)"?/i);
  if (match) {
    return match[1].trim();
  }

  return null;
}

/**
 * Derive a filename from URL path as fallback.
 */
function filenameFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const name = basename(pathname);
    // Only use if it has an extension
    if (name && extname(name)) {
      return decodeURIComponent(name);
    }
  } catch {
    // invalid URL
  }
  return null;
}

/**
 * Map common MIME types to file extensions.
 */
function extFromMime(mime: string | null): string {
  if (!mime) return "";
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/mp4": ".m4a",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "text/plain": ".txt",
    "application/json": ".json",
  };
  const base = mime.split(";")[0].trim().toLowerCase();
  return map[base] ?? "";
}

// ─── Main function ──────────────────────────────────────────────

/**
 * Download an attachment from MAX API.
 *
 * @param url      Full URL from attachment.payload.url
 * @param token    Bot API token (sent in Authorization header)
 * @param destDir  Directory to save the file into (created if missing)
 * @returns        Absolute path to the saved file
 * @throws         On network errors, timeouts, or files exceeding 50 MB
 */
export async function downloadAttachment(
  url: string,
  token: string,
  destDir: string,
): Promise<string> {
  // Ensure destination directory exists
  await mkdir(destDir, { recursive: true });

  // Fetch with timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Download timeout after ${DOWNLOAD_TIMEOUT_MS / 1000}s`));
  }, DOWNLOAD_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: token,
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    log(`Download failed: ${msg}`);
    throw new Error(`Failed to download ${url}: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const msg = `HTTP ${response.status}: ${body.slice(0, 200)}`;
    log(msg);
    throw new Error(msg);
  }

  // Check Content-Length before downloading
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_FILE_SIZE) {
    throw new Error(
      `File too large: ${(Number(contentLength) / 1024 / 1024).toFixed(1)} MB (max ${MAX_FILE_SIZE / 1024 / 1024} MB)`,
    );
  }

  // Determine filename
  const disposition = response.headers.get("content-disposition");
  const contentType = response.headers.get("content-type");

  let filename =
    parseContentDisposition(disposition) ??
    filenameFromUrl(url) ??
    randomUUID() + extFromMime(contentType);

  // Sanitize filename — remove path separators and null bytes
  filename = filename.replace(/[/\\:\0]/g, "_");

  // If filename has no extension, try to add one from MIME
  if (!extname(filename)) {
    const ext = extFromMime(contentType);
    if (ext) filename += ext;
  }

  // Read body as buffer with size check
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  if (!response.body) {
    throw new Error("Response has no body");
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.byteLength;
      if (totalSize > MAX_FILE_SIZE) {
        reader.cancel();
        throw new Error(
          `File exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit (downloaded ${(totalSize / 1024 / 1024).toFixed(1)} MB so far)`,
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Merge chunks
  const buffer = Buffer.concat(chunks);

  // Write to disk
  const filePath = join(destDir, filename);
  await writeFile(filePath, buffer);

  log(`Saved ${(buffer.byteLength / 1024).toFixed(1)} KB → ${filePath}`);

  return filePath;
}
