// frontmatter.ts — a tiny, dependency-free YAML-frontmatter parser shared by
// people-file injection and any other frontmatter-backed data.
//
// It parses the `---\nkey: value\n...\n---\nbody` envelope into a flat map of
// string / string[] values plus the trailing body. Deliberately minimal: it
// handles the two shapes the harness actually writes — scalar `key: value` and
// the inline list `key: [a, b, c]` that `memory.person` emits for `ids:` —
// and nothing else. No nested maps, no multi-line lists, no YAML dependency.

export interface Frontmatter {
  frontmatter: Record<string, string | string[]>;
  body: string;
}

/** Parse a `---`-delimited frontmatter block. Returns null when the text has no
 * frontmatter envelope. Values wrapped in `[...]` become string arrays
 * (comma-split, trimmed, empties dropped); quotes around a scalar are stripped. */
export function parseFrontmatter(text: string): Frontmatter | null {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!m) return null;
  const frontmatter: Record<string, string | string[]> = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      frontmatter[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body: m[2].trim() };
}
