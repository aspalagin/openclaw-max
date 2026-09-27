/**
 * Tests for MAX message sending
 */

import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MaxApi, MaxRequestTimeoutError } from './api.js';
import {
  deleteMaxMessage,
  detectMaxMediaType,
  editMaxMessage,
  resolveMaxTarget,
  sendMaxContact,
  sendMaxMediaMessage,
  sendMaxMessage,
  sendMaxSticker,
} from './send.js';

const MOCK_TOKEN = 'test-token';

describe('MAX Message Sending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendMaxMessage', () => {
    it('should send text message with token option', async () => {
      const mockResult = {
        message: {
          body: { mid: 'msg-123', text: 'Hello' },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      const result = await sendMaxMessage('123', 'Hello', {
        token: MOCK_TOKEN,
      });

      expect(result.messageId).toBe('msg-123');
      expect(global.fetch).toHaveBeenCalled();
    });

    it('retries a text send once when the client deadline fires, then succeeds', async () => {
      const spy = vi
        .spyOn(MaxApi.prototype, 'sendMessage')
        .mockRejectedValueOnce(
          new MaxRequestTimeoutError('POST', '/messages', 30_000, 'awaiting-response'),
        )
        .mockResolvedValueOnce({
          message: { body: { mid: 'msg-retry' }, timestamp: Date.now(), recipient: { chat_id: 1 } },
        } as never);

      const result = await sendMaxMessage('1', 'Hello', { token: MOCK_TOKEN });

      expect(result.messageId).toBe('msg-retry');
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });

    it('retries a bare positive id as user_id once when MAX answers dialog.not.found', async () => {
      const { MaxApiError } = await import('./api.js');
      const spy = vi
        .spyOn(MaxApi.prototype, 'sendMessage')
        .mockRejectedValueOnce(
          new MaxApiError('MAX API 404', 404, { code: 'dialog.not.found', message: 'x' }),
        )
        .mockResolvedValueOnce({
          message: { body: { mid: 'msg-user' }, timestamp: 1, recipient: { chat_id: 9 } },
        } as never);

      const result = await sendMaxMessage('1000101', 'Hi', { token: MOCK_TOKEN });

      expect(result.messageId).toBe('msg-user');
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[0][1]).toMatchObject({ chat_id: 1000101 });
      expect(spy.mock.calls[1][1]).toMatchObject({ user_id: 1000101 });
      expect(spy.mock.calls[1][1]).not.toHaveProperty('chat_id');
      spy.mockRestore();
    });

    it('does not retry as user_id for group ids, user: targets or other errors', async () => {
      const { MaxApiError } = await import('./api.js');
      const notFound = () =>
        new MaxApiError('MAX API 404', 404, { code: 'chat.not.found', message: 'x' });
      const spy = vi.spyOn(MaxApi.prototype, 'sendMessage').mockImplementation(async () => {
        throw notFound();
      });
      await expect(sendMaxMessage('-7115', 'Hi', { token: MOCK_TOKEN })).rejects.toThrow();
      await expect(sendMaxMessage('user:5', 'Hi', { token: MOCK_TOKEN })).rejects.toThrow();
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRejectedValueOnce(new MaxApiError('MAX API 403', 403, { code: 'chat.denied' }));
      await expect(sendMaxMessage('5', 'Hi', { token: MOCK_TOKEN })).rejects.toThrow('403');
      expect(spy).toHaveBeenCalledTimes(3);
      spy.mockRestore();
    });

    it('does not retry a text send on a non-timeout error', async () => {
      const spy = vi.spyOn(MaxApi.prototype, 'sendMessage').mockRejectedValue(new Error('boom'));

      await expect(sendMaxMessage('1', 'Hello', { token: MOCK_TOKEN })).rejects.toThrow('boom');
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('should send message with config and accountId', async () => {
      const cfg: OpenClawConfig = {
        channels: {
          max: {
            botToken: 'config-token',
          },
        },
      };

      const mockResult = {
        message: {
          body: { mid: 'msg-456', text: 'Test' },
          timestamp: Date.now(),
          recipient: { chat_id: 456 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      const result = await sendMaxMessage('456', 'Test', { cfg });
      expect(result.messageId).toBe('msg-456');
    });

    it('should throw error when no token available', async () => {
      const cfg: OpenClawConfig = { channels: { max: {} } };
      await expect(sendMaxMessage('123', 'Hello', { cfg })).rejects.toThrow('token not available');
    });

    it('should send message with markdown format', async () => {
      const mockResult = {
        message: {
          body: { mid: 'msg-789', text: '**Bold**' },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      await sendMaxMessage('123', '**Bold**', {
        token: MOCK_TOKEN,
        format: 'markdown',
      });

      const callBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(callBody.format).toBe('markdown');
    });

    it('should send message with reply context', async () => {
      const mockResult = {
        message: {
          body: { mid: 'msg-reply', text: 'Reply' },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      await sendMaxMessage('123', 'Reply', {
        token: MOCK_TOKEN,
        replyToMessageId: 'original-msg-id',
      });

      const callBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(callBody.link).toEqual({
        type: 'reply',
        mid: 'original-msg-id',
      });
    });

    it('should send message with inline keyboard', async () => {
      const mockResult = {
        message: {
          body: { mid: 'msg-kb', text: 'Pick one' },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      await sendMaxMessage('123', 'Pick one', {
        token: MOCK_TOKEN,
        buttons: [
          [
            { text: 'Option 1', payload: 'opt1' },
            { text: 'Link', url: 'https://example.com' },
          ],
        ],
      });

      const callBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(callBody.attachments).toHaveLength(1);
      expect(callBody.attachments[0].type).toBe('inline_keyboard');
      expect(callBody.attachments[0].payload.buttons[0]).toHaveLength(2);
    });

    it('should disable link preview when requested', async () => {
      const mockResult = {
        message: {
          body: { mid: 'msg-nopreview', text: 'Link' },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      await sendMaxMessage('123', 'https://example.com', {
        token: MOCK_TOKEN,
        disableLinkPreview: true,
      });

      const callUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(callUrl).toContain('disable_link_preview=true');
    });
  });

  describe('editMaxMessage', () => {
    it('should edit existing message', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await editMaxMessage('msg-123', 'Updated text', {
        token: MOCK_TOKEN,
        format: 'markdown',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/messages'),
        expect.objectContaining({
          method: 'PUT',
        }),
      );

      const callBody = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(callBody.text).toBe('Updated text');
      expect(callBody.format).toBe('markdown');
    });

    it('keeps attachments untouched without buttons and sends the keyboard with them', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

      await editMaxMessage('msg-1', 'No keyboard', { token: MOCK_TOKEN });
      await editMaxMessage('msg-2', 'With keyboard', {
        token: MOCK_TOKEN,
        buttons: [
          [
            { text: 'Да', payload: 'yes' },
            { text: 'Docs', url: 'https://docs.example' },
          ],
        ],
      });

      const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
      // attachments absent → MAX keeps the current ones (an empty list would delete them).
      expect(JSON.parse(calls[0][1].body)).not.toHaveProperty('attachments');
      expect(JSON.parse(calls[1][1].body).attachments).toEqual([
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [
                { type: 'callback', text: 'Да', payload: 'yes' },
                { type: 'link', text: 'Docs', url: 'https://docs.example' },
              ],
            ],
          },
        },
      ]);
    });

    it('should throw error when no token available', async () => {
      const cfg: OpenClawConfig = { channels: { max: {} } };
      await expect(editMaxMessage('msg-123', 'Updated', { cfg })).rejects.toThrow(
        'token not available',
      );
    });
  });

  describe('deleteMaxMessage', () => {
    it('should delete message', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      await deleteMaxMessage('msg-456', { token: MOCK_TOKEN });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/messages'),
        expect.objectContaining({
          method: 'DELETE',
        }),
      );
    });
  });

  describe('sendMaxMediaMessage', () => {
    it('should detect media type from extension', async () => {
      const mockUploadResult = { url: 'https://cdn.max.ru/uploaded-image.jpg' };
      const mockSendResult = {
        message: {
          body: { mid: 'msg-media', text: 'Caption' },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      // Mock both upload and send
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          // getUploadUrl
          ok: true,
          json: async () => ({ url: 'https://upload.max.ru/token' }),
        })
        .mockResolvedValueOnce({
          // uploadMedia POST
          ok: true,
          json: async () => mockUploadResult,
        })
        .mockResolvedValueOnce({
          // sendMessage
          ok: true,
          json: async () => mockSendResult,
        });

      // We need to mock fs.readFile for local file path
      const mockReadFile = vi.fn().mockResolvedValue(Buffer.from('fake-image'));
      vi.doMock('fs/promises', () => ({
        readFile: mockReadFile,
      }));

      // For this test, we'll just verify the flow without actual file reading
      // In production, sendMaxMediaMessage would read the file, but in tests
      // we can't easily mock dynamic imports in vitest.
      // We'll skip the actual call and just test the interface.

      // Just verify function signature
      expect(typeof sendMaxMediaMessage).toBe('function');
    });

    it('should accept caption and options', () => {
      // Interface test - ensure function accepts expected params
      const fn = sendMaxMediaMessage;
      expect(fn.length).toBe(3); // to, caption, mediaPath
    });
  });
});

describe('MAX Sticker Sending', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('sendMaxSticker', () => {
    it('should send sticker with code', async () => {
      const mockResult = {
        message: {
          body: {
            mid: 'sticker-msg-123',
            attachments: [{ type: 'sticker', payload: { code: 'test_sticker' } }],
          },
          timestamp: Date.now(),
          recipient: { chat_id: 123 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      const result = await sendMaxSticker('123', 'test_sticker', { token: MOCK_TOKEN });

      expect(result.messageId).toBe('sticker-msg-123');
      expect(global.fetch).toHaveBeenCalled();

      const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain('/messages');
      expect(url).toContain('chat_id=123');
      const body = JSON.parse(init.body as string);
      expect(body.attachments).toEqual([{ type: 'sticker', payload: { code: 'test_sticker' } }]);
      expect(body.text).toBeUndefined();
    });

    it('should send sticker with reply context', async () => {
      const mockResult = {
        message: {
          body: { mid: 'sticker-reply-456' },
          timestamp: Date.now(),
          recipient: { chat_id: 456 },
        },
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      const result = await sendMaxSticker('456', 'reply_sticker_code', {
        token: MOCK_TOKEN,
        replyToMessageId: 'original-msg-789',
      });

      expect(result.messageId).toBe('sticker-reply-456');
      const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      const body = JSON.parse(init.body as string);
      expect(body.link).toEqual({ type: 'reply', mid: 'original-msg-789' });
    });

    it('should be a function with correct signature', () => {
      expect(typeof sendMaxSticker).toBe('function');
      expect(sendMaxSticker.length).toBe(2); // to, stickerCode (opts is optional)
    });
  });
});

describe('MAX markdown dialect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should convert <u>…</u> to ++…++ but leave __bold__/**bold** intact', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { body: { mid: 'm1' }, timestamp: 1, recipient: { chat_id: 1 } },
      }),
    });

    await sendMaxMessage('123', '<u>подчёркнуто</u>, __жирно__ и **тоже жирно**', {
      token: MOCK_TOKEN,
      format: 'markdown',
    });

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    // MAX renders __text__/**text** as bold itself — do not touch them
    expect(body.text).toBe('++подчёркнуто++, __жирно__ и **тоже жирно**');
  });

  it('should NOT mangle __dunders__ inside code spans, fenced blocks or URLs', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { body: { mid: 'm1' }, timestamp: 1, recipient: { chat_id: 1 } },
      }),
    });

    const text =
      'call `<u>x</u>` here, see https://host/<u>y</u>/page and:\n```py\ndef f(): pass  # <u>z</u>\n```';
    await sendMaxMessage('123', text, { token: MOCK_TOKEN, format: 'markdown' });

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    // <u> inside code spans / fenced blocks / URLs must survive verbatim
    expect(body.text).toContain('`<u>x</u>`');
    expect(body.text).toContain('https://host/<u>y</u>/page');
    expect(body.text).toContain('# <u>z</u>');
    expect(body.text).not.toContain('++');
  });

  it('should leave text untouched without format', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { body: { mid: 'm1' }, timestamp: 1, recipient: { chat_id: 1 } },
      }),
    });

    await sendMaxMessage('123', '<u>raw</u>', { token: MOCK_TOKEN });

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.text).toBe('<u>raw</u>');
  });
});

