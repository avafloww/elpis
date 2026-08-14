// scripts/feedback.ts — offline tooling for the 👍/👎 feedback subsystem. This
// is the ONLY home for content-matching (localizing a reacted Discord message
// back to a transcript send); the live harness never does it. Lives outside
// src/ (like bench/) so tsc's include:['src/**'] never builds it; run via tsx.
//
// npm run feedback -- reconcile # index the agent's message history → message_index
// npm run feedback -- review [N] # reconcile, then print recent feedback+context
//
// reconcile logs into Discord with the bot token, fetches the agent's own messages per
// channel, content-matches each against transcript sends, and UPSERTs
// message_index. review joins feedback ⨝ message_index and renders context from
// the (append-only) transcript files on demand.
//
// Reads config.yaml exactly like src/index.ts (the service entry), so this CLI
// sees the same DATA_DIRECTORY / bot token / guild the live agent uses.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import { chunkText } from '../src/discord/discord.js';
import { parseTranscriptFile, MAIN_TRANSCRIPT_ID } from '../src/store/sessions.js';
import { loadConfigFile } from '../src/config.js';
import { openDatabase } from '../src/store/db.js';
import type { ChatMessage } from '../src/llm/llm.js';

export interface LoadedFile { file: string; messages: ChatMessage[]; }
export interface Locator { file: string; sendChannel: string; sendText: string; }

const normWs = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Localize a reacted message (channelId + exact content) to a transcript send.
 * `transcripts` MUST be newest-file-first; within a file we scan back-to-front
 * so the most recent identical send wins. Exact chunk membership first, then a
 * whitespace-normalized substring fallback. */
export function localizeByContent(transcripts: LoadedFile[], channelId: string, content: string): Locator | null {
  const scan = (matchFn: (sendText: string) => boolean): Locator | null => {
    for (const t of transcripts) {
      for (let i = t.messages.length - 1; i >= 0; i--) {
        const m = t.messages[i];
        if (m.role !== 'tool' || !m.sends) continue;
        for (const s of m.sends) {
          if (s.channel !== channelId) continue;
          if (matchFn(s.text)) return { file: t.file, sendChannel: s.channel, sendText: s.text };
        }
      }
    }
    return null;
  };
  const exact = scan((sendText) => chunkText(sendText).includes(content));
  if (exact) return exact;
  const targetNorm = normWs(content);
  if (targetNorm.length === 0) return null;
  return scan((sendText) => normWs(sendText).includes(targetNorm));
}

/** Render a readable window of up to maxMessages messages ending at the tool
 * message whose sends contain sendText on sendChannel (last such match). Skips
 * reasoning. Returns '' if the send isn't found. */
export function renderContext(messages: ChatMessage[], sendChannel: string, sendText: string, maxMessages = 12): string {
  let end = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool' && m.sends?.some((s) => s.channel === sendChannel && s.text === sendText)) { end = i; break; }
  }
  if (end < 0) return '';
  const start = Math.max(0, end - maxMessages + 1);
  const lines: string[] = [];
  for (let i = start; i <= end; i++) {
    const m = messages[i];
    const who = m.role === 'tool' ? 'agent(sent)' : m.role;
    if (m.role === 'tool' && m.sends) {
      for (const s of m.sends) lines.push(`${who} → #${s.channel}: ${s.text}`);
    } else if (m.content) {
      const tag = m.channel ? ` (#${m.channel})` : '';
      lines.push(`${who}${tag}: ${m.content}`);
    }
  }
  return lines.join('\n');
}

/** Load transcript files under sessions/discord/main NEWEST-first. */
function loadTranscriptsNewestFirst(dataDirectory: string): LoadedFile[] {
  const dir = path.join(dataDirectory, 'sessions', 'discord', MAIN_TRANSCRIPT_ID);
  let names: string[];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const withMtime = names.map((n) => {
    const p = path.join(dir, n);
    let mtime = 0;
    try { mtime = fs.statSync(p).mtimeMs; } catch { /* skip */ }
    return { file: p, mtime };
  });
  withMtime.sort((a, b) => (b.mtime - a.mtime) || (a.file < b.file ? 1 : -1));
  return withMtime.map((w) => ({ file: w.file, messages: parseTranscriptFile(w.file) }));
}

