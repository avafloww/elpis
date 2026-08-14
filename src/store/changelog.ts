// changelog.ts — boot-time "[harness updated]" notice for harness changes made
// while the agent was down (typically by an outside CLI agent whose systemctl
// restart writes no resume marker, so the agent would otherwise never learn the
// harness changed).
//
// Optional changelog entries are plain markdown files in
// `<harnessRoot>/changelogs/` named `YYYY-MM-DD-<slug>.md`. There is deliberately
// no frontmatter or metadata parsing — the
// filename carries date + title + sort order, and the body is free prose. The
// boot notice is a POINTER, not a payload: it names the unseen files and shows
// the read invocation; the agent reads the bodies on its own terms.
//
// Seen-tracking is a flat JSON array of filenames in
// `<dataDirectory>/.changelog-seen.json` (a set, not a lexicographic cursor, so
// a backdated entry is never silently skipped). The caller (index.ts) marks
// entries seen via the notice's drain-time onDelivered callback, NOT at
// enqueue — so every failure direction degrades to re-delivery: a missing dir,
// unreadable seen file, or write failure means "deliver nothing" / "deliver
// again next boot", and a notice dropped before the drain (clear/crash/second
// restart) is re-delivered rather than silently lost. Never blocks boot.

import * as fs from 'node:fs';
import * as path from 'node:path';

const SEEN_FILE = '.changelog-seen.json';

function readSeen(dataDirectory: string): Set<string> {
  try {
    const raw = fs.readFileSync(path.join(dataDirectory, SEEN_FILE), 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch { /* missing or corrupt → treat as empty */ }
  return new Set();
}

/** Filenames (not paths) of changelog entries the agent has not seen yet,
 * sorted by filename (the YYYY-MM-DD prefix makes that chronological). */
export function readUnseenChangelogs(harnessRoot: string, dataDirectory: string): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(path.join(harnessRoot, 'changelogs'));
  } catch {
    return []; // no changelogs/ dir yet
  }
  const seen = readSeen(dataDirectory);
  return files.filter((f) => f.endsWith('.md') && !seen.has(f)).sort();
}

/** Record filenames as seen (union with the existing set). Best-effort. */
export function markChangelogsSeen(dataDirectory: string, files: string[]): void {
  try {
    const seen = readSeen(dataDirectory);
    for (const f of files) seen.add(f);
    fs.writeFileSync(path.join(dataDirectory, SEEN_FILE), JSON.stringify([...seen].sort()));
  } catch { /* best-effort — worst case the notice repeats next boot */ }
}

/** The pointer-style notice enqueued into the one history on boot. */
export function formatChangelogNotice(files: string[]): string {
  const list = files.map((f) => `- ${f}`).join('\n');
  return `[harness updated] The harness code changed while you were offline — ${files.length} new changelog ${files.length === 1 ? 'entry' : 'entries'}:\n${list}\nRead one with elpis.read(HARNESS_ROOT + '/changelogs/${files[0]}').`;
}
