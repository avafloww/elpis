import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config.js';
import { resolveDataLayout } from '../store/data-layout.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SECRET_HEADERS =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|chatgpt-account-id)$/i;
const SECRET_FIELDS =
  /^(authorization|proxyAuthorization|cookie|setCookie|access[_-]?token|refresh[_-]?token|api[_-]?key|chatgpt[_-]?account[_-]?id)$/i;

export interface WireRequestCapture {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface WireResponseCapture {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
  bodyComplete?: boolean;
  captureTrigger?:
    'http-status' | 'stream-policy-event' | 'stream-policy-bytes';
}

export interface PolicyDenialManifest {
  schemaVersion: 1;
  createdAt: string;
  provider: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    bodyFile: 'request-body.bin';
    bodyBytes: number;
    bodySha256: string;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyFile: 'response-body.bin';
    bodyBytes: number;
    bodySha256: string;
    bodyComplete: boolean;
    captureTrigger:
      'http-status' | 'stream-policy-event' | 'stream-policy-bytes';
  };
  error: unknown;
  replay: {
    command: string;
    note: string;
  };
}

export interface PolicyDenialRecord {
  directory: string;
  manifestPath: string;
  manifestSha256: string;
}

function denialText(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    const cause =
      'cause' in value
        ? (value as Error & { cause?: unknown }).cause
        : undefined;
    return `${value.name} ${value.message} ${denialText(cause, depth + 1)}`;
  }
  if (typeof value !== 'object') return String(value);
  const object = value as Record<string, unknown>;
  return ['name', 'message', 'type', 'code', 'error', 'cause', 'body']
    .map((key) => denialText(object[key], depth + 1))
    .join(' ');
}

export function isPolicyDenial(value: unknown): boolean {
  const text = denialText(value);
  return /flagged[\s\S]{0,240}usage policy|usage policy[\s\S]{0,240}flagged/i.test(
    text,
  );
}

function safeClone(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol')
    return String(value);
  if (value instanceof Error) {
    const object = value as Error & Record<string, unknown>;
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const key of Object.keys(object))
      out[key] = SECRET_FIELDS.test(key)
        ? '[redacted]'
        : safeClone(object[key], seen);
    if ('cause' in value)
      out.cause = safeClone((value as Error & { cause?: unknown }).cause, seen);
    return out;
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => safeClone(entry, seen));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>))
    out[key] = SECRET_FIELDS.test(key) ? '[redacted]' : safeClone(entry, seen);
  return out;
}

export function nonSecretHeaders(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (!SECRET_HEADERS.test(key)) kept[key] = value;
  });
  return kept;
}

function sha256(bytes: Uint8Array | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeExclusive(file: string, bytes: Uint8Array | string): void {
  fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
}

function prune(root: string, now = Date.now()): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    let createdAt: number;
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'),
      ) as { createdAt?: unknown };
      createdAt =
        typeof manifest.createdAt === 'string'
          ? Date.parse(manifest.createdAt)
          : Number.NaN;
    } catch {
      continue;
    }
    if (Number.isFinite(createdAt) && now - createdAt > RETENTION_MS) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

export function recordPolicyDenial(
  config: Config,
  provider: string,
  request: WireRequestCapture,
  response: WireResponseCapture,
  error: unknown,
): PolicyDenialRecord | null {
  if (
    !isPolicyDenial(error) &&
    !isPolicyDenial(new TextDecoder().decode(response.body))
  )
    return null;
  const root = resolveDataLayout(config.paths.dataDirectory).policyDenials;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const now = new Date();
  const name = `${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { mode: 0o700 });
  const requestFile = path.join(directory, 'request-body.bin');
  const responseFile = path.join(directory, 'response-body.bin');
  writeExclusive(requestFile, request.body);
  writeExclusive(responseFile, response.body);
  const manifest: PolicyDenialManifest = {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    provider,
    request: {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(request.headers).filter(
          ([key]) => !SECRET_HEADERS.test(key),
        ),
      ),
      bodyFile: 'request-body.bin',
      bodyBytes: request.body.byteLength,
      bodySha256: sha256(request.body),
    },
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(
        Object.entries(response.headers).filter(
          ([key]) => !SECRET_HEADERS.test(key),
        ),
      ),
      bodyFile: 'response-body.bin',
      bodyBytes: response.body.byteLength,
      bodySha256: sha256(response.body),
      bodyComplete: response.bodyComplete ?? true,
      captureTrigger: response.captureTrigger ?? 'http-status',
    },
    error: safeClone(error),
    replay: {
      command: `npm run replay-policy-denial -- ${directory}`,
      note: 'Replays exact method/body/non-secret headers with fresh local authentication. It appends a result inside replay-results/ and never mutates this manifest.',
    },
  };
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  const manifestPath = path.join(directory, 'manifest.json');
  writeExclusive(manifestPath, manifestText);
  prune(root);
  return { directory, manifestPath, manifestSha256: sha256(manifestText) };
}