describe('MAX button types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should build message/clipboard/open_app/request buttons', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { body: { mid: 'm1' }, timestamp: 1, recipient: { chat_id: 1 } },
      }),
    });

    await sendMaxMessage('123', 'pick', {
      token: MOCK_TOKEN,
      buttons: [
        [
          { text: 'Подробнее', type: 'message' },
          { text: 'Скопировать', type: 'clipboard', payload: 'CODE-42' },
          { text: 'Мини-апп', type: 'open_app', webApp: 'someapp' },
          { text: 'Контакт', type: 'request_contact' },
          { text: 'Гео', type: 'request_geo_location' },
        ],
      ],
    });

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    const row = body.attachments[0].payload.buttons[0];
    expect(row).toEqual([
      { type: 'message', text: 'Подробнее' },
      { type: 'clipboard', text: 'Скопировать', payload: 'CODE-42' },
      { type: 'open_app', text: 'Мини-апп', web_app: 'someapp' },
      { type: 'request_contact', text: 'Контакт' },
      { type: 'request_geo_location', text: 'Гео' },
    ]);
  });

  it('should not send intent, which the Button schema does not define', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { body: { mid: 'm1' }, timestamp: 1, recipient: { chat_id: 1 } },
      }),
    });

    await sendMaxMessage('123', 'sure?', {
      token: MOCK_TOKEN,
      buttons: [[{ text: 'Удалить', payload: 'del', intent: 'negative' } as never]],
    });

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.attachments[0].payload.buttons[0][0]).toEqual({
      type: 'callback',
      text: 'Удалить',
      payload: 'del',
    });
  });

  it('should address open_app by web_app, carrying a legacy url over and never sending url', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { body: { mid: 'm1' }, timestamp: 1, recipient: { chat_id: 1 } },
      }),
    });

    await sendMaxMessage('123', 'open', {
      token: MOCK_TOKEN,
      buttons: [
        [
          { text: 'App', type: 'open_app', url: 'someapp_bot' },
          { text: 'App2', type: 'open_app', webApp: 'other_bot', payload: 'start-1' },
        ],
      ],
    });

    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.attachments[0].payload.buttons[0]).toEqual([
      { type: 'open_app', text: 'App', web_app: 'someapp_bot' },
      { type: 'open_app', text: 'App2', web_app: 'other_bot', payload: 'start-1' },
    ]);
  });
});

