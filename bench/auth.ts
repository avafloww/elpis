import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as path from 'node:path';
import { openDatabase } from '../src/store/db.js';
import { OAuthStore } from '../src/llm/oauth/store.js';
import { startAnthropicLogin, exchangeAnthropicCode, refreshAnthropicToken } from '../src/llm/oauth/anthropic.js';
import { loginOpenAICodexDevice, OPENAI_CODEX_CREDENTIAL_KEY, refreshOpenAICodexToken } from '../src/llm/oauth/openai-codex.js';
import { ensurePrivateDir, privateDataRoot } from './store.js';

export function hardenAuthStore(dir: string): void {
  fs.chmodSync(dir, 0o700);
  for (const name of ['elpis.db', 'elpis.db-wal', 'elpis.db-shm']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  }
}

export async function authLogin(provider: string, root = privateDataRoot()): Promise<void> {
  const previousUmask = process.umask(0o077);
  let dir: string | null = null;
  try {
    dir = ensurePrivateDir(path.join(root, 'auth')); const db = openDatabase(dir);
    if (provider === 'anthropic' || provider === 'anthropic-oauth') {
      const { url, pkce, state } = startAnthropicLogin(); const rl = readline.createInterface({ input: stdin, output: stdout });
      stdout.write(`Open and approve:\n${url}\n`); const code = (await rl.question('Paste code#state: ')).trim(); rl.close();
      if (!code) throw new Error('no authorization code entered');
      const credentials = await exchangeAnthropicCode(code, pkce, state); new OAuthStore(db, 'anthropic', refreshAnthropicToken).write(credentials); return;
    }
    if (provider === 'codex' || provider === 'codex-oauth') {
      const credentials = await loginOpenAICodexDevice({ onCode(url, code) { stdout.write(`Open ${url} and enter ${code}\n`); }, onProgress(message) { stdout.write(`${message}\n`); } });
      new OAuthStore(db, OPENAI_CODEX_CREDENTIAL_KEY, refreshOpenAICodexToken).write(credentials); return;
    }
    throw new Error('auth login supports anthropic-oauth or codex-oauth; configure API keys directly for openai-compatible providers');
  } finally {
    if (dir) hardenAuthStore(dir);
    process.umask(previousUmask);
  }
}
