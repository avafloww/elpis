// state.ts — a small hot-reloaded JSON state file for the agent.
//
// Unlike MEMORY.md (cached until compaction/clear), state.json is read fresh on
// every turn so the agent can signal transient self-state (mood, energy, posture)
// that should influence the current turn without permanently bloating memory.
// The agent controls it via the sandbox global `state`.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Read state.json if it exists; return {} on any error. */
export function readState(dataDirectory: string): Record<string, unknown> {
  const file = path.join(dataDirectory, 'state.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
  } catch { /* missing or malformed → empty */ }
  return {};
}

/** Write the entire state object to state.json atomically.
 * Adds a hidden __updated_at timestamp so the prompt can show staleness. */
export function writeState(dataDirectory: string, state: Record<string, unknown>): void {
  const file = path.join(dataDirectory, 'state.json');
  const tmp = file + '.tmp';
  const withTimestamp = { ...state, __updated_at: new Date().toISOString() };
  fs.writeFileSync(tmp, JSON.stringify(withTimestamp, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