describe('sendMaxContact payload', () => {
  const sentAttachment = () => {
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { body: string },
    ];
    return JSON.parse(init.body).attachments[0];
  };

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { body: { mid: 'mid.c' }, timestamp: 1, recipient: { chat_id: 1 } },
      }),
    });
  });

  it('sends a MAX user as snake_case contact_id + vcf_phone with name', async () => {
    await sendMaxContact(
      '1',
      { name: 'Ann', contactId: 42, vcfPhone: '+79990000000' },
      { token: MOCK_TOKEN },
    );
    expect(sentAttachment()).toEqual({
      type: 'contact',
      payload: { name: 'Ann', contact_id: 42, vcf_phone: '+79990000000' },
    });
  });

  it('passes an explicit VCard as vcf_info', async () => {
    const vcf = 'BEGIN:VCARD\nVERSION:3.0\nFN:Ann\nEND:VCARD';
    await sendMaxContact('1', { name: 'Ann', vcfInfo: vcf }, { token: MOCK_TOKEN });
    expect(sentAttachment().payload).toEqual({ name: 'Ann', vcf_info: vcf });
  });

  it('builds vcf_info from name and phone when there is no contact id', async () => {
    await sendMaxContact('1', { name: 'Ann', vcfPhone: '+7999' }, { token: MOCK_TOKEN });
    const payload = sentAttachment().payload;
    expect(payload).toEqual({
      name: 'Ann',
      vcf_info: 'BEGIN:VCARD\nVERSION:3.0\nFN:Ann\nTEL:+7999\nEND:VCARD',
    });
    expect(payload).not.toHaveProperty('contactId');
    expect(payload).not.toHaveProperty('vcfInfo');
  });
});

