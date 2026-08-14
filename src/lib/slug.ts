// slug.ts — THE slugify. people/<slug>.md keys (prompt injection + memory.person
// + ponder), ssh control-socket names, and any future slug share this one
// mapping. The prompt's people-file matching and the sandbox's people-file
// creation MUST agree byte-for-byte or a person's file silently stops being
// injected — that agreement lives here now instead of in a keep-in-sync comment.

/** Lowercase, collapse non-alphanumerics to single dashes, trim edge dashes. */
export function slugify(name: string, fallback = 'unknown'): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;
}
