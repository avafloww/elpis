import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config.js';
import { createCodexFetch, usesCodexResponsesLite } from './codex-client.js';
import type { OAuthStore } from './oauth/store.js';
import {
  isPolicyDenial,
  nonSecretHeaders,
  type PolicyDenialManifest,
} from './policy-flight-recorder.js';

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeExclusive(file: string, value: Uint8Array | string): void {
  fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
}

export interface ReplayResult {
  status: number;
  reproducesPolicyDenial: boolean;
  requestBodySha256: string;
  responseBodySha256: string;
  resultPath: string;
}

export async function replayPolicyDenial(
  config: Config,
  store: OAuthStore,
  target: string,
  fetchFn: typeof fetch = fetch,
): Promise<ReplayResult> {
  const resolved = path.resolve(target);
  const manifestPath = fs.statSync(resolved).isDirectory()
    ? path.join(resolved, 'manifest.json')
    : resolved;
  const bundle = path.dirname(manifestPath);
  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, 'utf8'),
  ) as PolicyDenialManifest;
  if (manifest.schemaVersion !== 1 || manifest.provider !== 'codex-responses') {
    throw new Error(
      `unsupported replay bundle: schema=${manifest.schemaVersion} provider=${manifest.provider}`,
    );
  }
  const requestBody = new Uint8Array(
    fs.readFileSync(path.join(bundle, manifest.request.bodyFile)),
  );
  const actualHash = sha256(requestBody);
  if (actualHash !== manifest.request.bodySha256) {
    throw new Error(
      `request body hash mismatch: manifest=${manifest.request.bodySha256} actual=${actualHash}`,
    );
  }
  const headers = new Headers(manifest.request.headers);
  const session =
    headers.get('session_id') ??
    headers.get('conversation_id') ??
    crypto.randomUUID();
  const model = (() => {
    try {
      return JSON.parse(new TextDecoder().decode(requestBody)).model as
        string | undefined;
    } catch {
      return undefined;
    }
  })();
  const responsesLite =
    headers.has('x-openai-internal-codex-responses-lite') ||
    (model ? usesCodexResponsesLite(model) : false);
  const authenticated = createCodexFetch(
    store,
    () => session,
    fetchFn,
    responsesLite,
    undefined,
    true,
  );
  const response = await authenticated(manifest.request.url, {
    method: manifest.request.method,
    headers,
    body: requestBody,
    redirect: 'error',
  });
  const responseBody = new Uint8Array(await response.arrayBuffer());
  const root = path.join(bundle, 'replay-results');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const resultDirectory = path.join(
    root,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(resultDirectory, { mode: 0o700 });
  writeExclusive(path.join(resultDirectory, 'response-body.bin'), responseBody);
  const result = {
    schemaVersion: 1,
    replayedAt: new Date().toISOString(),
    sourceManifest: manifestPath,
    sourceManifestSha256: sha256(new Uint8Array(fs.readFileSync(manifestPath))),
    requestBodySha256: actualHash,
    preservedSessionId: session,
    status: response.status,
    statusText: response.statusText,
    headers: nonSecretHeaders(response.headers),
    responseBodyFile: 'response-body.bin',
    responseBodyBytes: responseBody.byteLength,
    responseBodySha256: sha256(responseBody),
    reproducesPolicyDenial: isPolicyDenial(
      new TextDecoder().decode(responseBody),
    ),
  };
  const resultPath = path.join(resultDirectory, 'result.json');
  writeExclusive(resultPath, JSON.stringify(result, null, 2) + '\n');
  return {
    status: result.status,
    reproducesPolicyDenial: result.reproducesPolicyDenial,
    requestBodySha256: result.requestBodySha256,
    responseBodySha256: result.responseBodySha256,
    resultPath,
  };
}
