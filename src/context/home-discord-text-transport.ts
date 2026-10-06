import { createHash } from 'node:crypto';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const MAX_RESPONSE_BYTES = 65_536;
const SNOWFLAKE = /^[0-9]{17,20}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9]{1,25}$/;

export interface HomeDiscordTextRequest {
  guildId: string;
  channelId: string;
  text: string;
  textBytes: number;
  textHash: string;
  nonce: string;
}

export interface HomeDiscordMessageEvidence {
  statusCode: 200;
  messageId: string;
  guildId: string;
  channelId: string;
  nonce: string;
  textBytes: number;
  textHash: string;
  observedAt: number;
}

export type HomeDiscordTextTransportErrorCode =
  | 'invalid_request'
  | 'prepare_rejected'
  | 'dispatch_uncertain'
  | 'response_uncertain';

export class HomeDiscordTextTransportError extends Error {
  constructor(
    readonly disposition: 'pre_dispatch_rejected' | 'issuance_uncertain',
    readonly code: HomeDiscordTextTransportErrorCode,
  ) {
    super(`home Discord text ${disposition}: ${code}`);
    this.name = 'HomeDiscordTextTransportError';
  }
}

export interface HomeDiscordTextTransport {
  send(
    request: HomeDiscordTextRequest,
    beforeDispatch: () => void,
  ): Promise<HomeDiscordMessageEvidence>;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateRequest(request: HomeDiscordTextRequest): void {
  const bytes = Buffer.byteLength(request.text, 'utf8');
  if (
    !SNOWFLAKE.test(request.guildId) ||
    !SNOWFLAKE.test(request.channelId) ||
    request.text.length === 0 ||
    bytes < 1 ||
    bytes > 1_900 ||
    request.textBytes !== bytes ||
    !SHA256.test(request.textHash) ||
    request.textHash !== hashText(request.text) ||
    !NONCE.test(request.nonce)
  ) {
    throw new HomeDiscordTextTransportError(
      'pre_dispatch_rejected',
      'invalid_request',
    );
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < 0 ||
      parsed > MAX_RESPONSE_BYTES
    ) {
      throw new Error('response body length is invalid');
    }
  }
  if (!response.body) throw new Error('response body is missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new Error('response body is too large');
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function evidenceFromResponse(
  value: unknown,
  request: HomeDiscordTextRequest,
  observedAt: number,
): HomeDiscordMessageEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('response is not a message object');
  }
  const message = value as Record<string, unknown>;
  if (
    typeof message.id !== 'string' ||
    !SNOWFLAKE.test(message.id) ||
    message.guild_id !== request.guildId ||
    message.channel_id !== request.channelId ||
    message.nonce !== request.nonce ||
    message.content !== request.text
  ) {
    throw new Error('response message evidence does not match the request');
  }
  return Object.freeze({
    statusCode: 200 as const,
    messageId: message.id,
    guildId: request.guildId,
    channelId: request.channelId,
    nonce: request.nonce,
    textBytes: request.textBytes,
    textHash: request.textHash,
    observedAt,
  });
}

export function createHomeDiscordTextTransport(input: {
  botToken: string;
  callTimeoutMs: number;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  now?: () => number;
}): HomeDiscordTextTransport {
  if (!input.botToken || /\s/.test(input.botToken)) {
    throw new Error('home Discord text transport requires a bot token');
  }
  const callTimeoutMs = positiveInteger(input.callTimeoutMs, 'callTimeoutMs');
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const apiBase = (input.apiBase ?? DISCORD_API_BASE).replace(/\/$/, '');
  const parsedBase = new URL(apiBase);
  const localHttp =
    parsedBase.protocol === 'http:' &&
    (parsedBase.hostname === '127.0.0.1' || parsedBase.hostname === '[::1]');
  if (parsedBase.protocol !== 'https:' && !localHttp) {
    throw new Error('home Discord text transport requires HTTPS');
  }

  return Object.freeze({
    async send(request: HomeDiscordTextRequest, beforeDispatch: () => void) {
      validateRequest(request);
      const body = JSON.stringify({
        content: request.text,
        nonce: request.nonce,
        enforce_nonce: true,
        allowed_mentions: {
          parse: [],
          users: [],
          roles: [],
          replied_user: false,
        },
      });
      const url = `${apiBase}/channels/${request.channelId}/messages`;
      try {
        const hookResult = beforeDispatch();
        if (hookResult !== undefined)
          throw new Error('prepare hook must be synchronous');
      } catch {
        throw new HomeDiscordTextTransportError(
          'pre_dispatch_rejected',
          'prepare_rejected',
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), callTimeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: {
              authorization: `Bot ${input.botToken}`,
              'content-type': 'application/json',
            },
            body,
          });
        } catch {
          throw new HomeDiscordTextTransportError(
            'issuance_uncertain',
            'dispatch_uncertain',
          );
        }
        if (response.status !== 200) {
          throw new HomeDiscordTextTransportError(
            'issuance_uncertain',
            'response_uncertain',
          );
        }
        try {
          const value = await readBoundedJson(response);
          return evidenceFromResponse(value, request, now());
        } catch (error) {
          if (error instanceof HomeDiscordTextTransportError) throw error;
          throw new HomeDiscordTextTransportError(
            'issuance_uncertain',
            'response_uncertain',
          );
        }
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
