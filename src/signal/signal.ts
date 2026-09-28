import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InboundMessage, InboundMessageAttachment } from '../agent.js';
import type { SignalConfig, SignalContactConfig } from '../config.js';
import type { OutboundDelivery, OutboundSendOptions } from '../types.js';
import {
  formatSignalMarkdown,
  type SignalTextStyle,
} from './format.js';
import {
  createSignalCliClient,
  type SignalCliDiagnostic,
  type SignalCliOptions,
  type SignalCliReceiveNotification,
  type SignalCliState,
} from './signal-cli.js';

const SIGNAL_ROOM_PREFIX = 'signal:dm:';
const MAX_PENDING_INBOUND = 128;
const MAX_SEEN_INBOUND = 4096;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
// Keep schema drift fail-closed: every admitted field is classified below.
const DATA_MESSAGE_FIELDS = new Set([
  'timestamp',
  'message',
  'expiresInSeconds',
  'isExpirationUpdate',
  'viewOnce',
  'groupCallUpdate',
  'isEndSession',
  'isProfileKeyUpdate',
  'hasProfileKey',
  'reaction',
  'quote',
  'payment',
  'mentions',
  'previews',
  'attachments',
  'sticker',
  'remoteDelete',
  'contacts',
  'pollCreate',
  'pollVote',
  'pollTerminate',
  'textStyles',
  'groupInfo',
  'storyContext',
  'pinMessage',
  'unpinMessage',
  'adminDelete',
]);
const SIGNAL_OTHER_ENVELOPE_FIELDS = [
  'editMessage',
  'storyMessage',
  'syncMessage',
  'callMessage',
  'receiptMessage',
  'typingMessage',
] as const;
const SIGNAL_EFFECT_FIELDS = [
  'groupCallUpdate',
  'reaction',
  'payment',
  'sticker',
  'remoteDelete',
  'contacts',
  'pollCreate',
  'pollVote',
  'pollTerminate',
  'groupInfo',
  'pinMessage',
  'unpinMessage',
  'adminDelete',
] as const;

export interface SignalCliLike {
  readonly state: SignalCliState;
  onReceive(
    handler: (value: SignalCliReceiveNotification) => void,
  ): () => void;
  onStateChange(handler: (state: SignalCliState) => void): () => void;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  sendText(
    recipient: string,
    message: string,
    styles?: readonly SignalTextStyle[],
  ): Promise<{ status: 'accepted' }>;
  stop(): Promise<void>;
}

export interface SignalTransportDeps {
  enqueue(message: InboundMessage): void;
  isMuted(channelId: string): boolean;
  clientFactory?(options: SignalCliOptions): SignalCliLike;
  diagnostic?(event: SignalTransportDiagnostic): void;
}

export type SignalTransportDiagnostic =
  | SignalCliDiagnostic
  | 'pending_inbound_overflow'
  | 'client_unavailable';

