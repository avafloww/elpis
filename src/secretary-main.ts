import { pathToFileURL } from 'node:url';
import { SecretaryHttpClient } from './secretary/client.js';
import type { SecretaryConversationPullReply } from './secretary/conversation.js';
import {
  runSecretaryTurn,
  type SecretaryTurnClient,
} from './secretary/loop.js';

export interface SecretaryEnvironment {
  token: string;
  brokerUrl: string;
  sessionId: string;
  pollMs: number;
}

export interface SecretaryProcessClient extends SecretaryTurnClient {
  pull(signal?: AbortSignal): Promise<SecretaryConversationPullReply['turn']>;
  finish(
    turnId: string,
    response: { role: 'assistant'; content: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface SecretaryProcessOptions {
  env?: NodeJS.ProcessEnv;
  client?: SecretaryProcessClient;
  once?: boolean;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function secretaryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SecretaryEnvironment {
  const token = required(env, 'ELPIS_SECRETARY_TOKEN');
  const brokerUrl = required(env, 'ELPIS_SECRETARY_BROKER_URL');
  const sessionId = required(env, 'ELPIS_SECRETARY_SESSION_ID');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error('ELPIS_SECRETARY_TOKEN is invalid');
  if (!/^sec-[A-Za-z0-9_-]{22}$/.test(sessionId))
    throw new Error('ELPIS_SECRETARY_SESSION_ID is invalid');
  const pollMs = Number(env.ELPIS_SECRETARY_POLL_MS ?? 500);
  if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 5_000)
    throw new Error(
      'ELPIS_SECRETARY_POLL_MS must be an integer from 100 to 5000',
    );
  return { token, brokerUrl, sessionId, pollMs };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('secretary process aborted'));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('secretary process aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function runSecretaryProcess(
  options: SecretaryProcessOptions = {},
): Promise<void> {
  const environment = secretaryEnvironment(options.env);
  const client =
    options.client ??
    new SecretaryHttpClient({
      brokerUrl: environment.brokerUrl,
      token: environment.token,
      sessionId: environment.sessionId,
    });
  const controller = new AbortController();
  const abort = () =>
    controller.abort(new Error('secretary process interrupted'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    while (!controller.signal.aborted) {
      const turn = await client.pull(controller.signal);
      if (!turn) {
        if (options.once) return;
        await wait(environment.pollMs, controller.signal);
        continue;
      }
      const content = await runSecretaryTurn(client, turn, controller.signal);
      await client.finish(
        turn.id,
        { role: 'assistant', content },
        controller.signal,
      );
      if (options.once) return;
    }
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  runSecretaryProcess().catch((error) => {
    console.error(
      `[secretary] fatal: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
