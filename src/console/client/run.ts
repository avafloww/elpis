import type { JsonObject } from './types.js';
import { object, text } from './types.js';

export interface RunResultParts {
  ok: boolean;
  value: string;
  console: string;
}

export interface WakePresentation {
  when: string;
  reason: string;
  raw: string;
}

export function splitRunResult(content: string): RunResultParts {
  const separator = '\n--- console ---\n';
  const index = content.indexOf(separator);
  const head = index < 0 ? content : content.slice(0, index);
  return {
    ok: !/\[run FAILED\]/.test(content),
    value: head
      .trim()
      .replace(/^\[run [^\]]*\]\n?/, '')
      .trim(),
    console: index < 0 ? '' : content.slice(index + separator.length),
  };
}

export function resultSummary(content: string, max = 220): string {
  const result = splitRunResult(content);
  const source =
    result.value || result.console || (result.ok ? 'completed' : 'failed');
  const oneLine = source.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function statementCount(code: string): number {
  const source = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  return Math.max(
    1,
    source
      .split(/;|\n/)
      .map((part) => part.trim())
      .filter(Boolean).length,
  );
}

export function wakePresentation(
  value: unknown,
  now = Date.now(),
): WakePresentation | null {
  const run = object(value);
  const wake = object(run.wake);
  if (!Object.keys(wake).length || text(wake.state) !== 'armed') return null;
  const targetAt = Number(wake.targetAt);
  const target = Number.isFinite(targetAt) ? new Date(targetAt) : null;
  const delta = target ? Math.max(0, target.getTime() - now) : 0;
  const minutes = Math.round(delta / 60_000);
  const relative =
    minutes < 60
      ? `in ${minutes}m`
      : `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const advice = object(wake.advice);
  const reason = text(advice.reason, text(wake.kind, 'scheduled')).replaceAll(
    '-',
    ' ',
  );
  const task = wake.taskId == null ? '' : `task #${String(wake.taskId)}`;
  return {
    when: target
      ? `Wake scheduled · ${target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, ${relative}`
      : 'Wake scheduled',
    reason,
    raw: [task, text(wake.kind), text(wake.state)].filter(Boolean).join(' · '),
  };
}

export function executionLabel(value: JsonObject | undefined): string {
  const execution = object(value?.execution);
  return text(execution.alias, text(execution.kind));
}

const MAX_FORMAT_CHARS = 250_000;

type RunDisplay = {
  code: string;
  heredocs: Array<{ token: string; source: string }>;
};

type RunCodeInput = {
  code: string;
  display?: RunDisplay;
};

export function restoreRunHeredocs(
  input: string,
  heredocs: RunDisplay['heredocs'],
): string {
  let code = input;
  for (const heredoc of heredocs) {
    const doubleQuoted = JSON.stringify(heredoc.token);
    const singleQuoted = `'${heredoc.token}'`;
    if (code.includes(doubleQuoted))
      code = code.replace(doubleQuoted, () => heredoc.source);
    else if (code.includes(singleQuoted))
      code = code.replace(singleQuoted, () => heredoc.source);
    else return input;
  }
  return code;
}

export async function formatRunSource(call: RunCodeInput): Promise<string> {
  const raw = call.code;
  if (!raw || raw.length > MAX_FORMAT_CHARS) return raw;
  const input = call.display?.code ?? raw;
  const heredocs = call.display?.heredocs ?? [];
  const [standalone, babelModule, estreeModule, typescriptModule] =
    await Promise.all([
      import('prettier/standalone'),
      import('prettier/plugins/babel'),
      import('prettier/plugins/estree'),
      import('prettier/plugins/typescript'),
    ]);
  for (const parser of ['babel', 'typescript'] as const) {
    try {
      const syntax =
        parser === 'babel' ? babelModule.default : typescriptModule.default;
      let formatted = (
        await standalone.format(input, {
          parser,
          plugins: [syntax, estreeModule.default],
          printWidth: 100,
          tabWidth: 2,
          singleQuote: true,
          semi: true,
          trailingComma: 'all',
        })
      ).trimEnd();
      if (!raw.trimEnd().endsWith(';') && formatted.endsWith(';'))
        formatted = formatted.slice(0, -1);
      return restoreRunHeredocs(formatted, heredocs);
    } catch {
      continue;
    }
  }
  return raw;
}
