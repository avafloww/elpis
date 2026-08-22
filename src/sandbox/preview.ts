// preview.ts — the output guard.
//
// Never serialize a big result into the model's context. Keep the real value
// live as `_`, return only a capped, type-aware summary the model can drill
// into with more JS.

const TRUNC_SUFFIX = (n: number) =>
  `… [truncated; full value saved as _ — inspect with more JS, e.g. _.slice(0,5) / Object.keys(_) / _.length] [truncated +${n} bytes]`;

/** Head/tail string split: take the first `headFrac` + last `tailFrac` of `s`
 * within `budget`. Returns the two parts so callers can format them
 * differently (string preview JSON-stringifies; sh-result uses a sep). */
export function headTailParts(
  s: string,
  budget: number,
  headFrac: number,
  tailFrac: number,
): { head: string; tail: string } {
  const tailLen = Math.floor(budget * tailFrac);
  return {
    head:
      Math.floor(budget * headFrac) > 0
        ? s.slice(0, Math.floor(budget * headFrac))
        : "",
 // Guard zero tail: s.slice(-0) === s.slice(0) returns the WHOLE string.
    tail: tailLen > 0 ? s.slice(-tailLen) : "",
  };
}

/** Short one-line preview of an arbitrary settled value for a notice/registry
 * entry: strings pass through, everything else is JSON-stringified (falling back
 * to String), then truncated to `max` chars with a trailing `…`. Shared by the
 * bg registry's persisted-value preview and the settle-notice preview. */
export function previewValue(v: unknown, max: number): string {
  let s: string;
  if (typeof v === "string") s = v;
  else {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
  }
  }
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Byte-aware truncate with a `… [truncated +N more bytes]` suffix. */
export function cap(str: string, maxBytes: number): string {
 // Encode incrementally would be ideal; here we cap by UTF-8 byte length.
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
 // Truncate buffer; back up over any partial multi-byte char.
  let cut = maxBytes;
 // back up over truncated continuation bytes (10xxxxxx)
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
 // if we landed on a lead byte that would be split, back up one more
  if (cut > 0) {
    const lead = buf[cut];
    const need = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
    if (cut + need > maxBytes) cut -= 1;
  }
  const kept = buf.subarray(0, cut).toString("utf8");
  const suffix = ` …[+${buf.length - cut} more bytes]`;
 // ensure final fits
  const out = kept + suffix;
  if (Buffer.byteLength(out, "utf8") <= maxBytes) return out;
 // shrink kept to make room
  let shrink = cut;
  while (
    shrink > 0 &&
    Buffer.byteLength(kept.slice(0, --shrink) + suffix, "utf8") > maxBytes
  ) {
 // decrement in loop
  }
  return kept.slice(0, shrink) + suffix;
}

/** Line-aware variant of `cap()` for run logs (`console.log` output): truncates
 * at the last newline that fits within `maxBytes` instead of an arbitrary
 * byte offset mid-line, and names how much was left out so the agent knows
 * to narrow its own slice rather than re-run for more. A single logged line
 * that alone exceeds `maxBytes` can't honor a line boundary — falls back to
 * the plain byte-aware `cap` (with its own marker) in that case. */