export interface SignalTransport {
  owns(channelId: string): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(
    channelId: string,
    content: string,
    opts?: OutboundSendOptions,
  ): Promise<OutboundDelivery>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function emitDiagnostic(
  diagnostic: SignalTransportDeps['diagnostic'],
  event: SignalTransportDiagnostic,
): void {
  try {
    diagnostic?.(event);
  } catch {
    // Diagnostics never supervise transport behavior.
  }
}

function admissibleDataMessage(value: Record<string, unknown>): boolean {
  if (Object.keys(value).some((field) => !DATA_MESSAGE_FIELDS.has(field))) {
    return false;
  }
  for (const field of SIGNAL_EFFECT_FIELDS) {
    if (hasOwn(value, field)) return false;
  }
  for (const field of ['previews', 'mentions', 'textStyles'] as const) {
    if (hasOwn(value, field) && !Array.isArray(value[field])) return false;
  }
  for (const field of ['quote', 'storyContext'] as const) {
    if (hasOwn(value, field) && !isObject(value[field])) return false;
  }
  if (
    hasOwn(value, 'expiresInSeconds') &&
    (!Number.isSafeInteger(value.expiresInSeconds) || value.expiresInSeconds !== 0)
  ) {
    return false;
  }
  for (const field of [
    'isExpirationUpdate',
    'viewOnce',
    'isEndSession',
    'isProfileKeyUpdate',
  ] as const) {
    if (hasOwn(value, field) && value[field] !== false) return false;
  }
  if (hasOwn(value, 'hasProfileKey') && typeof value.hasProfileKey !== 'boolean') {
    return false;
  }
  return true;
}

function signalAttachmentName(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  const name = path.posix.basename(value.trim().replaceAll('\\', '/'));
  return Buffer.byteLength(name) <= 255 ? name : fallback;
}

/** signal-cli downloads before notification and exposes only a local basename.
 * Keep that child-owned file inside its private attachment root before passing
 * the ordinary attachment envelope onward. */
function signalAttachments(
  value: unknown,
  dataDir: string,
): { attachments: InboundMessageAttachment[]; captions: string[] } | null {
  if (value === undefined) return { attachments: [], captions: [] };
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return null;

  const attachmentsDir = path.resolve(dataDir, 'attachments');
  const attachments: InboundMessageAttachment[] = [];
  const captions: string[] = [];
  for (const raw of value) {
    if (!isObject(raw)) return null;
    const id = raw.id;
    if (
      typeof id !== 'string' ||
      !ATTACHMENT_ID_RE.test(id) ||
      id === '.' ||
      id === '..'
    ) {
      return null;
    }
    const localPath = path.resolve(attachmentsDir, id);
    if (path.dirname(localPath) !== attachmentsDir) return null;
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(localPath);
    } catch {
      return null;
    }
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size > MAX_ATTACHMENT_BYTES
    ) {
      return null;
    }
    const contentType =
      typeof raw.contentType === 'string' &&
      raw.contentType.length > 0 &&
      raw.contentType.length <= 255
        ? raw.contentType
        : null;
    const caption = raw.caption;
    if (typeof caption === 'string' && caption.trim().length > 0) {
      captions.push(caption);
    }
    attachments.push({
      url: `signal:attachment:${encodeURIComponent(id)}`,
      name: signalAttachmentName(raw.filename, id),
      contentType,
      localPath,
      size: stats.size,
      inlineText: null,
    });
  }
  return { attachments, captions };
}

class ConfiguredSignalTransport implements SignalTransport {
  private readonly byAci = new Map<string, SignalContactConfig>();
  private readonly pendingInbound: InboundMessage[] = [];
  private readonly seenInbound = new Set<string>();
  private readonly seenOrder: string[] = [];
  private client: SignalCliLike | null = null;
  private unsubscribeReceive: (() => void) | null = null;
  private unsubscribeState: (() => void) | null = null;
  private ready = false;
  private starting: Promise<void> | null = null;
  private failed = false;

  constructor(
    private readonly config: SignalConfig,
    private readonly deps: SignalTransportDeps,
  ) {
    for (const contact of Object.values(config.contacts)) {
      this.byAci.set(contact.aci, contact);
    }
  }

  owns(channelId: string): boolean {
    return this.contactForRoom(channelId) !== null;
  }