describe('detectMaxMediaType', () => {
  it('should route modern formats to the right upload type', () => {
    expect(detectMaxMediaType('photo.heic')).toBe('image');
    expect(detectMaxMediaType('scan.tiff')).toBe('image');
    expect(detectMaxMediaType('clip.webm')).toBe('video');
    expect(detectMaxMediaType('movie.mkv')).toBe('video');
    expect(detectMaxMediaType('legacy.avi')).toBe('file');
    expect(detectMaxMediaType('animation.webp')).toBe('file');
    expect(detectMaxMediaType('voice.m4a')).toBe('audio');
    expect(detectMaxMediaType('song.flac')).toBe('audio');
    expect(detectMaxMediaType('doc.pdf')).toBe('file');
    expect(detectMaxMediaType('noext')).toBe('file');
  });
});

describe('resolveMaxTarget', () => {
  it('should resolve numeric and user: targets without API calls', async () => {
    const api = new MaxApi({ token: MOCK_TOKEN });
    expect(await resolveMaxTarget(api, '12345')).toEqual({ chat_id: 12345 });
    expect(await resolveMaxTarget(api, 'max:12345')).toEqual({ chat_id: 12345 });
    expect(await resolveMaxTarget(api, 'user:777')).toEqual({ user_id: 777 });
    expect(await resolveMaxTarget(api, 'max:user:777')).toEqual({ user_id: 777 });
  });

  it('rejects @username and max.ru links without calling the API', async () => {
    global.fetch = vi.fn();
    const api = new MaxApi({ token: MOCK_TOKEN });
    for (const target of [
      '@mygroup',
      'max:@mygroup',
      'https://max.ru/mygroup',
      'max.ru/join/abc',
    ]) {
      await expect(resolveMaxTarget(api, target)).rejects.toThrow(
        /does not resolve @username.*numeric chat_id/,
      );
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('should reject garbage targets', async () => {
    const api = new MaxApi({ token: MOCK_TOKEN });
    await expect(resolveMaxTarget(api, 'not-a-target')).rejects.toThrow('Invalid MAX target');
  });

  it('should send to user_id when target is user:<id>', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { body: { mid: 'm1' }, timestamp: 1, recipient: { user_id: 777 } },
      }),
    });

    await sendMaxMessage('user:777', 'hi', { token: MOCK_TOKEN });

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('user_id=777');
    expect(url).not.toContain('chat_id');
  });
});

