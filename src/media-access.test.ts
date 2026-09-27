/**
 * Tests for outbound media access: local files are read only under the
 * allowed roots (or through the host reader), for every send path — message
 * actions (each attachments[] item), the outbound adapter and agent reply
 * delivery — and image links go to MAX by URL only for public https hosts.
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PlatformMessageNotDispatchedError } from 'openclaw/plugin-sdk/error-runtime';
import { resolvePinnedHostnameWithPolicy } from 'openclaw/plugin-sdk/ssrf-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { maxMessageActions } from './actions.js';
import { MaxApi } from './api.js';
import { maxOutboundAdapter } from './channel-outbound.js';
import { deliverMaxReply } from './deliver.js';
import { setMaxRuntime } from './runtime.js';
import { sendMaxMediaMessage } from './send.js';

// The actions run as an owner call (CLI passes senderIsOwner=true);
// actionScope has its own tests in action-scope.test.ts.
const actions: typeof maxMessageActions = {
  ...maxMessageActions,
  handleAction: (ctx) => maxMessageActions.handleAction!({ senderIsOwner: true, ...ctx }),
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const cfg = { channels: { max: { botToken: 'test-token' } } };
const NOT_ALLOWED = /not under an allowed directory/;

/** allowed/ with a.png and doc.pdf, outside/ with secret.png, a symlink escaping allowed/. */
function makeTree() {
  const base = mkdtempSync(join(tmpdir(), 'max-access-'));
  const allowed = join(base, 'allowed');
  const outside = join(base, 'outside');
  mkdirSync(allowed);
  mkdirSync(outside);
  writeFileSync(join(allowed, 'a.png'), PNG);
  writeFileSync(join(allowed, 'doc.pdf'), Buffer.from('%PDF-1.4 test'));
  writeFileSync(join(outside, 'secret.png'), PNG);
  symlinkSync(join(outside, 'secret.png'), join(allowed, 'link.png'));
  return { base, allowed, outside };
}

let tree: ReturnType<typeof makeTree>;
let upload: ReturnType<typeof vi.spyOn>;
let send: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  tree = makeTree();
  let n = 0;
  upload = vi
    .spyOn(MaxApi.prototype, 'uploadMedia')
    .mockImplementation(async (type, _data, _contentType, fileName) => ({
      token: `tok:${type}:${fileName}`,
    }));
  send = vi.spyOn(MaxApi.prototype, 'sendMessage').mockImplementation(
    async () =>
      ({
        message: { body: { mid: `m${++n}` }, recipient: { chat_id: 9, chat_type: 'chat' } },
      }) as never,
  );
});

