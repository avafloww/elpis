// esm-staleness.ts — turn a silent wrong answer into a visible warning.
//
// globals.ts busts the CommonJS module cache before delegating a local-path
// require, so an edited scratch helper is re-read. That works for .cjs and
// fails SILENTLY for ESM: this package is `"type": "module"`, so everything
// under dist/ is ESM, and `require` of an ESM file goes through the ESM
// loader whose module map `require.cache` does not index. The delete is a
// no-op, and the process keeps serving the version first loaded.
//
// Observed rebuilt dist/lib/similarity.js, required it, got the
// pre-edit module with the new export missing, and spent a confusing detour
// believing a freshly-written detector was broken. Nothing errored — the
// wrong answer simply looked like a result.
//
// We cannot evict the ESM map (no public API). So we detect the exact
// condition where staleness is real — same path, required again, mtime newer
// than the load we served — and say so.

import fs from 'node:fs';
import path from 'node:path';

/** Nearest package.json `type` field, walking up from a file. */
function packageType(file: string): string | undefined {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { type?: string };
      if (pkg.type) return pkg.type;
      return undefined;
    } catch { /* keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** True when Node will load this path through the ESM loader. */
export function isEsmPath(file: string): boolean {
  if (file.endsWith('.mjs')) return true;
  if (file.endsWith('.cjs')) return false;
  if (!file.endsWith('.js')) return false;
  return packageType(file) === 'module';
}

export interface StalenessTracker {
  /** Record a require of `resolved`; returns a warning string when the file has
 * changed on disk since the version this process actually loaded. */
  check(resolved: string): string | null;
}

export function createStalenessTracker(
  statMtime: (p: string) => number = (p) => fs.statSync(p).mtimeMs,
  isEsm: (p: string) => boolean = isEsmPath,
): StalenessTracker {
  const loadedAtMtime = new Map<string, number>();
  return {
    check(resolved: string): string | null {
      let mtime: number;
      try { mtime = statMtime(resolved); } catch { return null; }
      const first = loadedAtMtime.get(resolved);
      if (first === undefined) {
        loadedAtMtime.set(resolved, mtime);
        return null;
      }
      if (mtime <= first) return null;
 // Changed on disk since we loaded it. For CJS the cache-bust in globals.ts
 // handles it, so only ESM is a problem — and there the delete is a no-op.
      if (!isEsm(resolved)) {
        loadedAtMtime.set(resolved, mtime);
        return null;
      }
      return `require: ${resolved} changed on disk, but it is an ES module — require.cache cannot evict it and this process will keep serving the version it loaded first. You are looking at STALE code. To exercise the rebuilt file, run it in a subprocess (e.g. elpis.sh("node /tmp/probe.mjs")) or restart the harness.`;
    },
  };
}
