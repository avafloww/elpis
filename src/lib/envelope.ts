// envelope.ts — the inbound-envelope format, end to end. Owns the XML
// `<incoming-message ...>` shape shown to the agent (build side) AND the parser
// that reads author/timestamp back out of it (console presence + read side).
//
// The two directions used to live apart — `formatInboundEnvelope` in agent.ts,
// `parseEnvelope` in console/hub.ts, plus a second `envelopeAuthor` regex in
// agent.ts and a duplicated legacy-bracket fallback in each — so the format's
// two halves could drift. They live together here now: build with
// formatInboundEnvelope/formatAttachmentParts, read with parseEnvelope, and
// recover the inline utterance with extractUtterance (the inverse of the build).

/** Image/attachment metadata carried on an inbound Discord message. Defined here
 * (the envelope owns the attachment rendering) and re-exported from agent.ts so
 * existing importers keep resolving it there. */
export interface InboundMessageAttachment {
  url: string;
  name: string;
  contentType: string | null;
  localPath: string | null;
  size: number;
  inlineText?: string | null;
}

/** Escape a string for use inside a double-quoted XML attribute. */
export function escapeXmlAttr(value: string | null | undefined): string {
  const s = value ?? '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The envelope-boundary tags. Free-text bodies (message content, reply-to /
 * forwarded quotes, inlined attachment text) are UNTRUSTED — a user could type a
 * literal `</incoming-message>` to break out, or a `<incoming-message author="…">`
 * to forge a message and impersonate someone. `neutralizeEnvelopeTags` entity-
 * escapes only the leading `<` of these tags (open OR close), so the body can't
 * spawn or close envelope structure. Everything else stays verbatim: ordinary
 * `<`, `>`, `&`, and pasted code/HTML pass through untouched (this is why we don't
 * CDATA-wrap or blanket-escape). Escaping the OPENING tag too — not just the close
 * — is what actually blocks a forged envelope, not merely an early close. The
 * console renders `&lt;` back to `<`, so this is transparent to a human viewer. */
const ENVELOPE_TAG_RE = /<(\/?(?:incoming-message|reply-to|forwarded-from|mentions|attachment-content)\b)/gi;
export function neutralizeEnvelopeTags(value: string): string {
  return value.replace(ENVELOPE_TAG_RE, '&lt;$1');
}

export interface EnvelopeMessage {
  channelName: string;
  author: string;
  createdAt: string;
  content: string;
  replyTo: { id: string; author: string; content: string } | null;
  forwarded: { author: string; channelName: string | null; content: string } | null;
  mentions: string[];
  attachments: InboundMessageAttachment[];
  /** The Discord guild's slug, when known. Omitted from the envelope entirely
 * when absent (internal/harness notices have no guild). */
  guildSlug?: string | null;
  /** Whether the author is another bot. Omitted from the envelope entirely
 * when unknown (internal/harness notices carry no author-kind signal). */
  bot?: boolean;
}

/** Build the XML inbound envelope shown to the agent. The `local-time` attribute is a
 * display convenience for the agent; the authoritative `time` attribute is the ISO
 * timestamp stored in the transcript. */
export const INBOUND_REPLY_REMINDER = 'REMINDER: use elpis.channel(...).send(...) to respond. Returned turn content will be discarded, not sent.';
export const INBOUND_CONFIG_SEND_DENIED = "NOTE: you can't reply to this message due to channel configuration (allow_send=false). You can still observe and remember it.";
export const INBOUND_AMBIENT_SEND_DENIED = "NOTE: you can't reply to this message during this ambient observation turn due to configuration (discord.ambient_allow_send=false). You can still observe and remember it.";
export type InboundReplyNotice = 'send' | 'config-denied' | 'ambient-denied' | null;