function action(name: string, params: Record<string, unknown>, extra: Record<string, unknown>) {
  return actions.handleAction!({ action: name, params, cfg, ...extra } as never);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

describe('message actions read local media only under the allowed roots', () => {
  it('sends a file inside the roots core passed', async () => {
    await action(
      'send',
      { target: '-7001', message: 'pic', media: join(tree.allowed, 'a.png') },
      { mediaLocalRoots: [tree.allowed] },
    );

    expect(upload).toHaveBeenCalledWith('image', PNG, 'image/png', 'a.png');
    expect(send.mock.calls[0][0].attachments).toEqual([
      { type: 'image', payload: { token: 'tok:image:a.png' } },
    ]);
  });

  it.each([
    ['a path outside the roots', () => join(tree.outside, 'secret.png')],
    ['a symlink escaping the roots', () => join(tree.allowed, 'link.png')],
    ['a .. traversal', () => join(tree.allowed, '..', 'outside', 'secret.png')],
  ])('refuses %s with a clear error and sends nothing', async (_label, source) => {
    const err = await rejection(
      action(
        'send',
        { target: '-7001', message: '', media: source() },
        { mediaLocalRoots: [tree.allowed] },
      ),
    );

    expect(err.message).toMatch(NOT_ALLOWED);
    expect(upload).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('reads through mediaReadFile when core passes a host reader', async () => {
    const mediaReadFile = vi.fn(async () => PNG);
    const virtual = join(tree.allowed, 'staged', 'x.png'); // not on disk: only the reader has it

    await action(
      'sendAttachment',
      { target: '-7001', media: virtual },
      {
        mediaAccess: { localRoots: [tree.allowed], readFile: mediaReadFile },
        mediaLocalRoots: [tree.allowed],
        mediaReadFile,
      },
    );

    expect(mediaReadFile).toHaveBeenCalledWith(virtual);
    expect(upload).toHaveBeenCalledWith('image', PNG, 'image/png', 'x.png');
  });

  it('checks every attachments[] item: the allowed ones go, the refused one is reported', async () => {
    const result = await action(
      'sendAttachment',
      {
        target: '-7001',
        attachments: [
          { path: join(tree.allowed, 'a.png') },
          { path: join(tree.outside, 'secret.png') },
          { path: join(tree.allowed, 'doc.pdf') },
        ],
      },
      { mediaLocalRoots: [tree.allowed] },
    );

    const uploadedNames = upload.mock.calls.map((call) => call[3]);
    expect(uploadedNames).toEqual(['a.png', 'doc.pdf']);
    const payload = JSON.stringify(result);
    expect(payload).toContain('mediaErrors');
    expect(payload).toMatch(NOT_ALLOWED);
    expect(payload).toContain('secret.png');
  });

  it('fails the action when every item is refused', async () => {
    const err = await rejection(
      action(
        'send',
        {
          target: '-7001',
          message: '',
          attachments: [
            { path: join(tree.outside, 'secret.png') },
            { path: join(tree.allowed, 'link.png') },
          ],
        },
        { mediaLocalRoots: [tree.allowed] },
      ),
    );

    expect(err.message).toMatch(NOT_ALLOWED);
    expect(upload).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('falls back to the agent-scoped roots when core passes none', async () => {
    const withAgent = {
      ...cfg,
      agents: { list: [{ id: 'helper', workspace: tree.allowed }] },
    };
    const source = join(tree.allowed, 'a.png');

    await actions.handleAction!({
      action: 'send',
      params: { target: '-7001', message: '', media: source },
      cfg: withAgent,
      agentId: 'helper',
    } as never);
    expect(upload).toHaveBeenCalledTimes(1);

    // Without the agent its workspace is not an allowed root.
    const err = await rejection(
      actions.handleAction!({
        action: 'send',
        params: { target: '-7001', message: '', media: source },
        cfg: withAgent,
      } as never),
    );
    expect(err.message).toMatch(NOT_ALLOWED);
  });

  it('declares the media source params per action', () => {
    const described = actions.describeMessageTool({ cfg } as never);
    const expected = ['media', 'filePath', 'path', 'fileUrl', 'url', 'image'];
    expect(described?.mediaSourceParams).toEqual({ send: expected, sendAttachment: expected });
  });
});

describe('outbound adapter and reply delivery use the same policy', () => {
  beforeEach(() => {
    setMaxRuntime({
      config: { current: () => cfg },
      channel: {
        text: {
          resolveChunkMode: vi.fn(() => 'length'),
          chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
          chunkMarkdownText: vi.fn((text: string) => [text]),
        },
      },
    } as never);
  });

  it('sendMedia honours the roots of the delivery', async () => {
    await maxOutboundAdapter.sendMedia!({
      cfg,
      to: '-7001',
      text: '',
      mediaUrl: join(tree.allowed, 'a.png'),
      mediaLocalRoots: [tree.allowed],
    } as never);
    expect(upload).toHaveBeenCalledTimes(1);

    const err = await rejection(
      maxOutboundAdapter.sendMedia!({
        cfg,
        to: '-7001',
        text: '',
        mediaUrl: join(tree.outside, 'secret.png'),
        mediaLocalRoots: [tree.allowed],
      } as never),
    );
    expect(err.message).toMatch(NOT_ALLOWED);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('sendPayload checks every media item', async () => {
    await maxOutboundAdapter.sendPayload!({
      cfg,
      to: '-7001',
      text: 'two',
      payload: {
        text: 'two',
        mediaUrls: [join(tree.allowed, 'a.png'), join(tree.outside, 'secret.png')],
      },
      mediaLocalRoots: [tree.allowed],
    } as never).catch(() => undefined);

    expect(upload.mock.calls.map((call) => call[3])).toEqual(['a.png']);
  });

  it('agent reply media outside the agent roots is refused as not dispatched', async () => {
    const err = await rejection(
      deliverMaxReply({
        payload: { mediaUrls: [join(tree.outside, 'secret.png')] },
        account: { accountId: 'default', enabled: true, token: 't', config: {} } as never,
        chatId: '-7001',
        config: cfg as never,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        localMedia: { mediaLocalRoots: [tree.allowed] },
      }),
    );

    expect(err).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(err.message).toMatch(NOT_ALLOWED);
    expect(upload).not.toHaveBeenCalled();
  });

  it('agent reply media inside the agent roots is sent', async () => {
    await deliverMaxReply({
      payload: { mediaUrls: [join(tree.allowed, 'doc.pdf')] },
      account: { accountId: 'default', enabled: true, token: 't', config: {} } as never,
      chatId: '-7001',
      config: cfg as never,
      localMedia: { mediaLocalRoots: [tree.allowed] },
    });

    expect(upload).toHaveBeenCalledWith('file', expect.any(Buffer), 'application/pdf', 'doc.pdf');
  });
});

describe('image links go to MAX by URL only for public https hosts', () => {
  function withDownload(impl: () => Promise<unknown>) {
    const fetchRemoteMedia = vi.fn(impl);
    setMaxRuntime({ channel: { media: { fetchRemoteMedia } } } as never);
    return fetchRemoteMedia;
  }

  it('passes a public https image by URL, without a download', async () => {
    const fetchRemoteMedia = withDownload(async () => ({ buffer: PNG }));

    await sendMaxMediaMessage('-7001', '', 'https://cdn.example.org/pic.png', { token: 't' });

    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0].attachments).toEqual([
      { type: 'image', payload: { url: 'https://cdn.example.org/pic.png' } },
    ]);
  });

  it.each([
    'https://127.0.0.1/pic.png',
    'https://10.1.2.3/pic.jpg',
    'https://169.254.169.254/latest.png',
    'https://printer.local/scan.png',
  ])('never hands %s to MAX; the guarded download decides', async (url) => {
    const fetchRemoteMedia = withDownload(async () => {
      throw new Error('Blocked hostname or private/internal/special-use IP address');
    });

    const err = await rejection(sendMaxMediaMessage('-7001', '', url, { token: 't' }));

    expect(err.message).toMatch(/Blocked/);
    expect(fetchRemoteMedia).toHaveBeenCalledWith(expect.objectContaining({ url }));
    expect(send).not.toHaveBeenCalled();
  });

  // Core's local-file loader fetches http(s) URLs of any case itself, past
  // the account proxy: a URL of any case goes to the runtime fetcher.
  it.each(['HTTP://127.0.0.1/pic.png', 'Https://cdn.example.org/doc.pdf'])(
    'downloads %s through the runtime fetcher (account proxy), not the local loader',
    async (url) => {
      const fetchRemoteMedia = withDownload(async () => {
        throw new Error('Blocked hostname or private/internal/special-use IP address');
      });

      await rejection(sendMaxMediaMessage('-7001', '', url, { token: 't' }));

      expect(fetchRemoteMedia).toHaveBeenCalledWith(expect.objectContaining({ url }));
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('uploads instead when the host resolves to a private address', async () => {
    vi.mocked(resolvePinnedHostnameWithPolicy).mockRejectedValueOnce(new Error('private'));
    const fetchRemoteMedia = withDownload(async () => ({
      buffer: PNG,
      contentType: 'image/png',
      fileName: 'pic.png',
    }));

    await sendMaxMediaMessage('-7001', '', 'https://rebind.example.org/pic.png', { token: 't' });

    expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].attachments).toEqual([
      { type: 'image', payload: { token: 'tok:image:pic.png' } },
    ]);
  });
});