  start(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.failed)
      return Promise.reject(new Error('Signal transport is unavailable'));
    this.starting = this.startOnce();
    return this.starting;
  }

  private async startOnce(): Promise<void> {
    const create = this.deps.clientFactory ?? createSignalCliClient;
    const client = create({
      command: this.config.executable!,
      dataDir: this.config.dataDir!,
      account: this.config.account!,
      requestTimeoutMs: this.config.requestTimeoutMs,
      diagnostic: (event) => emitDiagnostic(this.deps.diagnostic, event),
    });
    this.client = client;
    this.unsubscribeReceive = client.onReceive((value) =>
      this.handleReceive(value),
    );
    this.unsubscribeState = client.onStateChange((state) => {
      if (state === 'unavailable') {
        this.ready = false;
        emitDiagnostic(this.deps.diagnostic, 'client_unavailable');
      }
    });
    try {
      const version = await client.request('version', {});
      if (
        !isObject(version) ||
        typeof version.version !== 'string' ||
        version.version !== this.config.expectedVersion
      ) {
        throw new Error('signal-cli version mismatch');
      }
      this.ready = true;
      for (const message of this.pendingInbound.splice(0)) {
        this.deps.enqueue(message);
      }
    } catch (error) {
      this.failed = true;
      this.pendingInbound.length = 0;
      this.unsubscribeReceive?.();
      this.unsubscribeReceive = null;
      this.unsubscribeState?.();
      this.unsubscribeState = null;
      await client.stop().catch(() => {});
      if (error instanceof Error && error.message === 'signal-cli version mismatch')
        throw error;
      throw new Error('Signal transport failed to start');
    }
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.pendingInbound.length = 0;
    this.unsubscribeReceive?.();
    this.unsubscribeReceive = null;
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    const client = this.client;
    this.client = null;
    if (client) await client.stop();
  }

  async send(
    channelId: string,
    content: string,
    opts?: OutboundSendOptions,
  ): Promise<OutboundDelivery> {
    const contact = this.contactForRoom(channelId);
    if (!contact)
      throw new Error('Signal destination is not configured');
    if (!contact.allowSend)
      throw new Error(`sending to signal:${contact.alias} is disabled (allow_send=false)`);
    if (
      opts?.replyTo !== undefined ||
      opts?.mentions !== undefined ||
      (opts?.files?.length ?? 0) > 0
    ) {
      throw new Error('Signal transport is text-only; reply, mention, and file options are unsupported');
    }
    if (!this.ready || !this.client || this.client.state !== 'running')
      throw new Error('Signal transport is unavailable');
    if (this.deps.isMuted(channelId))
      throw new Error(`Signal channel signal:${contact.alias} is muted`);
    const formatted = formatSignalMarkdown(content);
    await this.client.sendText(contact.aci, formatted.text, formatted.styles);
    return { signal: { status: 'accepted' } };
  }

  private contactForRoom(channelId: string): SignalContactConfig | null {
    if (!channelId.startsWith(SIGNAL_ROOM_PREFIX)) return null;
    const aci = channelId.slice(SIGNAL_ROOM_PREFIX.length);
    return this.byAci.get(aci) ?? null;
  }

  private handleReceive(value: SignalCliReceiveNotification): void {
    const message = this.toInbound(value.envelope);
    if (!message) return;
    if (!this.ready) {
      if (this.pendingInbound.length >= MAX_PENDING_INBOUND) {
        emitDiagnostic(this.deps.diagnostic, 'pending_inbound_overflow');
        return;
      }
      this.pendingInbound.push(message);
      return;
    }
    this.deps.enqueue(message);
  }

  private toInbound(envelope: Record<string, unknown>): InboundMessage | null {
    if (SIGNAL_OTHER_ENVELOPE_FIELDS.some((field) => hasOwn(envelope, field))) {
      return null;
    }
    const sourceUuid = envelope.sourceUuid;
    if (typeof sourceUuid !== 'string' || sourceUuid === this.config.account)
      return null;
    const contact = this.byAci.get(sourceUuid);
    if (!contact?.receive) return null;
    const dataMessage = envelope.dataMessage;
    if (!isObject(dataMessage) || !admissibleDataMessage(dataMessage)) return null;
    const parsedAttachments = signalAttachments(
      dataMessage.attachments,
      this.config.dataDir!,
    );
    if (!parsedAttachments) return null;
    const rawContent = dataMessage.message;
    if (
      rawContent !== undefined &&
      rawContent !== null &&
      typeof rawContent !== 'string'
    ) {
      return null;
    }
    let content = typeof rawContent === 'string' ? rawContent : '';
    if (content.trim().length === 0 && parsedAttachments.captions.length > 0) {
      content = parsedAttachments.captions.join('\n');
    }
    if (
      (content.trim().length === 0 && parsedAttachments.attachments.length === 0) ||
      Buffer.byteLength(content) > MAX_TEXT_BYTES
    ) {
      return null;
    }
    const timestamp = dataMessage.timestamp ?? envelope.timestamp;
    if (!Number.isSafeInteger(timestamp) || (timestamp as number) <= 0)
      return null;
    const id = `signal:${contact.alias}:${timestamp}`;
    if (this.seenInbound.has(id)) return null;
    this.seenInbound.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > MAX_SEEN_INBOUND) {
      const oldest = this.seenOrder.shift();
      if (oldest) this.seenInbound.delete(oldest);
    }
    return {
      kind: 'signal',
      transport: 'signal',
      id,
      channelId: `${SIGNAL_ROOM_PREFIX}${contact.aci}`,
      channelName: `signal:${contact.alias}`,
      author: contact.displayName,
      authorId: `signal:${contact.alias}`,
      content,
      createdAt: new Date(timestamp as number).toISOString(),
      replyTo: null,
      forwarded: null,
      mentions: [],
      attachments: parsedAttachments.attachments,
      wakeClass: 'wake',
    };
  }
}

export function createSignalTransport(
  config: SignalConfig,
  deps: SignalTransportDeps,
): SignalTransport | null {
  if (!config.enabled) return null;
  return new ConfiguredSignalTransport(config, deps);
}