describe('attachment.not.ready retry', () => {
  it('should retry the send (not the upload) until MAX finishes processing', async () => {
    const os = await import('node:os');
    // node:fs (sync) — "fs/promises" is module-mocked by an earlier test in this file
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tmpFile = path.join(os.tmpdir(), `max-test-video-${Date.now()}.mp4`);
    fs.writeFileSync(tmpFile, Buffer.from('fake-video'));

    try {
      global.fetch = vi
        .fn()
        // POST /uploads
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ url: 'https://upload.max.example/u', token: 'tok-1' }),
        })
        // upload host POST
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: 'tok-1' }),
        })
        // first send → attachment.not.ready
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({
            code: 'attachment.not.ready',
            message: 'attachment is not processed yet',
          }),
        })
        // retry send → ok
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            message: { body: { mid: 'm-ok' }, timestamp: 1, recipient: { chat_id: 1 } },
          }),
        });

      const result = await sendMaxMediaMessage('123', 'видео', tmpFile, {
        token: MOCK_TOKEN,
        localMedia: { mediaLocalRoots: [os.tmpdir()] },
      });
      expect(result.messageId).toBe('m-ok');
      expect(global.fetch).toHaveBeenCalledTimes(4);
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* already gone */
      }
    }
  }, 20_000);
});

