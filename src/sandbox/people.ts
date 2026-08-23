// people.ts — pure people/-slug helpers, extracted from globals.ts.
//
// Shared by the ponder and memory.person globals: `slugifyName` keys both
// people/<slug>.md and ponder/<slug>.md files (same mapping), and
// `authorHasPeopleFile` guards memory.person against stamping the inbound
// author's Discord id onto a second file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { slugify } from '../lib/slug.js';

/** Slugify a person name the way people/<slug>.md files are keyed. Shared so the
 * write path (memory.person) and the identity check use the same mapping. */
export function slugifyName(name: string): string {
  return slugify(name);
}

/** True when some existing people/*.md file already claims `discord:<authorId>`
 * in its frontmatter ids. Used by memory.person to avoid stamping the inbound
 * author's id onto a second file. */
export function authorHasPeopleFile(
  peopleDir: string,
  authorId: string,
): boolean {
  const needle = `discord:${authorId}`;
  let entries: string[];
  try {
    entries = fs.readdirSync(peopleDir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(peopleDir, name), 'utf8');
    } catch {
      continue;
    }
    const ids = parseFrontmatter(raw)?.frontmatter.ids;
    if (Array.isArray(ids) && ids.includes(needle)) return true;
  }
  return false;
}
