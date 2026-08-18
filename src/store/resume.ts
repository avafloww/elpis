// resume.ts — deploy/restart → boot continuity marker.
//
// Observed gap: after a self-initiated deploy the loop reboots, primes
// every channel context from its transcript… and then parks on the wake-gate
// until a human pokes the agent, because nothing flips hasNewInput (the deploy
// tool RESULT was already answered before SIGTERM, so interrupted-tool
// recovery has nothing to recover). The agent that said "restarting to test
// this" never comes back to say whether it worked.
//
// Fix: restart/deploy write a marker file; on boot, index.ts consumes it and
// enqueues a synthetic `[restart complete]` message into the one history so the
// agent gets a turn to verify the deploy and pick its work back up — the same
// delivery shape as a `[bg <id> settled]` notice.: monocontext, so the marker
// no longer names a channel (there is one history).
//
// The marker is consumed (deleted) before delivery, so a crash loop can't
// replay it, and a stale marker (older than maxAgeMs — e.g. from a boot that
// died before consuming it, followed by a long outage) is discarded rather
// than delivered into a conversation that has moved on.

import * as fs from 'node:fs';
import { resolveDataLayout } from './data-layout.js';

export interface ResumeMarker {
  reason: string | null;
  at: string; // ISO timestamp of the restart request
}

/** Written by the sandbox restart()/deploy() globals just before they hand off
 * to systemd or the restricted lifecycle broker. Best-effort: a marker-write
 * failure must never block the restart itself. */
export function clearResumeMarker(dataDirectory: string): void {
  try { fs.unlinkSync(resolveDataLayout(dataDirectory).resumeMarker); } catch { /* best-effort */ }
}

export function writeResumeMarker(dataDirectory: string, reason?: string): void {
  const marker: ResumeMarker = {
    reason: reason ?? null,
    at: new Date().toISOString(),
  };
  try {
    const layout = resolveDataLayout(dataDirectory);
    fs.mkdirSync(layout.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(layout.resumeMarker, JSON.stringify(marker));
  } catch { /* best-effort */ }
}

/** Read AND delete the marker (consume-once). Returns null when there is no
 * marker, it is unreadable, or it is older than maxAgeMs. */
export function consumeResumeMarker(dataDirectory: string, maxAgeMs = 15 * 60_000): ResumeMarker | null {
  const file = resolveDataLayout(dataDirectory).resumeMarker;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try { fs.unlinkSync(file); } catch { /* consumed anyway */ }
  try {
    const obj = JSON.parse(raw) as Partial<ResumeMarker>;
    const at = typeof obj.at === 'string' ? obj.at : '';
    const age = Date.now() - Date.parse(at);
    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
    return { reason: typeof obj.reason === 'string' ? obj.reason : null, at };
  } catch {
    return null;
  }
}