export function formatInboundEnvelope(m: EnvelopeMessage, localMarker: string, replyNotice: InboundReplyNotice = null): string {
  const localTime = localMarker.replace(/^\[|\]$/g, '');
  const attrs = [
 // Absence (null/undefined), not falsiness, is what omits `guild=` — an empty
 // string is still a value and must render visibly as guild="" rather than
 // vanish into an envelope indistinguishable from an internal/harness notice.
    ...(m.guildSlug != null ? [`guild="${escapeXmlAttr(m.guildSlug)}"`] : []),
    `channel="${escapeXmlAttr(m.channelName)}"`,
    `author="${escapeXmlAttr(m.author)}"`,
    ...(m.bot !== undefined ? [`bot="${m.bot ? 'true' : 'false'}"`] : []),
    `time="${escapeXmlAttr(m.createdAt)}"`,
    `local-time="${escapeXmlAttr(localTime)}"`,
  ].join(' ');
  const parts: string[] = [];
  parts.push(`<incoming-message ${attrs}>`);
  if (m.replyTo) {
    const id = escapeXmlAttr(m.replyTo.id);
    const author = escapeXmlAttr(m.replyTo.author);
    const body = neutralizeEnvelopeTags(m.replyTo.content || '(no content)');
    parts.push(`  <reply-to id="${id}" author="${author}">${body}</reply-to>`);
  }
  if (m.forwarded) {
    const ch = escapeXmlAttr(m.forwarded.channelName ?? 'unknown');
    const author = escapeXmlAttr(m.forwarded.author);
    const body = neutralizeEnvelopeTags(m.forwarded.content || '(no content)');
    parts.push(`  <forwarded-from channel="${ch}" author="${author}">${body}</forwarded-from>`);
  }
  if (m.mentions && m.mentions.length > 0) {
    parts.push(`  <mentions>${escapeXmlAttr(m.mentions.join(', '))}</mentions>`);
  }
  if (m.attachments && m.attachments.length > 0) {
    parts.push(...formatAttachmentParts(m.attachments).map((s) => `  ${s}`));
  }
 // The message text lives INLINE as the tag's own body (no <content> child): the
 // envelope is XML-shaped for provenance, not strict XML. Structured children lead;
 // the utterance is everything between them and the closing tag.
  parts.push(neutralizeEnvelopeTags(m.content || '(no text content)'));
  parts.push('</incoming-message>');
  if (replyNotice === 'send') parts.push(INBOUND_REPLY_REMINDER);
  if (replyNotice === 'config-denied') parts.push(INBOUND_CONFIG_SEND_DENIED);
  if (replyNotice === 'ambient-denied') parts.push(INBOUND_AMBIENT_SEND_DENIED);
  return parts.join('\n');
}

interface AnimationFrameGroup {
  kind: 'emote' | 'sticker';
  name: string;
  id: string;
  count: number;
  frames: { attachment: number; frame: number }[];
}

const ANIMATION_FRAME_NAME_RE = /^(emote|sticker)-(.+)-(\d+)-frame(\d+)of(\d+)\.[^.]+$/;

function animationFrameGroups(attachments: InboundMessageAttachment[]): AnimationFrameGroup[] {
  const groups = new Map<string, AnimationFrameGroup>();
  attachments.forEach((a, i) => {
    const m = a.name.match(ANIMATION_FRAME_NAME_RE);
    if (!m) return;
    const [, kind, name, id, frameRaw, countRaw] = m;
    const frame = Number(frameRaw);
    const count = Number(countRaw);
    if (count <= 1 || frame < 1 || frame > count) return;
    const key = `${kind}:${id}:${count}`;
    const group = groups.get(key) ?? {
      kind: kind as 'emote' | 'sticker', name, id, count, frames: [],
    };
    group.frames.push({ attachment: i + 1, frame });
    groups.set(key, group);
  });
  return [...groups.values()]
    .filter((g) => g.frames.length > 1)
    .map((g) => ({ ...g, frames: g.frames.sort((a, b) => a.frame - b.frame) }));
}

/** Render the attachment section of an inbound user message. Pure; for tests. */
export function formatAttachmentParts(attachments: InboundMessageAttachment[]): string[] {
  const parts: string[] = [];
  for (const group of animationFrameGroups(attachments)) {
    const attachmentNumbers = group.frames.map((f) => f.attachment).join(',');
    const frameNumbers = group.frames.map((f) => f.frame).join(',');
    parts.push(
      `<animation-frames kind="${group.kind}" name="${escapeXmlAttr(group.name)}" id="${group.id}" ` +
      `attachments="${attachmentNumbers}" frames="${frameNumbers}" count="${group.count}">` +
      `ONE animated ${group.kind} sampled into temporal keyframes. Read these attachments in frame order as one animation, not as separate images or emotes.` +
      `</animation-frames>`,
    );
  }
  attachments.forEach((a, i) => {
    const inlined = a.inlineText !== null && a.inlineText !== undefined;
    parts.push(
      `attachment#${i + 1}: ${a.name} (${a.contentType ?? 'unknown/type'}, ${a.size} bytes)` +
      `${a.localPath ? ` -> ${a.localPath}` : ''}${inlined ? ' (inlined below)' : ''}`,
    );
  });
  for (const a of attachments) {
    if (a.inlineText === null || a.inlineText === undefined) continue;
    const name = escapeXmlAttr(a.name);
    const body = a.inlineText;
    parts.push(`<attachment-content name="${name}">${neutralizeEnvelopeTags(body)}</attachment-content>`);
  }
  return parts;
}

