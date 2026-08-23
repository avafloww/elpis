// oauth-login.ts — interactive subscription login for OAuth provider types.
// Run `npm run oauth-login` for Anthropic (backward-compatible default), or
// `npm run oauth-login -- codex` for OpenAI Codex device-code authentication.
//
// Prints the authorize URL, waits for the operator to approve in a browser and
// paste the resulting `code#state`, or drives Codex's device flow. Credentials
// are written to elpis-data/elpis.db and refreshed automatically by the harness.

import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfigFile } from '../src/config.js';
import { ensureDataDirectory } from '../src/config.js';
import { openDatabase } from '../src/store/db.js';
import { migrateDataLayout } from '../src/store/data-layout.js';
import { OAuthStore } from '../src/llm/oauth/store.js';
import {
  startAnthropicLogin,
  exchangeAnthropicCode,
  refreshAnthropicToken,
  ANTHROPIC_OAUTH_GRANT_TTL_MS,
} from '../src/llm/oauth/anthropic.js';
import {
  OPENAI_CODEX_CREDENTIAL_KEY,
  loginOpenAICodexDevice,
  refreshOpenAICodexToken,
} from '../src/llm/oauth/openai-codex.js';

async function loginAnthropic(
  db: ReturnType<typeof openDatabase>,
): Promise<void> {
  const { url, pkce, state } = startAnthropicLogin();
  const rl = readline.createInterface({ input: stdin, output: stdout });

  stdout.write('\nClaude subscription login (Pro/Max)\n');
  stdout.write('1. Open this URL in a browser and approve access:\n\n');
  stdout.write(`   ${url}\n\n`);
  stdout.write(
    '2. After approving, the page shows an authorization code (of the form `code#state`).\n',
  );
  const pasted = (await rl.question('   Paste it here: ')).trim();
  rl.close();

  if (!pasted) {
    stdout.write('No code entered — aborting.\n');
    process.exitCode = 1;
    return;
  }

  stdout.write('\nExchanging code…\n');
  const creds = await exchangeAnthropicCode(pasted, pkce, state);
  const store = new OAuthStore(db, 'anthropic', refreshAnthropicToken);
  store.write(creds);

  const who = creds.email
    ? `${creds.email}${creds.orgName ? ` (${creds.orgName})` : ''}`
    : 'unknown account';
  const grantExpiry = new Date(
    (creds.authorizedAt ?? Date.now()) + ANTHROPIC_OAUTH_GRANT_TTL_MS,
  );
  stdout.write(`\n✓ Logged in as ${who}\n`);
  stdout.write(`  credential: ${store.location}\n`);
  stdout.write(
    `  the grant expires ~${grantExpiry.toISOString().slice(0, 10)} (≈30 days) — re-run this to renew.\n`,
  );
  stdout.write(
    '\nSet `llm.provider_type: anthropic-oauth` (and llm.model) in config.yaml, then restart the harness.\n',
  );
}

async function loginCodex(db: ReturnType<typeof openDatabase>): Promise<void> {
  stdout.write('\nOpenAI Codex subscription login (ChatGPT device code)\n');
  const creds = await loginOpenAICodexDevice({
    onCode(url, code) {
      stdout.write('1. Open this URL in a browser:\n\n');
      stdout.write(`   ${url}\n\n`);
      stdout.write(
        '2. Sign in, enable device-code login if prompted, and enter this code:\n\n',
      );
      stdout.write(`   ${code}\n\n`);
    },
    onProgress(message) {
      stdout.write(`${message}\n`);
    },
  });
  const store = new OAuthStore(
    db,
    OPENAI_CODEX_CREDENTIAL_KEY,
    refreshOpenAICodexToken,
  );
  store.write(creds);
  const who = creds.email
    ? `${creds.email}${creds.orgName ? ` (${creds.orgName})` : ''}`
    : creds.accountId;
  stdout.write(`\n✓ Logged in as ${who}\n`);
  stdout.write(`  credential: ${store.location}\n`);
  stdout.write(
    '\nSet `llm.provider_type: codex-oauth` (and llm.model) in config.yaml, then restart the harness.\n',
  );
}

async function main(): Promise<void> {
  const config = loadConfigFile();
  ensureDataDirectory(config.paths.dataDirectory);
  const db = openDatabase(
    migrateDataLayout(config.paths.dataDirectory).layout.root,
  );
  const requested = (
    process.argv[2] ??
    (config.llm.providerType === 'codex-oauth' ? 'codex' : 'anthropic')
  ).toLowerCase();
  if (requested === 'anthropic' || requested === 'anthropic-oauth') {
    await loginAnthropic(db);
    return;
  }
  if (
    requested === 'codex' ||
    requested === 'codex-oauth' ||
    requested === 'openai-codex'
  ) {
    await loginCodex(db);
    return;
  }
  throw new Error(
    `unknown OAuth provider ${JSON.stringify(requested)} — use anthropic or codex`,
  );
}

main().catch((e) => {
  stdout.write(
    `\nlogin failed: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exitCode = 1;
});
