import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, sep } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_TEMP_FILE_NAME_LENGTH,
  sanitizeMaxFileName,
  withRemoteMediaTempFile,
} from './media-temp.js';
import { setMaxRuntime } from './runtime.js';

describe('sanitizeMaxFileName', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\system32\\cmd.exe', 'cmd.exe'],
    ['a%2F..%2F..%2Fsecret.txt', 'secret.txt'],
    ['..', 'file'],
    ['...hidden', 'hidden'],
    ['report\u0000.pdf', 'report_.pdf'],
    ['line\nbreak\r.png', 'line_break_.png'],
    ['bad<>:"|?*name.jpg', 'bad_______name.jpg'],
    ['photo..jpg', 'photo.jpg'],
    ['  spaced  name .png  ', 'spaced name.png'],
    ['', 'file'],
    [undefined, 'file'],
  ])('%j → %j', (input, expected) => {
    const out = sanitizeMaxFileName(input);
    expect(out).toBe(expected);
    expect(out).not.toMatch(/[/\\]|\.\.|[\u0000-\u001f]/);
  });

  it('bounds the length and keeps the extension', () => {
    const out = sanitizeMaxFileName(`${'я'.repeat(500)}.jpeg`);
    expect(Array.from(out).length).toBe(MAX_TEMP_FILE_NAME_LENGTH);
    expect(out.endsWith('.jpeg')).toBe(true);
  });

  it('adds an extension from contentType when the name has none', () => {
    expect(sanitizeMaxFileName('image', 'image/png')).toBe('image.png');
    expect(sanitizeMaxFileName(undefined, 'video/mp4; codecs=avc1')).toBe('file.mp4');
    expect(sanitizeMaxFileName('weird.ext-with-dash', 'image/jpeg')).toBe(
      'weird.ext-with-dash.jpg',
    );
    expect(sanitizeMaxFileName('doc.pdf', 'image/png')).toBe('doc.pdf');
  });
});

describe('withRemoteMediaTempFile', () => {
  afterEach(() => vi.restoreAllMocks());

  function withRuntime(result: { buffer: Buffer; contentType?: string; fileName?: string }) {
    const fetchRemoteMedia = vi.fn(async () => result);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMaxRuntime({ channel: { media: { fetchRemoteMedia } } } as any);
    return fetchRemoteMedia;
  }

  it('writes a sanitized file inside a private temp dir and removes it afterwards', async () => {
    const fetchRemoteMedia = withRuntime({
      buffer: Buffer.from('png-bytes'),
      contentType: 'image/png',
      fileName: '../../evil',
    });
    let seenPath = '';
    const out = await withRemoteMediaTempFile(
      'https://cdn.example/x',
      1024,
      async ({ path, fileName, contentType }) => {
        seenPath = path;
        expect(fileName).toBe('evil.png');
        expect(contentType).toBe('image/png');
        expect(dirname(dirname(path))).toBe(tmpdir());
        expect(path.split(sep).pop()).toBe('evil.png');
        expect(readFileSync(path, 'utf8')).toBe('png-bytes');
        expect(statSync(path).mode & 0o077).toBe(0);
        return 'done';
      },
    );
    expect(out).toBe('done');
    expect(fetchRemoteMedia).toHaveBeenCalledWith({ url: 'https://cdn.example/x', maxBytes: 1024 });
    expect(existsSync(dirname(seenPath))).toBe(false);
  });

  it('takes the name from the URL when the fetcher has none and cleans up on failure', async () => {
    withRuntime({ buffer: Buffer.from('x'), contentType: 'image/jpeg' });
    let seenPath = '';
    await expect(
      withRemoteMediaTempFile(
        'https://cdn.example/a/%2E%2E%2Fcat%20pic',
        10,
        async ({ path, fileName }) => {
          seenPath = path;
          expect(fileName).toBe('cat pic.jpg');
          throw new Error('upload failed');
        },
      ),
    ).rejects.toThrow('upload failed');
    expect(existsSync(dirname(seenPath))).toBe(false);
  });
});