/** The structured children that can lead an inbound envelope, in tag form. Their
 * bodies are tag-neutralized at construction, so the FIRST matching close tag is
 * always the real one — a forged close inside a quote can't end extraction early. */
const ENVELOPE_CHILD_TAGS = ['reply-to', 'forwarded-from', 'mentions', 'animation-frames', 'attachment-content'];

/** Pull the actual utterance out of a stored user message — the inverse of
 * formatInboundEnvelope. Real inbound messages are
 * `<incoming-message ...>[structured children]\n<the text>\n</incoming-message>`;
 * the utterance is the inline text after the leading children. Messages without the
 * envelope (bg-settle notices, ghost nudges) fall back to the whole content. */
export function extractUtterance(stored: string): string {
  const open = stored.indexOf('<incoming-message');
  if (open < 0) return stored.trim();
  const openEnd = stored.indexOf('>', open);
  if (openEnd < 0) return stored.trim();
 // lastIndexOf so a neutralized-but-visually-similar close in the body can't fool us.
  const close = stored.lastIndexOf('</incoming-message>');
  const region = close > openEnd ? stored.slice(openEnd + 1, close) : stored.slice(openEnd + 1);
  return stripLeadingChildren(region).trim();
}

/** Skip past any leading structured child elements (reply-to / forwarded-from /
 * mentions / attachment-content tags and `attachment#N:` index lines), returning
 * the inline message text that follows them. Content can never be mistaken for a
 * child: its own envelope tags were neutralized to `&lt;…` at construction. */
function stripLeadingChildren(region: string): string {
  let pos = 0;
  for (;;) {
    while (pos < region.length && /\s/.test(region[pos]!)) pos++;
    const rest = region.slice(pos);
    const tag = ENVELOPE_CHILD_TAGS.find((t) => rest.startsWith('<' + t));
    if (tag) {
      const ci = region.indexOf('</' + tag + '>', pos);
      if (ci < 0) break; // malformed: treat the remainder as content
      pos = ci + tag.length + 3;
      continue;
    }
    const idx = rest.match(/^attachment#\d+:[^\n]*/);
    if (idx) { pos += idx[0].length; continue; }
    break;
  }
  return region.slice(pos);
}

/** Parse an inbound envelope, either the modern XML `<incoming-message ...>` form or the
 * legacy `[HH:MM] #chan <author> (ISO)\n...\ncontent: <text>` form. Returns the
 * author (null when not envelope-shaped — harness/nudge traffic) and the parsed
 * timestamp. Subsumes the former `envelopeAuthor` helper: `parseEnvelope(c).author`. */
export function parseEnvelope(content: string): { author: string | null; ts: number | null } {
  const xmlTag = content.match(/<incoming-message([^>]*)>/);
  if (xmlTag) {
    const attrs = xmlTag[1];
    const author = attrs.match(/\s+author="([^"]*)"/)?.[1] ?? null;
    const time = attrs.match(/\s+time="([^"]*)"/)?.[1] ?? null;
    if (author && time) {
      const t = Date.parse(time);
      return { author, ts: Number.isFinite(t) ? t : null };
    }
  }
  const first = content.split('\n', 1)[0] ?? '';
 // The (ISO) group is optional: some pre- headers carried no timestamp, and
 // an author without a timestamp still counts for presence.
  const m = first.match(/^(?:\[[^\]]+\]\s*)?#\S+\s+<([^>]+)>(?:\s+\(([^)]+)\))?/);
  if (!m) return { author: null, ts: null };
  const t = m[2] ? Date.parse(m[2]) : NaN;
  return { author: m[1], ts: Number.isFinite(t) ? t : null };
}
