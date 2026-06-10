/**
 * MAX channel message actions adapter — implements message tool actions
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-runtime";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import { listMaxAccountIds, resolveMaxAccount } from "./accounts.js";
import { getLastStickerCode } from "./sticker-cache.js";
import { sendMaxMessage, editMaxMessage, deleteMaxMessage, sendMaxMediaMessage, sendMaxSticker, sendMaxContact, sendMaxLocation } from "./send.js";
import { getMaxRuntime } from "./runtime.js";

const providerId = "max";

function listEnabledAccounts(cfg: OpenClawConfig) {
  return listMaxAccountIds(cfg)
    .map((accountId) => resolveMaxAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.token);
}

export const maxMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg }) => {
    const accounts = listEnabledAccounts(cfg);
    if (accounts.length === 0) {
      return null;
    }
    return {
      actions: ["send", "edit", "delete", "sticker", "sendAttachment"],
      capabilities: ["buttons"] as unknown as readonly ("presentation" | "delivery-pin")[],
    };
  },

  extractToolSend: ({ args }: { args: Record<string, unknown> }) => {
    // Extract routing info for ALL actions (send, edit, delete, sticker)
    // Core uses extractToolSend for routing all message tool actions to plugin
    let to = typeof args.target === "string" ? args.target : undefined;
    if (!to) {
      // For edit/delete, target may not be present — use a placeholder
      // so core still routes to this plugin's handleAction
      to = typeof args.messageId === "string" ? "__message_action__" : undefined;
    }
    if (!to) {
      return null;
    }
    // Strip provider prefix (e.g. "max:188862440" → "188862440")
    if (to.startsWith("max:")) to = to.slice(4);
    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
  },

  handleAction: async ({ action, params, cfg, accountId }) => {
    const account = resolveMaxAccount({
      cfg,
      accountId,
    });
    if (!account.token) {
      throw new Error("MAX bot token not configured");
    }

    // Strip provider prefix from target (e.g. "max:188862440" → "188862440")
    const stripPrefix = (val: string | undefined): string | undefined => {
      if (!val) return val;
      return val.startsWith("max:") ? val.slice(4) : val;
    };

    if (action === "send") {
      const to = stripPrefix(readStringParam(params, "target", { required: true }))!;
      const content = readStringParam(params, "message", {
        required: true,
        allowEmpty: true,
      });
      const mediaUrl = readStringParam(params, "media", { trim: false });
      const buffer = readStringParam(params, "buffer", { trim: false });
      const filePath = readStringParam(params, "filePath", { trim: false });
      const replyTo = readStringParam(params, "replyTo");
      const stickerId = readStringParam(params, "stickerId");

      // Parse inline keyboard buttons: [[{text, callback_data?, url?}]]
      let buttons: Array<Array<{ text: string; payload?: string; url?: string }>> | undefined;
      if (params.buttons && Array.isArray(params.buttons)) {
        buttons = (params.buttons as Array<Array<Record<string, unknown>>>).map((row) =>
          (Array.isArray(row) ? row : [row]).map((btn) => ({
            text: String(btn.text ?? btn.label ?? ""),
            payload: btn.callback_data ? String(btn.callback_data) : btn.payload ? String(btn.payload) : undefined,
            url: btn.url ? String(btn.url) : undefined,
          }))
        );
      }

      // Sticker sending (by sticker code)
      if (stickerId) {
        // stickerId can be a single id or comma-separated
        const codes = Array.isArray(params.stickerId)
          ? (params.stickerId as string[])
          : [stickerId];
        const firstCode = codes[0];
        if (firstCode) {
          const result = await sendMaxSticker(to, firstCode, {
            token: account.token,
            replyToMessageId: replyTo ?? undefined,
          });
          return jsonResult({ ok: true, to, messageId: result.messageId });
        }
      }

      // Location sending: if location param contains coords or lat/lng params exist
      const locationStr = readStringParam(params, "location");
      const latStr = params.latitude != null ? String(params.latitude) : undefined;
      const lngStr = params.longitude != null ? String(params.longitude) : undefined;
      if (locationStr || (latStr && lngStr)) {
        let lat: number | undefined;
        let lng: number | undefined;
        if (latStr && lngStr) {
          lat = parseFloat(latStr);
          lng = parseFloat(lngStr);
        } else if (locationStr) {
          // Try to parse "lat,lng" or "lat lng" format
          const m = locationStr.match(/(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)/);
          if (m) {
            lat = parseFloat(m[1]);
            lng = parseFloat(m[2]);
          }
        }
        if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
          const result = await sendMaxLocation(to, { latitude: lat, longitude: lng }, content || undefined, {
            token: account.token,
            replyToMessageId: replyTo ?? undefined,
            format: "markdown",
          });
          return jsonResult({ ok: true, to, messageId: result.messageId });
        }
      }

      // Contact sending: if contactName param exists
      const contactName = readStringParam(params, "contactName");
      if (contactName) {
        const contactId = params.contactId != null ? Number(params.contactId) : undefined;
        const vcfPhone = readStringParam(params, "vcfPhone") ?? readStringParam(params, "phone");
        const result = await sendMaxContact(to, {
          name: contactName,
          contactId: contactId && !isNaN(contactId) ? contactId : undefined,
          vcfPhone: vcfPhone ?? undefined,
        }, {
          token: account.token,
          replyToMessageId: replyTo ?? undefined,
        });
        return jsonResult({ ok: true, to, messageId: result.messageId });
      }

      // Resolve media source: media param, buffer (local path), or filePath
      const mediaSource = mediaUrl || buffer || filePath;

      if (mediaSource) {
        // Upload media from URL or local path
        const core = getMaxRuntime();
        
        // Download if URL, otherwise use as local file path
        if (mediaSource.startsWith("http://") || mediaSource.startsWith("https://")) {
          const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
          const loaded = await core.channel.media.fetchRemoteMedia({ url: mediaSource, maxBytes });
          
          // Write to temp file
          const fs = await import("fs/promises");
          const tmpPath = `/tmp/max-media-${Date.now()}-${loaded.fileName ?? "file"}`;
          await fs.writeFile(tmpPath, loaded.buffer);
          
          try {
            const result = await sendMaxMediaMessage(to, content, tmpPath, {
              token: account.token,
              replyToMessageId: replyTo ?? undefined,
              format: "markdown",
            });
            return jsonResult({ ok: true, to, messageId: result.messageId });
          } finally {
            // Cleanup
            await fs.unlink(tmpPath).catch(() => {});
          }
        } else {
          // Local file path (from media, buffer, or filePath params)
          const result = await sendMaxMediaMessage(to, content, mediaSource, {
            token: account.token,
            replyToMessageId: replyTo ?? undefined,
            format: "markdown",
          });
          return jsonResult({ ok: true, to, messageId: result.messageId });
        }
      }

      const result = await sendMaxMessage(to, content, {
        token: account.token,
        replyToMessageId: replyTo ?? undefined,
        format: "markdown",
        buttons,
      });
      return jsonResult({ ok: true, to, messageId: result.messageId });
    }

    if (action === "edit") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const text = readStringParam(params, "message", {
        required: true,
        allowEmpty: true,
      });
      await editMaxMessage(messageId, text, {
        token: account.token,
        format: "markdown",
      });
      return jsonResult({ ok: true, messageId });
    }

    if (action === "delete") {
      const messageId = readStringParam(params, "messageId", { required: true });
      await deleteMaxMessage(messageId, {
        token: account.token,
      });
      return jsonResult({ ok: true, messageId });
    }

    if (action === "sticker") {
      const to = stripPrefix(readStringParam(params, "to") ?? readStringParam(params, "target", { required: true }))!;
      // stickerId may come as string or string[] from message tool schema
      const rawStickerId = params.stickerId;
      let stickerCode: string | undefined = Array.isArray(rawStickerId)
        ? (rawStickerId[0] as string)?.trim()
        : readStringParam(params, "stickerId") ?? readStringParam(params, "fileId");
      // Auto-fill from last received sticker if not provided
      if (!stickerCode) {
        stickerCode = getLastStickerCode(to) ?? getLastStickerCode() ?? undefined;
      }
      if (!stickerCode) {
        throw new Error("stickerId is required. Send a sticker first, then ask to send it back.");
      }
      const replyTo = readStringParam(params, "replyTo");

      const result = await sendMaxSticker(to, stickerCode, {
        token: account.token,
        replyToMessageId: replyTo ?? undefined,
      });
      return jsonResult({ ok: true, to, messageId: result.messageId });
    }

    if (action === "sendAttachment") {
      const to = stripPrefix(readStringParam(params, "to") ?? readStringParam(params, "target", { required: true }))!;
      const replyTo = readStringParam(params, "replyTo");
      const caption = readStringParam(params, "message") ?? readStringParam(params, "caption") ?? "";
      const attachType = readStringParam(params, "type") ?? readStringParam(params, "attachmentType") ?? "";

      // Location attachment
      if (attachType === "location" || params.latitude != null || params.longitude != null || readStringParam(params, "location")) {
        const locationStr = readStringParam(params, "location");
        let lat: number | undefined;
        let lng: number | undefined;
        if (params.latitude != null && params.longitude != null) {
          lat = parseFloat(String(params.latitude));
          lng = parseFloat(String(params.longitude));
        } else if (locationStr) {
          const m = locationStr.match(/(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)/);
          if (m) { lat = parseFloat(m[1]); lng = parseFloat(m[2]); }
        }
        if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
          const result = await sendMaxLocation(to, { latitude: lat, longitude: lng }, caption || undefined, {
            token: account.token,
            replyToMessageId: replyTo ?? undefined,
          });
          return jsonResult({ ok: true, to, messageId: result.messageId });
        }
        throw new Error("Invalid location: provide latitude/longitude or location='LAT,LNG'");
      }

      // Contact attachment
      if (attachType === "contact" || readStringParam(params, "contactName")) {
        const contactName = readStringParam(params, "contactName") ?? readStringParam(params, "name") ?? "Unknown";
        const contactId = params.contactId != null ? Number(params.contactId) : undefined;
        const vcfPhone = readStringParam(params, "vcfPhone") ?? readStringParam(params, "phone");
        const result = await sendMaxContact(to, {
          name: contactName,
          contactId: contactId && !isNaN(contactId) ? contactId : undefined,
          vcfPhone: vcfPhone ?? undefined,
        }, {
          token: account.token,
          replyToMessageId: replyTo ?? undefined,
        });
        return jsonResult({ ok: true, to, messageId: result.messageId });
      }

      throw new Error("sendAttachment: unknown type. Use type='location' or type='contact'");
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
