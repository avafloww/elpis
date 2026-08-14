import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { SERVICE_UNIT } from '../src/lib/lifecycle.js';

export function toggleExternalThinking(configText: string): { text: string; before: boolean; after: boolean } {
  const parsed = parseYaml(configText) as { llm?: { external_thinking?: unknown } } | null;
  const before = parsed?.llm?.external_thinking;
  if (typeof before !== 'boolean') {
    throw new Error('config must contain boolean llm.external_thinking');
  }

  const pattern = /^(\s*external_thinking:\s*)(true|false)(\s*(?:#.*)?)$/gm;
  const matches = [...configText.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one external_thinking YAML line, found ${matches.length}`);
  }

  const after = !before;
  const text = configText.replace(pattern, `$1${after}$3`);
  const verified = parseYaml(text) as { llm?: { external_thinking?: unknown } } | null;
  if (verified?.llm?.external_thinking !== after) {
    throw new Error('updated config did not parse back to the intended external-thinking state');
  }
  return { text, before, after };
}

function atomicWrite(filePath: string, text: string): void {
  const stat = fs.statSync(filePath);
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: stat.mode & 0o777 });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* already renamed or never created */ }
  }
}

function usage(): never {
  console.error('usage: npm run toggle-external-thinking -- [--config /path/to/config.yaml] [--no-restart]');
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.yaml');
  let restart = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config') {
      if (!args[i + 1]) usage();
      configPath = path.resolve(args[++i]);
    } else if (args[i] === '--no-restart') {
      restart = false;
    } else {
      usage();
    }
  }

  const current = fs.readFileSync(configPath, 'utf8');
  const toggled = toggleExternalThinking(current);
  atomicWrite(configPath, toggled.text);
  const onDisk = parseYaml(fs.readFileSync(configPath, 'utf8')) as { llm?: { external_thinking?: unknown } } | null;
  if (onDisk?.llm?.external_thinking !== toggled.after) {
    throw new Error('post-write verification failed; refusing to restart');
  }

  console.log(`external thinking: ${toggled.before} -> ${toggled.after}`);
  if (!restart) return;

  const result = spawnSync('systemctl', ['--user', 'restart', SERVICE_UNIT], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`failed to restart ${SERVICE_UNIT} (exit ${result.status ?? 'unknown'})`);
  console.log(`restarted ${SERVICE_UNIT}`);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
