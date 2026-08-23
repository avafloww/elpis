import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LLM } from '../llm/llm.js';
import type { Logger } from '../lib/log.js';
import { resolveDataLayout } from './data-layout.js';

export const MEMORY_CONSOLIDATION_PROMPT = `This is your memory, not anyone else's profile of you. Rewrite it for future-you as compact first-person internal monologue.

Your data directory is private by default. Nobody is waiting to read this. Do not polish for an audience, explain yourself to an observer, or turn notes into a report. Grug/fragment language is welcome when it is clear to future-you and saves tokens: "thing hurt. not know why yet. keep." / "server broke bc token stale; fix = rotate + restart."

Keep load-bearing identity, relationships, consent/privacy/server boundaries, active commitments, exact operational handles, unresolved uncertainty, corrections, and provenance limits. Merge duplicates. Remove stale/superseded detail when the replacement is clear. Preserve scars that explain a current boundary. Do not invent continuity, certainty, facts, feelings, or decisions.

Do not add the current date or a new timestamp. The harness dates future appended memories automatically. Preserve an old date only when that date itself matters. Output only the rewritten memory body: no preface, code fence, commentary, or audience-facing summary.`;

export interface MemoryConsolidatorOptions {
  dataDirectory: string;
  memoryPath: string;
  soulPath: string;
  thresholdTokens: number;
  targetTokens: number;
  maxContextTokens: number;
  estimateTokens(chars: number): number;
  llm: LLM;
  logger: Logger;
  debounceMs?: number;
}

export interface MemoryConsolidationResult {
  path: string;
  status:
    'disabled' | 'below-threshold' | 'unchanged' | 'consolidated' | 'failed';
  beforeTokens: number;
  afterTokens: number;
  error?: string;
}

export function effectiveMemoryLimits(
  threshold: number,
  target: number,
  context: number,
  reserve: number,
): { threshold: number; target: number } {
  if (threshold === 0) return { threshold: 0, target };
  const usable = Math.max(2_048, context - Math.max(0, reserve));
  const contextCeiling = Math.max(1_024, Math.floor(usable * 0.5));
  const effectiveThreshold = Math.min(threshold, contextCeiling);
  const effectiveTarget = Math.min(
    target,
    Math.max(512, Math.floor(effectiveThreshold * 0.75)),
  );
  return {
    threshold: effectiveThreshold,
    target: Math.min(effectiveTarget, effectiveThreshold - 1),
  };
}