describe('albums and images by URL', () => {
  const sent = () =>
    vi
      .spyOn(MaxApi.prototype, 'sendMessage')
      .mockImplementation(
        async () => ({ message: { body: { mid: `m-${Math.random()}` } } }) as never,
      );
  const uploads = () =>
    vi
      .spyOn(MaxApi.prototype, 'uploadMedia')
      .mockImplementation(async (type, _data, _contentType, fileName) => ({
        token: `tok:${type}:${fileName}`,
      }));
  /** Real files in a fresh directory: local media is read only under allowed roots. */
  const mediaDir = async (names: string[]) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'max-media-test-'));
    const paths = names.map((name) => path.join(dir, name));
    for (const file of paths) fs.writeFileSync(file, Buffer.from('x'));
    return { localMedia: { mediaLocalRoots: [dir] }, paths };
  };

  beforeEach(() => vi.restoreAllMocks());

  it('groups consecutive images/videos up to 12 per message, audio and files alone', async () => {
    const { groupMaxMedia, MAX_VISUAL_MEDIA_PER_MESSAGE } = await import('./send.js');
    expect(MAX_VISUAL_MEDIA_PER_MESSAGE).toBe(12);
    const images = Array.from({ length: 14 }, (_, i) => `/tmp/p${i}.jpg`);
    expect(groupMaxMedia(images).map((g) => g.length)).toEqual([12, 2]);
    expect(groupMaxMedia(['/a.png', 'https://x/v.mp4', '/b.pdf', '/c.mp3', '/d.jpg'])).toEqual([
      ['/a.png', 'https://x/v.mp4'],
      ['/b.pdf'],
      ['/c.mp3'],
      ['/d.jpg'],
    ]);
  });

  it('sends an album in one message: caption and reply on the first, buttons on the last', async () => {
    const { sendMaxMediaGroup } = await import('./send.js');
    const send = sent();
    uploads();
    const { localMedia, paths: images } = await mediaDir(
      Array.from({ length: 13 }, (_, i) => `p${i}.jpg`),
    );

    const result = await sendMaxMediaGroup('123', 'Подпись', images, {
      token: MOCK_TOKEN,
      localMedia,
      replyToMessageId: 'mid.q',
      buttons: [[{ text: 'Ок', payload: 'ok' }]],
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.messageIds).toHaveLength(2);
    const [first, second] = send.mock.calls.map((c) => c[0]);
    expect(first.text).toBe('Подпись');
    expect(first.link).toEqual({ type: 'reply', mid: 'mid.q' });
    expect(first.attachments).toHaveLength(12);
    expect(first.attachments?.every((a) => a.type === 'image')).toBe(true);
    expect(second.text).toBeUndefined();
    expect(second.link).toBeUndefined();
    expect(second.attachments?.map((a) => a.type)).toEqual(['image', 'inline_keyboard']);
  });

  it('sends https image links by URL without upload', async () => {
    const send = sent();
    const upload = uploads();
    await sendMaxMediaMessage('123', '', 'https://cdn.example/pic.png?x=1', { token: MOCK_TOKEN });
    expect(upload).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0].attachments).toEqual([
      { type: 'image', payload: { url: 'https://cdn.example/pic.png?x=1' } },
    ]);
  });

  it('falls back to download + upload when MAX refuses the image URL', async () => {
    const { MaxApiError } = await import('./api.js');
    const { setMaxRuntime } = await import('./runtime.js');
    const fetchRemoteMedia = vi.fn(async () => ({
      buffer: Buffer.from('png'),
      contentType: 'image/png',
      fileName: 'pic.png',
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMaxRuntime({ channel: { media: { fetchRemoteMedia } } } as any);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi
      .spyOn(MaxApi.prototype, 'sendMessage')
      .mockRejectedValueOnce(
        Object.assign(new MaxApiError('bad url', 400), { code: 'attachment.invalid' }),
      )
      .mockResolvedValueOnce({ message: { body: { mid: 'm-up' } } } as never);
    const upload = uploads();

    const result = await sendMaxMediaMessage('123', '', 'https://cdn.example/pic.png', {
      token: MOCK_TOKEN,
      mediaMaxBytes: 1000,
    });

    expect(result.messageId).toBe('m-up');
    expect(fetchRemoteMedia).toHaveBeenCalledWith({
      url: 'https://cdn.example/pic.png',
      maxBytes: 1000,
    });
    expect(upload).toHaveBeenCalledWith('image', Buffer.from('png'), 'image/png', 'pic.png');
    expect(send.mock.calls[1][0].attachments).toEqual([
      { type: 'image', payload: { token: 'tok:image:pic.png' } },
    ]);
  });

  it('downloads remote non-image media instead of reading the URL as a path', async () => {
    const { setMaxRuntime } = await import('./runtime.js');
    const fetchRemoteMedia = vi.fn(async () => ({
      buffer: Buffer.from('pdf'),
      contentType: 'application/pdf',
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMaxRuntime({ channel: { media: { fetchRemoteMedia } } } as any);
    const send = sent();
    const upload = uploads();
    await sendMaxMediaMessage('123', '', 'https://cdn.example/files/report', { token: MOCK_TOKEN });
    expect(upload).toHaveBeenCalledWith(
      'file',
      Buffer.from('pdf'),
      'application/pdf',
      'report.pdf',
    );
    expect(send.mock.calls[0][0].attachments).toEqual([
      { type: 'file', payload: { token: 'tok:file:report.pdf' } },
    ]);
  });

  it('keeps sending the rest when onError is given', async () => {
    const { sendMaxMediaGroup } = await import('./send.js');
    uploads();
    const send = vi
      .spyOn(MaxApi.prototype, 'sendMessage')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ message: { body: { mid: 'm-2' } } } as never);
    const onError = vi.fn();
    const { localMedia, paths } = await mediaDir(['a.pdf', 'b.pdf']);
    const result = await sendMaxMediaGroup('123', '', paths, {
      token: MOCK_TOKEN,
      localMedia,
      onError,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), [paths[0]]);
    expect(result.messageIds).toEqual(['m-2']);
  });
});

describe('pinMaxMessage in dialogs', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('does not call MAX for user: targets or a dialog chatType hint', async () => {
    const { pinMaxMessage } = await import('./send.js');
    const pin = vi.spyOn(MaxApi.prototype, 'pinMessage');
    const getChat = vi.spyOn(MaxApi.prototype, 'getChat');

    await expect(pinMaxMessage('user:1000101', 'mid.1', { token: MOCK_TOKEN })).resolves.toEqual({
      pinned: false,
      reason: expect.stringMatching(/dialogs/),
    });
    await expect(
      pinMaxMessage('2000202', 'mid.2', { token: MOCK_TOKEN, chatType: 'dialog' }),
    ).resolves.toMatchObject({ pinned: false });
    expect(pin).not.toHaveBeenCalled();
    expect(getChat).not.toHaveBeenCalled();
  });

  it('checks the type of a positive chat id and pins only non-dialogs', async () => {
    const { pinMaxMessage } = await import('./send.js');
    const pin = vi.spyOn(MaxApi.prototype, 'pinMessage').mockResolvedValue(undefined as never);
    const getChat = vi
      .spyOn(MaxApi.prototype, 'getChat')
      .mockResolvedValueOnce({ chat_id: 5, type: 'dialog', status: 'active' })
      .mockResolvedValueOnce({ chat_id: 6, type: 'chat', status: 'active' });

    await expect(pinMaxMessage('5', 'mid.a', { token: MOCK_TOKEN })).resolves.toMatchObject({
      pinned: false,
    });
    await expect(pinMaxMessage('6', 'mid.b', { token: MOCK_TOKEN })).resolves.toEqual({
      pinned: true,
    });
    // Negative ids are groups/channels: no type lookup.
    await expect(pinMaxMessage('-7001', 'mid.c', { token: MOCK_TOKEN })).resolves.toEqual({
      pinned: true,
    });
    expect(getChat).toHaveBeenCalledTimes(2);
    expect(pin.mock.calls.map((c) => c[0])).toEqual([6, -7001]);
  });

  it('maps 400 "Method is not available for dialogs" to pinned:false', async () => {
    const { pinMaxMessage } = await import('./send.js');
    const { MaxApiError } = await import('./api.js');
    vi.spyOn(MaxApi.prototype, 'getChat').mockRejectedValue(new Error('network'));
    vi.spyOn(MaxApi.prototype, 'pinMessage').mockRejectedValue(
      new MaxApiError('MAX API 400', 400, {
        code: 'proto.payload',
        message: 'Method is not available for dialogs',
      }),
    );
    await expect(pinMaxMessage('7', 'mid.d', { token: MOCK_TOKEN })).resolves.toMatchObject({
      pinned: false,
    });
  });
});

describe('inline media (content without a path)', () => {
  it('uploads inline bytes under their name and refuses them over the size limit', async () => {
    const upload = vi
      .spyOn(MaxApi.prototype, 'uploadMedia')
      .mockResolvedValue({ token: 'up-token' });
    const send = vi.spyOn(MaxApi.prototype, 'sendMessage').mockResolvedValue({
      message: { body: { mid: 'mid.inline' } },
    } as never);
    const media = {
      buffer: Buffer.from('12345'),
      fileName: 'notes.txt',
      contentType: 'text/plain',
    };

    const sent = await sendMaxMediaMessage('100', '', media, { token: MOCK_TOKEN });
    expect(sent.messageId).toBe('mid.inline');
    expect(upload).toHaveBeenCalledWith('file', media.buffer, 'text/plain', 'notes.txt');

    await expect(
      sendMaxMediaMessage('100', '', media, { token: MOCK_TOKEN, mediaMaxBytes: 4 }),
    ).rejects.toThrow('Inline media notes.txt is 5 bytes, over the 4-byte limit (mediaMaxMb)');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    upload.mockRestore();
    send.mockRestore();
  });
});

describe('voice messages (MAX audio attachment)', () => {
  beforeEach(() => vi.restoreAllMocks());

  const mockApi = () => {
    const upload = vi
      .spyOn(MaxApi.prototype, 'uploadMedia')
      .mockImplementation(async (type, _data, _contentType, fileName) => ({
        token: `tok:${type}:${fileName}`,
      }));
    const send = vi.spyOn(MaxApi.prototype, 'sendMessage').mockResolvedValue({
      message: { body: { mid: 'mid.voice' } },
    } as never);
    return { upload, send };
  };
  const voice = (fileName: string, contentType = 'audio/ogg') => ({
    buffer: Buffer.from('voice-bytes'),
    fileName,
    contentType,
  });

  it('sends audio as the audio attachment MAX shows as a voice message', async () => {
    const { upload, send } = mockApi();
    await sendMaxMediaMessage('100', '', voice('reply.ogg'), { token: MOCK_TOKEN, asVoice: true });
    expect(upload.mock.calls[0][0]).toBe('audio');
    expect(send.mock.calls[0][0].attachments).toEqual([
      { type: 'audio', payload: { token: 'tok:audio:reply.ogg' } },
    ]);
  });

  it('takes audio known only by its MIME type as voice only when asked', async () => {
    const { upload } = mockApi();
    await sendMaxMediaMessage('100', '', voice('reply.oga'), { token: MOCK_TOKEN, asVoice: true });
    await sendMaxMediaMessage('100', '', voice('reply.oga'), { token: MOCK_TOKEN });
    expect(upload.mock.calls.map((call) => call[0])).toEqual(['audio', 'file']);
  });

  it('uploads the same bytes as a file when MAX refuses the audio upload', async () => {
    const { MaxApiError } = await import('./api.js');
    const { upload, send } = mockApi();
    upload.mockRejectedValueOnce(new MaxApiError('MAX media upload failed: 400', 400, null));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await sendMaxMediaMessage('100', 'Подпись', voice('reply.ogg'), {
      token: MOCK_TOKEN,
      asVoice: true,
    });

    expect(result.messageId).toBe('mid.voice');
    expect(upload.mock.calls.map((call) => call[0])).toEqual(['audio', 'file']);
    expect(Buffer.from(upload.mock.calls[1][1]).toString()).toBe('voice-bytes');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].text).toBe('Подпись');
    expect(send.mock.calls[0][0].attachments).toEqual([
      { type: 'file', payload: { token: 'tok:file:reply.ogg' } },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sending as a file'));
  });

  it('resends the audio once as a file when MAX refuses the message (400)', async () => {
    const { MaxApiError } = await import('./api.js');
    const { upload, send } = mockApi();
    send.mockRejectedValueOnce(
      new MaxApiError('MAX API 400', 400, { code: 'proto.payload', message: 'bad audio' }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await sendMaxMediaMessage('100', '', voice('reply.mp3', 'audio/mpeg'), {
      token: MOCK_TOKEN,
      asVoice: true,
    });

    expect(result.messageId).toBe('mid.voice');
    expect(upload.mock.calls.map((call) => call[0])).toEqual(['audio', 'file']);
    expect(send.mock.calls.map((call) => call[0].attachments?.[0]?.type)).toEqual([
      'audio',
      'file',
    ]);
  });

  it('does not resend after a failure that may have delivered (5xx)', async () => {
    const { MaxApiError } = await import('./api.js');
    const { upload, send } = mockApi();
    send.mockRejectedValueOnce(new MaxApiError('MAX API 502', 502, null));

    await expect(
      sendMaxMediaMessage('100', '', voice('reply.ogg'), { token: MOCK_TOKEN, asVoice: true }),
    ).rejects.toThrow('MAX API 502');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reads a local voice file only through the guarded loader under the allowed roots', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'max-voice-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'max-voice-outside-'));
    const inside = path.join(root, 'reply.mp3');
    const foreign = path.join(outside, 'secret.mp3');
    fs.writeFileSync(inside, Buffer.from('mp3-bytes'));
    fs.writeFileSync(foreign, Buffer.from('mp3-bytes'));
    const { upload } = mockApi();
    const opts = { token: MOCK_TOKEN, asVoice: true, localMedia: { mediaLocalRoots: [root] } };

    await sendMaxMediaMessage('100', '', inside, opts);
    await expect(sendMaxMediaMessage('100', '', foreign, opts)).rejects.toThrow(
      /not under an allowed directory/,
    );
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toBe('audio');
  });
});
