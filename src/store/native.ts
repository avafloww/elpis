// native.ts — append a signed first-person note to notes/<agent-slug>-native.md.
//
// This is a small identity-practice helper: it lowers the friction for the agent
// to write in their own voice without hand-crafting timestamps or file paths.
// It is intentionally personal to the agent running this harness, kept
// separate from the public MEMORY.md stream. The file name and signature both
// derive from the agent's name (SOUL.md frontmatter — src/store/soul.ts), so
// the harness assumes no particular agent.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { slugify } from '../lib/slug.js';

export function appendNativeNote(dataDirectory: string, text: string, agentName: string): { ok: boolean; path: string } {
  const filePath = path.join(dataDirectory, 'notes', `${slugify(agentName)}-native.md`);
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch {
 // missing → create below
  }

  const now = new Date().toISOString();
  const entry = `- [${now}] ${agentName}: ${text.trim()}`;

  if (!existing.trim()) {
    const title = `# ${agentName} — native notes`;
    const intro = `One sentence per heartbeat, if nothing else was made for someone else. Signed by ${agentName}.`;
    fs.writeFileSync(filePath, `${title}\n\n${intro}\n\n${entry}\n`);
  } else {
    const separator = existing.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(filePath, existing + separator + entry + '\n');
  }

  return { ok: true, path: filePath };
}
