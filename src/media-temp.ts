/**
 * Remote media download for MAX uploads and the file name policy shared with
 * inbound media. The download goes through the runtime media fetcher (core's
 * SSRF-guarded reader); bytes stay in memory, no temporary file.
 */

import { proxiedMediaFetchOptions, scrubProxyCredentials } from './network.js';
import { getMaxRuntime } from './runtime.js';

/**
 * runtime.channel.media.fetchRemoteMedia, routed through the account proxy
 * when one is set; errors never carry the proxy credentials.
 */
export async function fetchMaxRemoteMedia(url: string, maxBytes: number, proxyUrl?: string) {
  try {
    return await getMaxRuntime().channel.media.fetchRemoteMedia({
      url,
      maxBytes,
      ...proxiedMediaFetchOptions(proxyUrl),
    });
  } catch (err) {
    throw scrubProxyCredentials(err, proxyUrl);
  }
}

/** Upper bound for a sanitized file name (bytes of UTF-8 stay well under 255). */
export const MAX_TEMP_FILE_NAME_LENGTH = 120;

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/opus': 'opus',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

/**
 * A remote file name reduced to one safe path segment: no directories, no
 * `..`, no control or path-reserved characters, bounded length, extension
 * kept. Falls back to `file` (plus an extension from contentType if known).
 */
export function sanitizeMaxFileName(name: string | undefined, contentType?: string): string {
  let base = (name ?? '').normalize('NFC');
  // Last path segment only (both separators; URL-encoded ones too).
  base =
    base
      .replace(/%2f|%5c/gi, '/')
      .split(/[/\\]/)
      .pop() ?? '';
  base = base
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+|[.\s]+$/g, '');

  const dot = base.lastIndexOf('.');
  let stem = dot > 0 ? base.slice(0, dot) : base;
  let ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (!/^[a-z0-9]{1,10}$/.test(ext)) {
    if (ext) stem = base;
    ext = '';
  }
  if (!ext && contentType)
    ext = EXTENSION_BY_CONTENT_TYPE[contentType.split(';')[0].trim().toLowerCase()] ?? '';

  if (!stem) stem = 'file';
  const room = MAX_TEMP_FILE_NAME_LENGTH - (ext ? ext.length + 1 : 0);
  stem = Array.from(stem).slice(0, room).join('').trim() || 'file';
  return ext ? `${stem}.${ext}` : stem;
}

/** Media bytes ready for a MAX upload. */
export type MaxLoadedMedia = { buffer: Buffer; contentType?: string; fileName: string };

/**
 * Download `url` through the runtime media fetcher: core's readRemoteMediaBuffer
 * (fetchWithSsrFGuard, strict mode: private, loopback and metadata hosts are
 * refused), size-capped, through the account proxy when one is set. The file
 * name is sanitized to one safe segment.
 */
export async function downloadMaxRemoteMedia(
  url: string,
  maxBytes: number,
  proxyUrl?: string,
): Promise<MaxLoadedMedia> {
  const loaded = await fetchMaxRemoteMedia(url, maxBytes, proxyUrl);
  return {
    buffer: Buffer.from(loaded.buffer),
    contentType: loaded.contentType,
    fileName: sanitizeMaxFileName(loaded.fileName ?? fileNameFromUrl(url), loaded.contentType),
  };
}

function fileNameFromUrl(url: string): string | undefined {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '') || undefined;
  } catch {
    return undefined;
  }
}
