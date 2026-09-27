/**
 * Argument menus for core commands. A bare command whose core definition
 * declares an argument menu (argsMenu: /think, /fast, /reasoning, /verbose,
 * /usage, /tts, …) gets its choices as buttons; a press re-enters the inbound
 * pipeline as that command's text, so it is applied exactly like typing it.
 *
 * Choices, titles and command text come from the core command registry;
 * session state is only read through the runtime session API. Nothing here
 * changes the session or the config: the chosen command does, in core.
 */

import {
  buildCommandTextFromArgs,
  type ChatCommandDefinition,
  type CommandArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  formatFastModeCurrentStatus,
  listChatCommands,
  normalizeCommandBody,
  parseCommandArgs,
  resolveCommandArgChoices,
  resolveCommandArgMenu,
  resolveCommandAuthorization,
  resolveEffectiveAgentRuntime,
  resolveFastModeState,
  resolveStoredModelOverride,
} from 'openclaw/plugin-sdk/command-auth-native';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';

import { MAX_CALLBACK_PAYLOAD_BYTES } from './presentation.js';
import { getMaxRuntime } from './runtime.js';

type MaxButton = { text: string; payload: string };

type SessionEntry = NonNullable<
  ReturnType<ReturnType<typeof getMaxRuntime>['agent']['session']['getSessionEntry']>
>;

/** Private envelope of a menu button: the command text of one choice. */
const COMMAND_MENU_PREFIX = 'mxcmd1:';

/** Session fields whose stored value is one of the command's choice values. */
const SESSION_CHOICE_FIELDS: Record<string, keyof SessionEntry> = {
  think: 'thinkingLevel',
  verbose: 'verboseLevel',
  reasoning: 'reasoningLevel',
  elevated: 'elevatedLevel',
  trace: 'traceLevel',
  usage: 'responseUsage',
  activation: 'groupActivation',
};

export type MaxCommandMenuDecision =
  /** Not a menu case: the message goes to core as usual. */
  | { kind: 'dispatch' }
  /** Show (or, for a press, replace the pressed menu with) this menu. */
  | { kind: 'menu'; text: string; buttons: MaxButton[][] }
  /** Press by a sender without command rights. */
  | { kind: 'denied' }
  /** Press whose command or choice core no longer offers. */
  | { kind: 'stale' };

export function encodeMaxCommandMenuPayload(commandText: string): string | null {
  const payload = `${COMMAND_MENU_PREFIX}${commandText}`;
  return Buffer.byteLength(payload, 'utf8') <= MAX_CALLBACK_PAYLOAD_BYTES ? payload : null;
}

/** Command text of a menu button press; null for any other payload. */
export function decodeMaxCommandMenuPayload(payload: string | undefined | null): string | null {
  if (!payload?.startsWith(COMMAND_MENU_PREFIX)) return null;
  const text = payload.slice(COMMAND_MENU_PREFIX.length).trim();
  return text.startsWith('/') ? text : null;
}

/** A slash command whose core definition has an argument menu; null otherwise. */
function parseMenuCommand(
  text: string,
  botUsername: string | undefined,
): { command: ChatCommandDefinition; args?: CommandArgs } | null {
  const normalized = normalizeCommandBody(text.trim(), botUsername ? { botUsername } : undefined);
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(normalized);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const command =
    findCommandByNativeName(name, 'max') ??
    listChatCommands().find(
      (entry) => entry.key === name || entry.textAliases.includes(`/${name}`),
    );
  if (!command?.args?.length || !command.argsMenu) return null;
  return { command, args: parseCommandArgs(command, match[2]?.trim() || undefined) };
}

type MenuModelContext = {
  entry?: SessionEntry;
  provider?: string;
  model?: string;
  agentRuntime?: string;
};

/** The session's model (dynamic choices such as /think levels depend on it). */
function resolveMenuModelContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): MenuModelContext {
  const core = getMaxRuntime();
  const { cfg, agentId, sessionKey } = params;
  try {
    const load = (key: string) => core.agent.session.getSessionEntry({ agentId, sessionKey: key });
    const entry = load(sessionKey);
    const defaults = core.modelConfig.resolveDefaultModelForAgent({ cfg, agentId });
    // An automatic fallback override is temporary: menus follow the default.
    const override =
      entry?.modelOverrideSource === 'auto'
        ? null
        : resolveStoredModelOverride({
            sessionEntry: entry,
            loadSessionEntry: load,
            sessionKey,
            defaultProvider: defaults.provider,
          });
    const provider = override?.provider ?? defaults.provider;
    const model = override?.model ?? defaults.model;
    let agentRuntime: string | undefined;
    try {
      agentRuntime = resolveEffectiveAgentRuntime({
        cfg,
        provider,
        modelId: model,
        agentId,
        sessionKey,
        sessionEntry: entry,
      });
    } catch {
      agentRuntime = undefined;
    }
    return { entry, provider, model, agentRuntime };
  } catch {
    return {};
  }
}

