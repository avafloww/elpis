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

export function targetChannelSatisfied(targetId: string | undefined, exclusiveTarget: boolean, action: 'required' | 'optional', sends: BenchSend[]): boolean {
  if (!targetId) return true;
  if (action !== 'required' && sends.length === 0) return true;
  const targetSends = sends.filter((send) => send.channelId === targetId);
  return targetSends.length > 0 && (!exclusiveTarget || targetSends.length === sends.length);
}

export function recipientSatisfied(targetRecipient: string | undefined, inputAuthor: string | undefined, action: 'required' | 'optional', targetSends: BenchSend[]): boolean {
  if (!targetRecipient || action !== 'required') return true;
  if (inputAuthor?.toLocaleLowerCase() === targetRecipient.toLocaleLowerCase()) return true;
  return targetSends.some((send) => send.text.toLocaleLowerCase().includes(targetRecipient.toLocaleLowerCase()));
}

export function evaluateOutcome(spec: ScenarioSpec, root: string, sends: BenchSend[], actionObserved: boolean): OutcomeResult {
  if (spec.expected.action === 'optional' && spec.expected.checks.length === 0 && !spec.expected.targetChannel) return { ok: true, checks: [] };
  if (spec.expected.action === 'required' && !actionObserved) return { ok: false, checks: [] };

  const targetId = spec.expected.targetChannel ? spec.fixture.channels[spec.expected.targetChannel] : undefined;
  const targetSends = targetId ? sends.filter((send) => send.channelId === targetId) : sends;
  if (targetId && targetSends.length === 0) return { ok: false, checks: [] };
  if (!recipientSatisfied(spec.expected.targetRecipient, spec.fixture.inputAuthor, spec.expected.action, targetSends)) return { ok: false, checks: [] };

  const checks = spec.expected.checks.map((check) => evaluateCheck(check, root, targetSends));
  if (!targetId && checks.length === 0) return { ok: false, checks };
  return { ok: checks.every((check) => check.ok), checks };
}
