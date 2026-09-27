/**
 * Tests for inbound attachment descriptions (contacts from VCard, locations
 * with a map link, link-preview cards) and the per-message media count limit.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MaxApi, MaxAttachment } from './api.js';
import { MaxConfigSchema } from './config-schema.js';
import { collectInboundAttachments, parseMaxVcard } from './inbound-attachments.js';
import { setMaxRuntime } from './runtime.js';

const ACCOUNT = {
  accountId: 'default',
  enabled: true,
  token: 'test-token',
  tokenSource: 'config' as const,
  config: {},
};
const IMAGE = { type: 'image', payload: { url: 'https://files.example.test/a.jpg' } };

let fetchRemoteMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchRemoteMedia = vi.fn(async () => ({
    buffer: new Uint8Array([1, 2, 3]),
    contentType: 'image/jpeg',
  }));
  const saveMediaBuffer = vi.fn(async (_buf: Buffer, contentType: string) => ({
    path: '/tmp/media/inbound/a.jpg',
    contentType,
  }));
  setMaxRuntime({ channel: { media: { fetchRemoteMedia, saveMediaBuffer } } } as never);
});

function collect(
  attachments: unknown[],
  config: Record<string, unknown> = {},
  mediaBudget?: number,
) {
  return collectInboundAttachments({
    attachments: attachments as MaxAttachment[],
    messageId: 'mid.1',
    chatId: 70,
    api: {} as MaxApi,
    account: { ...ACCOUNT, config } as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    mediaBudget,
  });
}

describe('contacts', () => {
  it('gives the agent the name and phones from the VCard, not the raw VCard', async () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Иван Петров',
      'TEL;TYPE=CELL:+7 900 000-00-01',
      'TEL:tel:+79000000002',
      'END:VCARD',
    ].join('\r\n');
    const { descriptions } = await collect([{ type: 'contact', payload: { vcf_info: vcf } }]);
    expect(descriptions).toEqual(['[Contact: Иван Петров; phone: +7 900 000-00-01, +79000000002]']);
  });

  it('adds the linked MAX profile and falls back to its name', async () => {
    const { descriptions } = await collect([
      {
        type: 'contact',
        payload: {
          max_info: { user_id: 42, first_name: 'Anna', last_name: 'K', username: 'anna' },
        },
      },
    ]);
    expect(descriptions).toEqual(['[Contact: Anna K; MAX user: 42 (@anna)]']);
  });

  it('marks an empty contact without inventing data', async () => {
    const { descriptions } = await collect([{ type: 'contact', payload: { vcf_info: 'junk' } }]);
    expect(descriptions).toEqual(['[Contact]']);
  });
});

describe('parseMaxVcard', () => {
  it('falls back from FN to N and unfolds folded lines', () => {
    expect(parseMaxVcard('BEGIN:VCARD\nN:Petrov;Ivan;;;\nEND:VCARD').name).toBe('Ivan Petrov');
    expect(parseMaxVcard('FN:Very Long\r\n  Name\r\n').name).toBe('Very Long Name');
  });

  it('decodes escapes, quoted-printable and grouped properties', () => {
    expect(parseMaxVcard('FN:Smith\\, John\\nJr').name).toBe('Smith, John Jr');
    expect(
      parseMaxVcard('FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D0=98=D0=B2=D0=B0=D0=BD').name,
    ).toBe('Иван');
    expect(parseMaxVcard('item1.TEL;type=pref:+7000').phones).toEqual(['+7000']);
  });

  it('dedupes phones and keeps at most five', () => {
    const lines = ['TEL:+1', 'TEL:+1', 'TEL:+2', 'TEL:+3', 'TEL:+4', 'TEL:+5', 'TEL:+6'];
    expect(parseMaxVcard(lines.join('\n')).phones).toEqual(['+1', '+2', '+3', '+4', '+5']);
  });
});

describe('locations and link previews', () => {
  it('gives coordinates with a map link', async () => {
    const { descriptions } = await collect([
      { type: 'location', latitude: 55.7539, longitude: 37.6208 },
      { type: 'location', latitude: 'x', longitude: 37 },
    ]);
    expect(descriptions).toEqual([
      '[Location: 55.7539, 37.6208 — https://yandex.ru/maps/?pt=37.6208,55.7539&z=16&l=map]',
      '[Location]',
    ]);
  });

  it('describes a share card by title, description and link', async () => {
    const { descriptions } = await collect([
      {
        type: 'share',
        payload: { url: 'https://news.example.test/a' },
        title: 'Headline',
        description: 'First line\n\nsecond line',
      },
      { type: 'share', payload: { url: 'https://news.example.test/b' } },
      { type: 'share', payload: {} },
      { type: 'share', payload: {}, description: 'x'.repeat(400) },
    ]);
    expect(descriptions.slice(0, 3)).toEqual([
      '[Share: Headline — First line second line — https://news.example.test/a]',
      '[Share: https://news.example.test/b]',
      '[Share]',
    ]);
    expect(Array.from(descriptions[3])).toHaveLength('[Share: '.length + 300 + 1);
    expect(descriptions[3].endsWith('…]')).toBe(true);
  });
});

describe('media count limit', () => {
  it('downloads at most 12 media per message by default and notes the rest', async () => {
    const { mediaInputs, descriptions, mediaTaken } = await collect(Array(14).fill(IMAGE));
    expect(fetchRemoteMedia).toHaveBeenCalledTimes(12);
    expect(mediaInputs).toHaveLength(12);
    expect(mediaTaken).toBe(12);
    expect(descriptions).toEqual([
      '[2 more media attachment(s) not loaded: limit of 12 per message]',
    ]);
  });

  it('honors mediaMaxCount and counts only media, keeping cheap text parts', async () => {
    const { mediaInputs, descriptions } = await collect(
      [
        { type: 'location', latitude: 1, longitude: 2 },
        IMAGE,
        IMAGE,
        { type: 'sticker', payload: { code: 'st1', url: 'https://files.example.test/s.webp' } },
        {
          type: 'audio',
          payload: { url: 'https://files.example.test/v.ogg' },
          transcription: 'hi',
        },
      ],
      { mediaMaxCount: 2 },
    );
    expect(mediaInputs).toHaveLength(2);
    expect(descriptions).toEqual([
      '[Location: 1, 2 — https://yandex.ru/maps/?pt=2,1&z=16&l=map]',
      '[Sticker: code=st1]',
      '[Voice transcript: hi]',
      '[2 more media attachment(s) not loaded: limit of 2 per message]',
    ]);
  });

  it('downloads nothing when the message budget is spent', async () => {
    const { mediaInputs, descriptions } = await collect([IMAGE], {}, 0);
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(mediaInputs).toHaveLength(0);
    expect(descriptions).toEqual([
      '[1 more media attachment(s) not loaded: limit of 12 per message]',
    ]);
  });

  it('accepts mediaMaxCount only as a positive integer', () => {
    expect(MaxConfigSchema.safeParse({ mediaMaxCount: 5 }).success).toBe(true);
    expect(MaxConfigSchema.safeParse({ mediaMaxCount: 0 }).success).toBe(false);
    expect(MaxConfigSchema.safeParse({ mediaMaxCount: 1.5 }).success).toBe(false);
  });
});