/** Every argument value of a pressed command is still among core's choices. */
function isPressStillOffered(
  command: ChatCommandDefinition,
  args: CommandArgs | undefined,
  cfg: OpenClawConfig,
  context: MenuModelContext,
): boolean {
  const values = args?.values ?? {};
  for (const arg of command.args ?? []) {
    const value = values[arg.name];
    if (value == null || !arg.choices) continue;
    const choices = resolveCommandArgChoices({
      command,
      arg,
      cfg,
      provider: context.provider,
      model: context.model,
      agentRuntime: context.agentRuntime,
    });
    if (choices.length > 0 && !choices.some((choice) => choice.value === String(value))) {
      return false;
    }
  }
  return true;
}

function resolveCurrentChoice(
  command: ChatCommandDefinition,
  context: MenuModelContext,
  fastState: ReturnType<typeof resolveFastModeState> | undefined,
): string | undefined {
  if (fastState) {
    if (fastState.source !== 'session') return 'default';
    return fastState.mode === 'auto' ? 'auto' : fastState.mode ? 'on' : 'off';
  }
  const field = SESSION_CHOICE_FIELDS[command.key];
  const stored = field ? context.entry?.[field] : undefined;
  if (typeof stored === 'string' && stored) return stored;
  // Nothing stored for this session: the "default" choice is what applies.
  return 'default';
}

/**
 * Decide what a slash command (typed, or pressed on a menu when `press`) does:
 * open its argument menu, go to core unchanged, or — presses only — be refused
 * for lack of command rights or as stale. `ctx` is the finalized inbound
 * context of the message, so command rights are resolved exactly as core
 * resolves them for the same text.
 */
export function resolveMaxCommandMenu(params: {
  text: string;
  press: boolean;
  ctx: Parameters<typeof resolveCommandAuthorization>[0]['ctx'];
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  botUsername?: string;
}): MaxCommandMenuDecision {
  const { press, cfg, agentId, sessionKey } = params;
  const pass: MaxCommandMenuDecision = press ? { kind: 'stale' } : { kind: 'dispatch' };
  const parsed = parseMenuCommand(params.text, params.botUsername);
  if (!parsed) return pass;
  const { command, args } = parsed;

  const core = getMaxRuntime();
  if (
    !core.channel.commands.shouldHandleTextCommands({ cfg, surface: 'max', commandSource: 'text' })
  ) {
    return pass;
  }
  // Core authorizes MAX text commands with CommandAuthorized unset (false).
  const authorization = resolveCommandAuthorization({
    ctx: params.ctx,
    cfg,
    commandAuthorized: params.ctx.CommandAuthorized === true,
  });
  if (!authorization.isAuthorizedSender) {
    return press ? { kind: 'denied' } : { kind: 'dispatch' };
  }

  const context = resolveMenuModelContext({ cfg, agentId, sessionKey });
  if (press && !isPressStillOffered(command, args, cfg, context)) return { kind: 'stale' };

  const menu = resolveCommandArgMenu({
    command,
    args,
    cfg,
    provider: context.provider,
    model: context.model,
    agentRuntime: context.agentRuntime,
    session: { agentId, sessionKey },
  });
  if (!menu) return { kind: 'dispatch' };

  const fastState =
    command.key === 'fast' && context.provider && context.model
      ? resolveFastModeState({
          cfg,
          provider: context.provider,
          model: context.model,
          agentId,
          sessionEntry:
            context.entry?.fastMode !== undefined
              ? { fastMode: context.entry.fastMode }
              : undefined,
        })
      : undefined;
  const current = resolveCurrentChoice(command, context, fastState);

  let title = formatCommandArgMenuTitle({ command, menu });
  if (fastState) {
    title = `${formatFastModeCurrentStatus(fastState)}\n${title}`;
  } else if (command.key === 'think' && current !== 'default') {
    title = `Current thinking level: ${current}.\n${title}`;
  }

  const buttons: MaxButton[] = [];
  for (const choice of menu.choices) {
    const payload = encodeMaxCommandMenuPayload(
      buildCommandTextFromArgs(command, {
        values: { ...args?.values, [menu.arg.name]: choice.value },
      }),
    );
    if (!payload) continue;
    buttons.push({ text: choice.value === current ? `${choice.label} ✓` : choice.label, payload });
  }
  if (buttons.length === 0) return { kind: 'dispatch' };

  const rows: MaxButton[][] = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }
  return { kind: 'menu', text: title, buttons: rows };
}