async function reconcile(): Promise<void> {
  const config = loadConfigFile();
  const db = openDatabase(config.paths.dataDirectory);
  const transcripts = loadTranscriptsNewestFirst(config.paths.dataDirectory);
  const upsert = db.prepare(
    'INSERT INTO message_index (discord_message_id, channel_id, transcript_file, send_channel, send_text, source, indexed_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(discord_message_id) DO UPDATE SET ' +
    'transcript_file=excluded.transcript_file, send_channel=excluded.send_channel, send_text=excluded.send_text, indexed_at=excluded.indexed_at',
  );
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Channel],
  });
  await client.login(config.discord.botToken);
 // login resolves before ClientReady populates client.user; wait for READY so
 // the `msg.author.id !== client.user?.id` self-filter below is deterministic.
  if (!client.isReady()) await new Promise<void>((r) => client.once(Events.ClientReady, () => r()));
  let indexed = 0, scanned = 0;
  const now = new Date().toISOString();
  for (const guildConfig of config.discord.guilds) {
    const guild = await client.guilds.fetch(guildConfig.id);
    const channels = await guild.channels.fetch();
    for (const [, ch] of channels) {
      if (!ch || !ch.isTextBased() || !('messages' in ch)) continue;
      let before: string | undefined;
      for (let page = 0; page < 100; page++) { // hard cap: 100 pages × 100 = 10k msgs/channel
        const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
        if (!batch || batch.size === 0) break;
        for (const [, msg] of batch) {
          before = msg.id;
          if (msg.author.id !== client.user?.id) continue;
          scanned++;
          const loc = localizeByContent(transcripts, msg.channelId, msg.content);
          if (!loc) continue;
          upsert.run(msg.id, msg.channelId, loc.file, loc.sendChannel, loc.sendText, 'backfill', now);
          indexed++;
        }
        if (batch.size < 100) break;
      }
    }
  }
 // eslint-disable-next-line no-console
  console.log(`reconcile: scanned ${scanned} of the agent's messages, indexed ${indexed}.`);
  db.close();
  await client.destroy();
}

async function review(limit: number): Promise<void> {
  await reconcile();
  const config = loadConfigFile();
  const db = openDatabase(config.paths.dataDirectory);
  const rows = db.prepare(
    'SELECT f.*, mi.transcript_file AS tfile, mi.send_channel AS schannel, mi.send_text AS stext ' +
    'FROM feedback f LEFT JOIN message_index mi USING (discord_message_id) ORDER BY f.reacted_at DESC LIMIT ?',
  ).all(limit) as Record<string, unknown>[];
  const fileCache = new Map<string, ChatMessage[]>();
  for (const r of rows) {
    const verdict = String(r.verdict).toUpperCase();
    const who = r.reactor_name || r.reactor_id;
 // eslint-disable-next-line no-console
    console.log(`\n=== ${verdict} by ${who}${r.is_owner ? ' (owner)' : ''} @ ${r.reacted_at} — #${r.channel_name ?? r.channel_id} ===`);
 // eslint-disable-next-line no-console
    console.log(`reacted message: ${r.message_content}`);
    if (r.tfile && r.stext) {
      const file = String(r.tfile);
      if (!fileCache.has(file)) fileCache.set(file, parseTranscriptFile(file));
      const ctx = renderContext(fileCache.get(file)!, String(r.schannel), String(r.stext));
 // eslint-disable-next-line no-console
      if (ctx) console.log(`--- context ---\n${ctx}`);
    } else {
 // eslint-disable-next-line no-console
      console.log('(not localized to a transcript)');
    }
  }
}

async function mainCli(): Promise<void> {
  const [cmd = 'help', arg] = process.argv.slice(2);
  if (cmd === 'reconcile') { await reconcile(); return; }
  if (cmd === 'review') { await review(arg ? parseInt(arg, 10) || 20 : 20); return; }
 // eslint-disable-next-line no-console
  console.log('usage: npm run feedback -- <reconcile | review [N]>');
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]).includes(path.join('scripts', 'feedback'));
if (isDirect) { mainCli().catch((e) => { console.error(e); process.exit(1); }); }
