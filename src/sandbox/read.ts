// read.ts — read's self-paginating renderer, extracted from globals.ts.
//
// read clamps its own output at a complete-line boundary and appends an
// explicit continuation cursor rather than letting the generic string previewer
// silently elide a chunk out of the MIDDLE (the worst shape for sequential
// reading). `formatRead` is exported for direct unit testing
// without spinning up a full sandbox.

/** Byte size of `s` as `preview()` will actually render it. Multiline strings
 * (which read output always is — header + lines) now render RAW, so the
 * yardstick is plain UTF-8 bytes. (Before the raw-render change this measured
 * JSON-escaped bytes, which over-reserved ~30% on escape-heavy files.) */
function renderedByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** read()'s continuation marker: an explicit cursor telling the agent exactly
 * which call gets it the rest, instead of a silent head/tail elision. */
function readContinuationMarker(p: string, from: number, shownTo: number, totalLines: number): string {
  return `\n[showing lines ${from}–${shownTo} of ${totalLines} — continue: read('${p}', {from: ${shownTo + 1}})]`;
}

/** Render read()'s output, self-paginating at a complete-line boundary instead
 * of leaving the generic string previewer to silently elide a chunk out of
 * the middle. Budget
 * is `previewMaxBytes`, checked in rendered bytes (see `renderedByteLength`)
 * with headroom reserved for the previewer's own `string(N chars):` prefix
 * and hard cap, so the marker this function appends is never the part
 * that downstream truncation eats. A render that fits under budget is
 * returned byte-identical to the un-paginated form (no marker). Exported for
 * direct unit testing without spinning up a full sandbox. */
export function formatRead(
  p: string,
  fileContent: string,
  opts: { from?: number; to?: number; numbers?: boolean },
  maxBytes: number,
): string {
  const lines = fileContent.split('\n');
  const totalLines = lines.length;
 // Compute `to` first, then clamp `from` to never exceed it — this kills BOTH
 // a from-past-EOF request and any explicitly-reversed {from, to} range, so no
 // reversed pair ever reaches the header/footer below.
  const to = Math.min(totalLines, opts.to ?? totalLines);
  const from = Math.max(1, Math.min(opts.from ?? 1, to));
  const numbered = opts.numbers !== false;

 // Numbered lines carry a plain 1-based line number for orientation and
 // transcript delineation. (Edits are string-match, not ref-addressed, so no
 // content hash is needed.)
  const renderLine = (lineNo: number): string => {
    const l = lines[lineNo - 1];
    return numbered ? `${String(lineNo).padStart(4)}: ${l}` : l;
  };
  const header = (shownTo: number): string => `${p} (${totalLines} lines, showing ${from}-${shownTo})\n`;

  const fullBody = [];
  for (let i = from; i <= to; i++) fullBody.push(renderLine(i));
  const fullText = header(to) + fullBody.join('\n');

 // Reserve headroom off the configured budget for preview's own wrapper
 // (the `string(N chars): ` prefix and its head/tail split's quote/escape
 // overhead) — without this, a render that just barely fits read's own
 // check can still get trimmed by preview's downstream hard cap.
  const reserve = Math.min(512, Math.max(64, Math.floor(maxBytes * 0.1)));
  const budget = Math.max(1, maxBytes - reserve);

  if (renderedByteLength(fullText) <= budget) {
    return fullText;
  }

 // Clamp to the last COMPLETE line (within the requested range) that fits
 // alongside the continuation marker for that exact cutoff.
  let shownTo = from - 1;
  let body = '';
  for (let i = from; i <= to; i++) {
    const candidateBody = body ? body + '\n' + renderLine(i) : renderLine(i);
    const candidateText = header(i) + candidateBody + readContinuationMarker(p, from, i, totalLines);
    if (renderedByteLength(candidateText) > budget) break;
    body = candidateBody;
    shownTo = i;
  }
 // Always show at least one line, even if it alone exceeds the reserved
 // headroom — an empty range is useless and the marker still tells the
 // agent how to get the rest.
  if (shownTo < from) {
    shownTo = from;
    body = renderLine(from);
  }
  return header(shownTo) + body + readContinuationMarker(p, from, shownTo, totalLines);
}