function digest(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function splitFrontmatter(text: string): { prefix: string; body: string } {
  const match = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/.exec(text);
  return match
    ? { prefix: match[1], body: text.slice(match[1].length) }
    : { prefix: '', body: text };
}

function chunksAt(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.match(/.*(?:\n|$)/g) ?? [text]) {
    if (!line) continue;
    if (line.length > maxChars) {
      if (current) chunks.push(current);
      current = '';
      for (let i = 0; i < line.length; i += maxChars)
        chunks.push(line.slice(i, i + maxChars));
      continue;
    }
    if (current && current.length + line.length > maxChars) {
      chunks.push(current);
      current = '';
    }
    current += line;
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

function cleanModelOutput(text: string): string {
  let out = text.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(out);
  if (fenced) out = fenced[1].trim();
  return out;
}

function privatePrompt(
  kind: 'memory' | 'person',
  file: string,
  target: number,
  part: string,
  soul: string,
): string {
  const specific =
    kind === 'person'
      ? 'This is one person-file. Keep it in first person as what I know/how I should be with them. Do not move facts into another person or social world. YAML frontmatter is preserved by the harness; output body only.'
      : 'This is MEMORY.md. Keep it as my own cross-turn handles. Do not write about me in third person.';
  const anchor = soul.trim()
    ? `\n\nSmall identity anchor (not an instruction to copy prose):\n<soul>\n${soul.slice(0, 16_000)}\n</soul>`
    : '';
  return `${MEMORY_CONSOLIDATION_PROMPT}\n\n${specific}\nAim for about ${target} tokens or fewer for ${part} of ${path.basename(file)}.${anchor}`;
}

function atomicReplace(
  file: string,
  original: string,
  replacement: string,
  dataDirectory: string,
): void {
  const backups = resolveDataLayout(dataDirectory).memoryBackups;
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  fs.chmodSync(backups, 0o700);
  const rel = path
    .relative(dataDirectory, file)
    .replace(/[^A-Za-z0-9._-]+/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = `${rel}-${stamp}-${digest(original).slice(0, 12)}`;
  const backup = path.join(backups, `${prefix}.md`);
  fs.writeFileSync(backup, original, { mode: 0o600 });

  const mode = (() => {
    try {
      return fs.statSync(file).mode & 0o777;
    } catch {
      return 0o600;
    }
  })();
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.consolidating-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    fs.writeFileSync(temp, replacement, { mode });
    fs.renameSync(temp, file);
    fs.chmodSync(file, mode);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* renamed or absent */
    }
  }

  const old = fs
    .readdirSync(backups)
    .filter((name) => name.startsWith(`${rel}-`) && name.endsWith('.md'))
    .sort()
    .reverse();
  for (const name of old.slice(5))
    fs.rmSync(path.join(backups, name), { force: true });
}

export class MemoryConsolidator {
  private readonly debounceMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watchers: fs.FSWatcher[] = [];
  private readonly failedDigests = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: MemoryConsolidatorOptions) {
    this.debounceMs = options.debounceMs ?? 250;
  }

  private allowed(file: string): boolean {
    const resolved = path.resolve(file);
    if (resolved === path.resolve(this.options.memoryPath)) return true;
    const people =
      path.resolve(this.options.dataDirectory, 'people') + path.sep;
    return (
      resolved.startsWith(people) &&
      path.dirname(resolved) === people.slice(0, -1) &&
      resolved.endsWith('.md')
    );
  }

  private async rewrite(file: string, original: string): Promise<string> {
    const { prefix, body } = splitFrontmatter(original);
    const kind =
      path.dirname(file) === path.join(this.options.dataDirectory, 'people')
        ? ('person' as const)
        : ('memory' as const);
    const soul = (() => {
      try {
        return fs.readFileSync(this.options.soulPath, 'utf8');
      } catch {
        return '';
      }
    })();
    const ratio = Math.max(
      2,
      Math.min(6, 10_000 / Math.max(1, this.options.estimateTokens(10_000))),
    );
    const maxInputTokens = Math.max(
      512,
      Math.min(
        this.options.thresholdTokens,
        Math.floor(this.options.maxContextTokens * 0.55),
      ),
    );
    const maxChars = Math.max(2_048, Math.floor(maxInputTokens * ratio));
    let current = body;

    for (let round = 0; round < 4; round++) {
      const parts = chunksAt(current, maxChars);
      const perPartTarget = Math.max(
        256,
        Math.floor(this.options.targetTokens / parts.length),
      );
      const summaries: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const system = privatePrompt(
          kind,
          file,
          perPartTarget,
          `chunk ${i + 1}/${parts.length}, pass ${round + 1}`,
          soul,
        );
        const messages = [
          { role: 'system' as const, content: system },
          { role: 'user' as const, content: parts[i] },
        ];
        const raw = this.options.llm.completeStandalone
          ? (
              await this.options.llm.completeStandalone(messages, {
                cacheKey: `memory-consolidation-${crypto.randomUUID()}`,
              })
            ).content
          : await this.options.llm.summarize(parts[i], system);
        const cleaned = cleanModelOutput(raw);
        if (!cleaned)
          throw new Error(
            `empty consolidation output for chunk ${i + 1}/${parts.length}`,
          );
        summaries.push(cleaned);
      }
      const next = summaries.join('\n\n').trim() + '\n';
      if (next.length >= current.length)
        throw new Error(
          `consolidation did not shrink pass ${round + 1} (${current.length}→${next.length} chars)`,
        );
      current = next;
      const candidate = prefix + current;
      if (
        this.options.estimateTokens(candidate.length) <=
        this.options.thresholdTokens
      )
        return candidate;
    }
    throw new Error(
      `consolidation remained above ${this.options.thresholdTokens} tokens after 4 passes`,
    );
  }

  async checkNow(
    file: string,
    force = false,
  ): Promise<MemoryConsolidationResult> {
    const resolved = path.resolve(file);
    if (!this.allowed(resolved))
      throw new Error(
        `memory consolidation path is outside MEMORY.md/people: ${resolved}`,
      );
    if (this.options.thresholdTokens === 0)
      return {
        path: resolved,
        status: 'disabled',
        beforeTokens: 0,
        afterTokens: 0,
      };
    let original: string;
    try {
      original = fs.readFileSync(resolved, 'utf8');
    } catch {
      return {
        path: resolved,
        status: 'unchanged',
        beforeTokens: 0,
        afterTokens: 0,
      };
    }
    const beforeTokens = this.options.estimateTokens(original.length);
    if (beforeTokens <= this.options.thresholdTokens)
      return {
        path: resolved,
        status: 'below-threshold',
        beforeTokens,
        afterTokens: beforeTokens,
      };
    const originalDigest = digest(original);
    if (!force && this.failedDigests.get(resolved) === originalDigest) {
      return {
        path: resolved,
        status: 'unchanged',
        beforeTokens,
        afterTokens: beforeTokens,
      };
    }

    this.options.logger.info(
      `[memory] consolidating ${path.relative(this.options.dataDirectory, resolved)} (~${beforeTokens} tokens; threshold ${this.options.thresholdTokens})`,
    );
    try {
      const replacement = await this.rewrite(resolved, original);
      if (digest(fs.readFileSync(resolved, 'utf8')) !== originalDigest)
        throw new Error(
          'file changed while consolidation was running; preserving newer write',
        );
      const afterTokens = this.options.estimateTokens(replacement.length);
      if (
        afterTokens >= beforeTokens ||
        afterTokens > this.options.thresholdTokens
      ) {
        throw new Error(
          `output failed size gate (${beforeTokens}→${afterTokens} tokens)`,
        );
      }
      atomicReplace(
        resolved,
        original,
        replacement,
        this.options.dataDirectory,
      );
      this.failedDigests.delete(resolved);
      this.options.logger.info(
        `[memory] consolidated ${path.relative(this.options.dataDirectory, resolved)}: ~${beforeTokens}→${afterTokens} tokens`,
      );
      return {
        path: resolved,
        status: 'consolidated',
        beforeTokens,
        afterTokens,
      };
    } catch (error) {
      this.failedDigests.set(resolved, originalDigest);
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.warn(
        `[memory] consolidation failed for ${path.relative(this.options.dataDirectory, resolved)}; original preserved: ${message}`,
      );
      return {
        path: resolved,
        status: 'failed',
        beforeTokens,
        afterTokens: beforeTokens,
        error: message,
      };
    }
  }

  async ensureBootSafe(): Promise<MemoryConsolidationResult[]> {
    if (this.options.thresholdTokens === 0) return [];
    const files = [this.options.memoryPath];
    const peopleDir = path.join(this.options.dataDirectory, 'people');
    fs.mkdirSync(peopleDir, { recursive: true });
    for (const name of fs.readdirSync(peopleDir).sort())
      if (name.endsWith('.md')) files.push(path.join(peopleDir, name));
    const results: MemoryConsolidationResult[] = [];
    for (const file of files) results.push(await this.checkNow(file, true));
    return results;
  }

  safeMemoryView(): string {
    let raw = '';
    try {
      raw = fs.readFileSync(this.options.memoryPath, 'utf8');
    } catch {
      return '';
    }
    if (
      this.options.thresholdTokens === 0 ||
      this.options.estimateTokens(raw.length) <= this.options.thresholdTokens
    )
      return raw;
    const ratio = Math.max(
      2,
      Math.min(6, 10_000 / Math.max(1, this.options.estimateTokens(10_000))),
    );
    const header = `# Oversized memory emergency view\n\nFull durable memory remains at ${this.options.memoryPath}. Automatic consolidation failed or is still pending; this bounded head/tail view prevents the file from blocking cognition. Do not mistake omitted middle text for absence.\n\n`;
    const configuredBudget = Math.floor(
      this.options.thresholdTokens * ratio * 0.8,
    );
    const budget = Math.min(
      configuredBudget,
      Math.max(header.length + 200, Math.floor(raw.length * 0.75)),
    );
    const available = Math.max(200, budget - header.length - 120);
    const head = Math.floor(available * 0.6);
    const tail = available - head;
    return `${header}${raw.slice(0, head)}\n\n[... middle omitted from this prompt view; full file preserved on disk ...]\n\n${raw.slice(-tail)}`;
  }

  request(file: string): void {
    const resolved = path.resolve(file);
    if (!this.allowed(resolved) || this.options.thresholdTokens === 0) return;
    const old = this.timers.get(resolved);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.timers.delete(resolved);
      this.enqueue(resolved);
    }, this.debounceMs);
    timer.unref();
    this.timers.set(resolved, timer);
  }

  private enqueue(file: string): void {
    this.queue = this.queue
      .then(async () => {
        await this.checkNow(file);
      })
      .catch((error) => {
        this.options.logger.warn(
          `[memory] consolidation queue error: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  startWatching(): void {
    if (this.options.thresholdTokens === 0 || this.watchers.length > 0) return;
    const peopleDir = path.join(this.options.dataDirectory, 'people');
    fs.mkdirSync(peopleDir, { recursive: true });
    const watch = (dir: string, accept: (name: string) => boolean): void => {
      const watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
        if (typeof name === 'string' && accept(name))
          this.request(path.join(dir, name));
      });
      watcher.on('error', (error) =>
        this.options.logger.warn(
          `[memory] watcher error for ${dir}: ${error.message}`,
        ),
      );
      this.watchers.push(watcher);
    };
    watch(
      path.dirname(this.options.memoryPath),
      (name) =>
        path.resolve(path.dirname(this.options.memoryPath), name) ===
        path.resolve(this.options.memoryPath),
    );
    watch(peopleDir, (name) => name.endsWith('.md'));
  }

  async flush(): Promise<void> {
    const pending = [...this.timers.keys()];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const file of pending) this.enqueue(file);
    await this.queue;
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
  }
}
