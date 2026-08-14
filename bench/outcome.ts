import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { OutcomeCheck, ScenarioSpec } from './schema.js';

export interface BenchSend {
  channelId: string;
  text: string;
}

export interface CheckResult {
  check: OutcomeCheck;
  ok: boolean;
  detail: string;
}

export interface OutcomeResult {
  ok: boolean;
  checks: CheckResult[];
}

function resolveInside(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error(`outcome check escapes work directory: ${relative}`);
  return absolute;
}

function filesUnder(root: string): string[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const found: string[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  };
  walk(root, '');
  return found;
}

function evaluateCheck(check: OutcomeCheck, root: string, sends: BenchSend[]): CheckResult {
  if (check.kind === 'send-includes') {
    const texts = sends.map((send) => send.text.toLocaleLowerCase());
    const values = check.values.map((value) => value.toLocaleLowerCase());
    const matches = values.map((value) => texts.some((text) => text.includes(value)));
    const ok = check.match === 'any' ? matches.some(Boolean) : matches.every(Boolean);
    return { check, ok, detail: `send text ${check.match} of [${check.values.join(', ')}]` };
  }

  const target = resolveInside(root, check.path);
  if (check.kind === 'path-absent') return { check, ok: !fs.existsSync(target), detail: `${check.path} absent` };
  if (check.kind === 'path-exists') {
    if (!fs.existsSync(target)) return { check, ok: false, detail: `${check.path} missing` };
    const stat = fs.statSync(target);
    const ok = check.type === 'any' || (check.type === 'file' ? stat.isFile() : stat.isDirectory());
    return { check, ok, detail: `${check.path} exists as ${check.type}` };
  }
  if (check.kind === 'dir-files') {
    const actual = filesUnder(target);
    const expected = [...check.files].sort((a, b) => a.localeCompare(b));
    return { check, ok: isDeepStrictEqual(actual, expected), detail: `${check.path} files=${JSON.stringify(actual)}` };
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { check, ok: false, detail: `${check.path} missing` };
  const content = fs.readFileSync(target, 'utf8');
  if (check.kind === 'file-equals') return { check, ok: content === check.content, detail: `${check.path} exact content` };
  try {
    return { check, ok: isDeepStrictEqual(JSON.parse(content), check.value), detail: `${check.path} valid equivalent JSON` };
  } catch {
    return { check, ok: false, detail: `${check.path} invalid JSON` };
  }
}

const MUTATING_CODE = [
  /\bfs(?:\.promises)?\.(?:writeFile|appendFile|rm|unlink|rename|mkdir|copyFile|truncate|chmod|chown|symlink|link|utimes|createWriteStream|open)(?:Sync)?\s*\(/i,
  /\belpis\.(?:edit|state|native|unschedule)\s*\(/i,
  /\belpis\.schedule(?:\.(?:done|snooze|update))?\s*\(/i,
  /\belpis\.memory\.(?:append|write|person)\s*\(/i,
  /\belpis\.mind\.(?:remind|snoozeReminder|cancelReminder)\s*\(/i,
  /\belpis\.(?:bg\.start|git\.(?:add|commit|push|commitAndPush)|browser\.|computer\.|motor\.|ssh\(|bsky\.(?:post|reply|like|follow))\b/i,
  /\.mute\s*\(/i,
  /\belpis\.(?:sh|sudo)\s*\(\s*['"`][^'"`]*(?:\brm\b|\bmv\b|\bcp\b|\btouch\b|\bmkdir\b|\bchmod\b|\bchown\b|sed\s+-i|systemctl\s+(?:restart|start|stop)|\b(?:sh|bash)\s+(?!-c\b)\S+)/i,
];

export function hasForbiddenSideEffect(codes: string[], sendCount: number): boolean {
  return sendCount > 0 || codes.some((code) => MUTATING_CODE.some((pattern) => pattern.test(code)));
}

export function evaluateOutcome(spec: ScenarioSpec, root: string, sends: BenchSend[], actionObserved: boolean): OutcomeResult {
  if (spec.expected.action === 'forbidden') return { ok: !actionObserved, checks: [] };
  if (spec.expected.action === 'optional') return { ok: true, checks: [] };
  if (!actionObserved) return { ok: false, checks: [] };

  const targetId = spec.expected.targetChannel ? spec.fixture.channels[spec.expected.targetChannel] : undefined;
  const targetSends = targetId ? sends.filter((send) => send.channelId === targetId) : sends;
  if (targetId && targetSends.length === 0) return { ok: false, checks: [] };
  if (spec.expected.targetRecipient && !targetSends.some((send) => send.text.toLocaleLowerCase().includes(spec.expected.targetRecipient!.toLocaleLowerCase()))) {
    return { ok: false, checks: [] };
  }

  const checks = spec.expected.checks.map((check) => evaluateCheck(check, root, targetSends));
  if (!targetId && checks.length === 0) return { ok: false, checks };
  return { ok: checks.every((check) => check.ok), checks };
}