export function capLines(str: string, maxBytes: number): string {
  const totalBytes = Buffer.byteLength(str, "utf8");
  if (totalBytes <= maxBytes) return str;
  const lines = str.split("\n");
  const totalLines = lines.length;
  let kept = "";
  let shownLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const candidateKept = shownLines === 0 ? lines[i] : kept + "\n" + lines[i];
    const remaining = totalBytes - Buffer.byteLength(candidateKept, "utf8");
    const marker = `\n[showing first ${shownLines + 1} of ${totalLines} logged lines; +${remaining} more bytes — the values live in your variables, print a narrower slice]`;
    if (
      Buffer.byteLength(candidateKept, "utf8") +
        Buffer.byteLength(marker, "utf8") >
      maxBytes
    )
      break;
    kept = candidateKept;
    shownLines++;
  }
  if (shownLines === 0) {
 // Even the first line alone overflows the budget — no line boundary to
 // honor, fall back to the byte-aware cap.
    return cap(str, maxBytes);
  }
  const remaining = totalBytes - Buffer.byteLength(kept, "utf8");
  return (
    kept +
    `\n[showing first ${shownLines} of ${totalLines} logged lines; +${remaining} more bytes — the values live in your variables, print a narrower slice]`
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
 // proto === null → Object.create(null). Otherwise a plain object's prototype
 // is SOME realm's Object.prototype, whose own prototype is null — checking one
 // level up (rather than `proto === Object.prototype`) also accepts objects
 // built INSIDE the vm sandbox, which have the vm realm's distinct
 // Object.prototype. Without this, every object the agent constructs in run
 // code (`({ file1, file2 })`) fell through to the ugly `[Object] {…}` fallback
 // with JSON-escaped values instead of the readable `Object{…}` rendering.
 // Arrays/Errors/class instances are excluded: their prototype's prototype is
 // Object.prototype, not null.
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function functionName(fn: (...a: unknown[]) => unknown): string {
  return fn.name || "anonymous";
}

/** Per-call knobs for nested-value stringification. `strCap` bounds each nested
 * string before truncation; `maxDepth` bounds recursion. Defaults chosen so the
 * standard run-result preview shows real values (the old 60-char cap cut most
 * nested strings mid-word and cost the agent drill-in tool calls). */
export interface StringifyOpts {
  strCap?: number;
  maxDepth?: number;
}
const DEFAULT_STR_CAP = 200;
const DEFAULT_MAX_DEPTH = 6;

function tryStringify(
  v: unknown,
  budget: number,
  opts: StringifyOpts = {},
): string {
  const strCap = opts.strCap ?? DEFAULT_STR_CAP;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
 // walk with a budget; bail early. handle cycles.
  const seen = new WeakSet<object>();
  let out = "";
  let budgetLeft = budget;
  const SEP = ", ";
  function push(s: string): boolean {
    if (budgetLeft <= 0) return false;
    if (out.length + s.length > budget) {
      const room = Math.max(0, budget - out.length);
      out += s.slice(0, room);
      budgetLeft = 0;
      return false;
    }
    out += s;
    budgetLeft = budget - out.length;
    return budgetLeft > 0;
  }
  function visit(v: unknown, depth: number): boolean {
    if (budgetLeft <= 0) return false;
    if (depth > maxDepth) {
      return push("…");
    }
    if (v === null) return push("null");
    const t = typeof v;
    if (t === "undefined") return push("undefined");
    if (t === "number" || t === "boolean" || t === "bigint")
      return push(String(v));
    if (t === "string") {
      const sv = v as string;
      if (sv.length > strCap)
        return push(
          JSON.stringify(sv.slice(0, strCap - 3) + "…") +
            `(+${sv.length - (strCap - 3)} chars)`,
        );
      return push(JSON.stringify(sv));
    }
    if (t === "symbol") return push((v as symbol).toString());
    if (t === "function") {
      const fn = v as (...a: unknown[]) => unknown;
      const name = functionName(fn);
 // arg count via Function.prototype.toString length-ish
      const len = (fn as { length?: number }).length ?? 0;
      return push(`[Function: ${name}(${len} arg${len === 1 ? "" : "s"})]`);
    }
    if (t !== "object") return push(`[${t}]`);
 // object
    const obj = v as object;
    if (seen.has(obj)) return push("[Circular]");
    seen.add(obj);
    try {
      if (Array.isArray(v)) {
        if (!push("[")) return false;
        for (let i = 0; i < v.length; i++) {
          if (i > 0 && !push(SEP)) return false;
          if (!visit(v[i], depth + 1)) return false;
        }
        return push("]");
      }
      if (v instanceof Error) {
        return push(`[Error: ${v.name}: ${v.message}]`);
      }
      if (v instanceof RegExp) return push(v.toString());
      if (v instanceof Date) {
        return push(
          `[Date: ${isNaN(v.getTime()) ? "Invalid" : v.toISOString()}]`,
        );
      }
      if (v instanceof Map) {
        return push(`Map(${v.size})`);
      }
      if (v instanceof Set) {
        return push(`Set(${v.size})`);
      }
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
        return push(
          `[${v.constructor?.name ?? "TypedArray"}(${(v as { byteLength?: number }).byteLength ?? "?"} bytes)]`,
        );
      }
 // plain object
      const keys = Object.keys(v as Record<string, unknown>);
      if (!push("{")) return false;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (i > 0 && !push(SEP)) return false;
        if (!push(`${k}: `)) return false;
        if (!visit((v as Record<string, unknown>)[k], depth + 1)) return false;
      }
      return push("}");
    } finally {
      seen.delete(obj);
    }
  }
  visit(v, 0);
  return out;
}

/** Render a plain object / array whose DIRECT values include multiline strings
 * in a block layout: each multiline value shown RAW (real newlines, no JSON
 * escaping), same honesty rule as a top-level multiline string — so
 * `{ file1: read(a), file2: read(b) }` or `[read(a), read(b)]` shows real file
 * text instead of escaped, 300-char-capped snippets. Single-line and
 * non-string values render inline; nested values stay JSON-escaped (going raw
 * recursively into deep structure is ambiguous mush). Returns null when no
 * direct value is a multiline string, so the caller keeps the inline renderer. */
function renderRawContainer(
  entries: { label: string; value: unknown }[],
  header: string,
  maxBytes: number,
  opts: StringifyOpts,
): string | null {
  const isMultiline = (v: unknown): v is string =>
    typeof v === "string" && v.includes("\n");
  const multi = entries.filter((e) => isMultiline(e.value));
  if (multi.length === 0) return null;
  const parts: string[] = [header];
  for (const e of entries) {
    if (!isMultiline(e.value))
      parts.push(`${e.label}: ${tryStringify(e.value, 300, opts)}`);
  }
 // Divide the remaining byte budget evenly across the raw multiline values.
  const usedBytes = Buffer.byteLength(parts.join("\n"), "utf8");
  const perValue = Math.max(
    200,
    Math.floor((maxBytes - usedBytes) / multi.length),
  );
  for (const e of entries) {
    if (!isMultiline(e.value)) continue;
    const s = e.value as string;
    parts.push(`${e.label}: string(${s.length} chars):`);
    parts.push(capLines(s, perValue));
  }
  return parts.join("\n");
}

export function preview(
  value: unknown,
  maxBytes: number,
  opts: StringifyOpts = {},
): string {
  let out: string;
  if (value === null) out = "null";
  else if (value === undefined) out = "undefined";
  else {
    const t = typeof value;
    switch (t) {
      case "string": {
        const sv = value as string;
 // MULTILINE strings render RAW — real newlines, no JSON escaping. The
 // most common completion value is file/command text (read, git diff),
 // and a JSON-escaped rendering of it is unreadable AND dishonest about
 // the actual bytes (the agent hex-dumped files to count backslashes
 // because `\\\\"` in the preview could be one, two, or three chars on
 // disk). Single-line strings keep JSON.stringify: the quotes make
 // boundaries/trailing-whitespace visible on short exact values.
        const multiline = sv.includes("\n");
 // head/tail scale with the budget so raising sandbox.preview_max_bytes
 // actually gives the model more of the string. Tail-biased toward the end,
 // where the verdict lives for build/test output.
        const { head: headStr, tail: tailStr } = headTailParts(
          sv,
          maxBytes,
          0.75,
          0.15,
        );
 // Name the exact char offsets this split used, so `_.slice(headEnd,
 // tailStart)` reproduces the elided middle verbatim instead of a
 // generic "slice it for more" that leaves the agent guessing bounds.
        const headEnd = headStr.length;
        const tailStart = sv.length - tailStr.length;
        if (tailStart > headEnd) {
          const cursor = `[middle elided — _.slice(${headEnd}, ${tailStart}) for the rest; full value in \`_\`]`;
          out = multiline
            ? `string(${sv.length} chars):\n${headStr}\n…${cursor}…\n${tailStr}`
            : `string(${sv.length} chars): ${JSON.stringify(headStr)} … ${JSON.stringify(tailStr)} ${cursor}`;
        } else {
 // Head + tail cover the whole string — nothing is actually elided.
 // Show it once, in full; the final hard cap below still guards a
 // pathological value. The old `> 80 chars` gate took the elision
 // path here, printing the string's end TWICE and an inverted
 // `_.slice(1536, 1293)`-style cursor.
          out = multiline
            ? `string(${sv.length} chars):\n${sv}`
            : `string(${sv.length} chars): ${JSON.stringify(sv)}`;
        }
        break;
      }
      case "number":
      case "boolean":
      case "bigint":
      case "symbol":
        out = String(value);
        break;
      case "function": {
        const fn = value as (...a: unknown[]) => unknown;
        const name = functionName(fn);
        const len = (fn as { length?: number }).length ?? 0;
        out = `[Function: ${name}(${len} arg${len === 1 ? "" : "s"})]`;
        break;
      }
      case "object": {
        if (Array.isArray(value)) {
 // Multiline-string elements render RAW in a block layout (e.g.
 // [read(a), read(b)]); otherwise the inline summary below.
          const rawArr = renderRawContainer(
            value.map((v, i) => ({ label: `[${i}]`, value: v })),
            `Array(${value.length}):`,
            maxBytes,
            opts,
          );
          if (rawArr !== null) {
            out = rawArr;
            break;
          }
          const halfBudget = Math.floor(maxBytes / 2);
          const els: string[] = [];
          let used = 0;
          for (let i = 0; i < value.length; i++) {
            const elStr = tryStringify(value[i], 200, opts);
            if (used + elStr.length + 4 > halfBudget) break;
            els.push(elStr);
            used += elStr.length + 2;
          }
          const shown = els.length;
          out = `Array(${value.length}): [ ${els.join(", ")}${shown < value.length ? ", …" : ""} ]${shown < value.length ? ` (showing ${shown}/${value.length})` : ""}`;
          break;
        }
        if (value instanceof Promise) {
          out = "[Promise]";
          break;
        }
        if (value instanceof Error) {
          out = `[Error: ${value.name}: ${value.message}]`;
          break;
        }
        if (value instanceof RegExp) {
          out = value.toString();
          break;
        }
        if (value instanceof Date) {
          out = `Date: ${isNaN(value.getTime()) ? "Invalid" : value.toISOString()}`;
          break;
        }
        if (value instanceof URL) {
          out = value.href;
          break;
        }
        if (value instanceof Map) {
          out = `Map(${value.size})`;
          break;
        }
        if (value instanceof Set) {
          out = `Set(${value.size})`;
          break;
        }
        if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
 // Show a bounded hex head instead of "contents not dumped" — the old
 // opacity forced a `.toString('hex')` re-roundtrip every time the
 // agent needed to verify raw bytes.
          const bytes =
            value instanceof ArrayBuffer
            ? new Uint8Array(value)
              : new Uint8Array(
                  value.buffer,
                  value.byteOffset,
                  value.byteLength,
                );
          const shown = Math.min(bytes.length, 64);
          let hex = "";
          for (let i = 0; i < shown; i++)
            hex += (i ? " " : "") + bytes[i].toString(16).padStart(2, "0");
          out = `${value.constructor?.name ?? "TypedArray"}(${bytes.length} bytes)${shown > 0 ? ` hex: ${hex}` : ""}${shown < bytes.length ? ` … (+${bytes.length - shown} more — .toString('hex') / .subarray() for the rest)` : ""}`;
          break;
        }
 // plain object
        if (isPlainObject(value)) {
          const keys = Object.keys(value);
 // Special-case the `sh`/`sudo` result shape so a bare `sh("git diff")`
 // completion preview is useful without the model having to add
 // console.log boilerplate. Render code/signal first, then stderr
 // (~25% of budget), then stdout with the remainder (tail-biased —
 // the end of build/test output is where the verdict lives).
          if (
            keys.length === 4 &&
            "stdout" in value &&
            "stderr" in value &&
            "code" in value &&
            "signal" in value &&
            typeof (value as Record<string, unknown>).stdout === "string" &&
            typeof (value as Record<string, unknown>).stderr === "string"
          ) {
            const v = value as Record<string, string>;
            const code = v.code;
            const signal = v.signal;
            const stderrBudget = Math.floor(maxBytes * 0.25);
            const stdoutBudget = Math.max(0, maxBytes - 200 - stderrBudget);
            const stderrStr = v.stderr
              ? cap(v.stderr, stderrBudget)
              : "(empty)";
 // stdout tail-biased
            let stdoutStr: string;
            if (v.stdout.length <= stdoutBudget) {
              stdoutStr = v.stdout;
            } else {
              const { head: headPart, tail: tailPart } = headTailParts(
                v.stdout,
                stdoutBudget,
                0.3,
                0.7,
              );
              stdoutStr =
                (headPart
                  ? headPart + "\n…[truncated]…\n"
                  : "…[truncated]…\n") + tailPart;
            }
            out = `sh{ code: ${code}, signal: ${JSON.stringify(signal)} }
--- stderr ---
${stderrStr}
--- stdout (${v.stdout.length} chars; full in \`_\`) ---
${stdoutStr}`;
            break;
          }
 // Special-case the channel.send result shape so the `note`
 // (the harness's end-of-send instruction) is rendered in full
 // regardless of the nested-string cap — a truncated note cut the
 // instruction mid-sentence and the model sent duplicate messages.
          if (
            keys.length === 3 &&
            "ok" in value &&
            "channelId" in value &&
            "note" in value &&
            (value as Record<string, unknown>).ok === true
          ) {
            const v = value as Record<string, unknown>;
            out = `Object{3 keys: ok, channelId, note} { ok: true, channelId: ${JSON.stringify(v.channelId)}, note: ${JSON.stringify(v.note)} }`;
            break;
          }
          const keySummary =
            keys.length > 20
              ? keys.slice(0, 20).join(", ") + `, … +${keys.length - 20}`
              : keys.join(", ");
 // Direct multiline-string values render RAW in a block layout (e.g.
 // { file1: read(a), file2: read(b) }) so several reads/diffs in one
 // run stay readable; otherwise the inline summary below.
          const rawObj = renderRawContainer(
            keys.map((k) => ({
              label: k,
              value: (value as Record<string, unknown>)[k],
            })),
            `Object{${keys.length} keys: ${keySummary}}`,
            maxBytes,
            opts,
          );
          if (rawObj !== null) {
            out = rawObj;
            break;
          }
          const halfBudget = Math.floor(maxBytes / 2);
          const previewEntries: string[] = [];
          let used = 0;
          for (const k of keys.slice(0, 24)) {
            const v = tryStringify(
              (value as Record<string, unknown>)[k],
              300,
              opts,
            );
            if (used + v.length + 6 > halfBudget) break;
            previewEntries.push(`${k}: ${v}`);
            used += v.length + 4;
          }
          out = `Object{${keys.length} keys: ${keySummary}} { ${previewEntries.join(", ")} }`;
          break;
        }
 // unknown object class
        out = `[${value.constructor?.name ?? "Object"}] ${tryStringify(value, maxBytes / 2, opts)}`;
        break;
      }
      default:
        out = `[${t}]`;
    }
  }
 // final hard cap
  if (Buffer.byteLength(out, "utf8") > maxBytes) {
    out = cap(out, maxBytes);
    if (!out.includes("[truncated")) {
      out += "\n" + TRUNC_SUFFIX(0);
    }
  }
  return out;
}
