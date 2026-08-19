/* Elpis Console — client app (vanilla, no build step).
 *
 * One WebSocket at /ws drives the whole screen (design decision #1). On connect
 * the server sends a `snapshot` (usage, rooms, meta, recent messages, log tail);
 * thereafter incremental events (`message`, `delta`, `usage`, `rooms`, `log`,
 * `compaction`) update the three views. Scrolling to the top of the stream pages
 * older history in via `backfill` requests (infinite scroll — the server holds
 * the record, the client only ever renders a window). */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const runCode = window.ElpisRunCode;

 // ---- tiny DOM helper ----
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('data-')) n.setAttribute(k, v);
      else if (k === 'style') n.setAttribute('style', v);
      else if (k === 'title') n.title = v;
      else n[k] = v;
    }
    if (children != null) for (const c of [].concat(children)) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  }

 // ---- markdown rendering (marked loaded from index.html) ----
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const md = (() => {
    if (typeof window.marked === 'undefined') return (s) => escapeHtml(s || '');
    try { window.marked.use({ gfm: true, breaks: false }); } catch {}
    return (s) => {
      try { return window.marked.parse(s || '', { gfm: true, breaks: false }); } catch (e) { return escapeHtml(s || ''); }
    };
  })();

 // ---- state ----
  const state = {
    theme: localStorage.getItem('ep-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    cotOpen: localStorage.getItem('ep-cot') !== 'hidden',
    toolsOpen: localStorage.getItem('ep-tools') === 'shown',
    room: 'all',
    logFilter: 'all',
    roomsById: new Map(),
    participants: 0,
    agentName: 'agent',
    meta: null,
    metaAt: 0,
    oldestId: null,
    hasMore: false,
    loading: false,
    view: ['context', 'mind'].includes(localStorage.getItem('ep-view')) ? localStorage.getItem('ep-view') : 'stream',
  };

  const mobileViewport = matchMedia('(max-width: 700px)');
  let mobileRailOpen = false;
  function setMobileRail(open) {
    mobileRailOpen = mobileViewport.matches && open;
    app.setAttribute('data-mobile-rail', mobileRailOpen ? 'open' : 'closed');
    $('rooms-toggle').setAttribute('aria-expanded', String(mobileRailOpen));
    $('rail-scrim').hidden = !mobileRailOpen;
    $('rail').inert = mobileViewport.matches && !mobileRailOpen;
    if (!mobileRailOpen && mobileViewport.matches && $('rail').contains(document.activeElement)) $('rooms-toggle').focus();
  }
  $('rooms-toggle').onclick = () => setMobileRail(!mobileRailOpen);
  $('rail-scrim').onclick = () => setMobileRail(false);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && mobileRailOpen) setMobileRail(false); });
  const onMobileViewportChange = () => setMobileRail(false);
  if (mobileViewport.addEventListener) mobileViewport.addEventListener('change', onMobileViewportChange);
  else mobileViewport.addListener(onMobileViewportChange);
  setMobileRail(false);

 // ================= theme / cot =================
  function applyTheme() {
    app.setAttribute('data-theme', state.theme);
    $('theme-icon').textContent = state.theme === 'dark' ? '☾' : '☀';
    $('theme-label').textContent = state.theme === 'dark' ? 'Amaurot' : 'Elpis';
  }
  $('theme-toggle').onclick = () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('ep-theme', state.theme);
    applyTheme();
  };
  function applyCot() {
    app.setAttribute('data-cot', state.cotOpen ? 'open' : 'closed');
    $('cot-label').textContent = state.cotOpen ? 'shown' : 'hidden';
    document.querySelectorAll('.ep-cot').forEach((d) => { d.open = state.cotOpen; });
  }
  $('cot-toggle').onclick = () => {
    state.cotOpen = !state.cotOpen;
    localStorage.setItem('ep-cot', state.cotOpen ? 'shown' : 'hidden');
    applyCot();
  };
  function applyTools() {
    $('tools-label').textContent = state.toolsOpen ? 'shown' : 'hidden';
    document.querySelectorAll('.ep-tool-fold').forEach((d) => { d.open = state.toolsOpen; });
  }
  $('tools-toggle').onclick = () => {
    state.toolsOpen = !state.toolsOpen;
    localStorage.setItem('ep-tools', state.toolsOpen ? 'shown' : 'hidden');
    applyTools();
  };
 // ================= time helpers =================
  function pad(n) { return String(n).padStart(2, '0'); }
  function hm(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function hms(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function fmtUptime(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

 // ================= rooms / spotlight =================
  function roomColor(id) {
    if (id === 'internal') return 'var(--green)';
    const r = state.roomsById.get(id);
    return r ? `var(--${r.color})` : 'var(--faint)';
  }
  function roomName(id) {
    if (id === 'internal') return 'internal';
    const r = state.roomsById.get(id);
    return r ? r.name : (id ? id.slice(-6) : 'unknown');
  }

  function setRoom(id) {
    state.room = (state.room === id) ? 'all' : id;
    $('rail').setAttribute('data-active-room', state.room);
    $('stream').setAttribute('data-active-room', state.room);
    $('lens-label').textContent = state.room === 'all' ? 'all rooms' : `spotlight · #${roomName(state.room)}`;
 // rail active button
    document.querySelectorAll('.ep-roombtn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-room-btn') === state.room);
    });
    applySpotlight();
    if (mobileViewport.matches) setMobileRail(false);
  }
  function spotlightMatches(n, active) {
    if (active === 'all' || n.getAttribute('data-global') === 'true') return true;
    if (n.getAttribute('data-room') === active) return true;
    return (n.getAttribute('data-related-rooms') || '').split(',').includes(active);
  }
  function applySpotlight() {
    const active = state.room;
    document.querySelectorAll('#stream .ep-msg, #stream .ep-divider, #stream .ep-notice').forEach((n) => {
      n.classList.toggle('dimmed', !spotlightMatches(n, active));
    });
  }

  function renderRooms(rooms, participantCount) {
    state.roomsById = new Map(rooms.map((r) => [r.id, r]));
    const list = $('rail-list');
    list.innerHTML = '';
    const total = rooms.reduce((a, r) => a + r.count, 0);

    const allBtn = el('button', { class: 'ep-roombtn' + (state.room === 'all' ? ' active' : ''), 'data-room-btn': 'all' }, [
      el('span', { class: 'ep-room-swatch' }),
      el('span', { class: 'ep-room-name', text: 'All rooms' }),
      el('span', { class: 'ep-spacer' }),
      el('span', { class: 'ep-room-count', text: String(total) }),
    ]);
    allBtn.onclick = () => setRoom('all');
    list.appendChild(allBtn);

    const discord = rooms.filter((r) => r.group === 'discord');
    const harness = rooms.filter((r) => r.group === 'harness');
    if (harness.length) list.appendChild(el('div', { class: 'ep-rail-group', text: 'harness' }));
    for (const r of harness) list.appendChild(roomButton(r));
    const guilds = [...new Set(discord.map((r) => r.guildSlug || 'unknown'))];
    for (const slug of guilds) {
      list.appendChild(el('div', { class: 'ep-rail-group', text: slug, title: slug }));
      for (const r of discord.filter((x) => (x.guildSlug || 'unknown') === slug)) list.appendChild(roomButton(r));
    }

    if (participantCount != null) state.participants = participantCount;
    $('participant-count').textContent = `${state.participants} seen`;
  }
 // window.prompt returns null on Cancel/Escape — the universal abort gesture.
 // Callers must treat that as "abort the action", not "no reason given" (an
 // empty string IS "no reason given" and still proceeds).
  function promptReason() {
    const input = window.prompt('Reason (shown to the agent):');
    return input === null ? null : (input || undefined);
  }

  function roomButton(r) {
    const isInternal = r.id === 'internal';
    const dot = el('span', { class: 'ep-room-dot' + (isInternal ? ' ring' : ''), style: isInternal ? '' : `background:${roomColor(r.id)}` });
    const kids = [
      dot,
      el('span', { class: 'ep-room-name', text: '#' + r.name, style: isInternal ? 'color:var(--soft)' : '' }),
      el('span', { class: 'ep-spacer' }),
    ];
    if (isInternal) {
      kids.push(el('span', { class: 'ep-room-hint', text: 'heartbeat' }));
    } else {
      kids.push(el('span', { class: 'ep-room-count', text: String(r.count) }));
    }
    if (r.group === 'discord' && r.allowSend === false) {
      kids.push(el('span', { class: 'ep-room-configlock', text: '🔒', title: `send disabled by config (${r.sendDeniedBy || 'policy'} allow_send=false)` }));
    } else if (r.group === 'discord' && r.muteState) {
      kids.push(el('span', { class: 'ep-room-mutestate', text: r.muteState === 'deafen' ? '🙉' : '🔇', title: `${r.muteState} active` }));
    }
    const b = el('button', { class: 'ep-roombtn' + (isInternal ? ' dashed' : '') + (state.room === r.id ? ' active' : ''), 'data-room-btn': r.id }, kids);
    b.onclick = () => setRoom(r.id);
    if (r.group !== 'discord') return b;

 // Mod buttons are SIBLINGS of the room button, not children of it — a
 // <button> nested inside another <button> is invalid HTML (the parser
 // would never let it happen from markup; appendChild lets it happen from
 // script, and assistive tech handles button-in-button inconsistently).
    const modKids = [];
    if (r.allowSend !== false) {
      const muteBtn = el('button', { class: 'ep-modbtn', text: r.muteState ? '↺' : '🔇', title: r.muteState ? 'release (unmute/undeafen)' : 'mute — the agent hears, cannot speak' });
      muteBtn.onclick = () => {
        const action = r.muteState ? (r.muteState === 'deafen' ? 'undeafen' : 'unmute') : 'mute';
        let reason;
        if (action === 'mute') {
          reason = promptReason();
          if (reason === null) return;
        }
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'moderate', channelId: r.id, action, reason }));
      };
      modKids.push(muteBtn);
    }
    if (!r.muteState || r.muteState === 'mute') {
      const deafBtn = el('button', { class: 'ep-modbtn', text: '🙉', title: 'deafen — channel stops entering the agent\'s context (implies mute)' });
      deafBtn.onclick = () => {
        const reason = promptReason();
        if (reason === null) return;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'moderate', channelId: r.id, action: 'deafen', reason }));
      };
      modKids.push(deafBtn);
    } else if (r.allowSend === false) {
      const undeafenBtn = el('button', { class: 'ep-modbtn', text: '↺', title: 'release deafen — configuration still blocks sending' });
      undeafenBtn.onclick = () => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'moderate', channelId: r.id, action: 'undeafen' }));
      };
      modKids.push(undeafenBtn);
    }
    return el('div', { class: 'ep-room-row' }, [b, el('div', { class: 'ep-room-mods' }, modKids)]);
  }

 // ================= usage meter =================
  function renderUsage(u) {
    if (!u) return;
    const pct = Math.min(100, Math.round((u.ratio || 0) * 100));
    $('meter-value').textContent = `${(u.current || 0).toLocaleString()} / ${(u.window || 0).toLocaleString()} · ${pct}%`;
    $('meter-fill').style.width = pct + '%';
    const tickPct = Math.min(100, (u.triggerRatio || 0) * 100);
    $('meter-tick').style.left = tickPct + '%';
    const sub = $('meter-sub');
    sub.style.left = tickPct + '%';
    sub.textContent = `⟂ compaction ~${Math.round((u.trigger || 0) / 1000)}k`;
    renderCache(u.cache);
  }

 // ================= prompt cache (rail) =================
 // Hidden entirely when the provider reports no cached_tokens — an all-zero
 // panel would read as "0% hit rate" rather than "no data".
  function fmtTokens(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (n >= 1e4) return Math.round(n / 1e3) + 'k';
    return n.toLocaleString();
  }
 // `fmt` is per-row on purpose: the last-turn line shows exact counts
 // (toLocaleString, like the context meter), the session line abbreviates.
  function cacheBlock(label, ratio, cached, fresh, fmt) {
    const pct = Math.max(0, Math.min(100, Math.round((ratio || 0) * 100)));
 // Polarity is inverted vs the subscription bars: here a FULL bar is good.
    const level = pct >= 80 ? 'green' : pct >= 50 ? 'amber' : 'rose';
    return el('div', { class: 'ep-su-row' }, [
      el('div', { class: 'ep-su-head' }, [
        el('span', { class: 'ep-su-label', text: label }),
        el('span', { class: 'ep-su-pct', text: pct + '%' }),
      ]),
      el('div', { class: 'ep-su-track' }, [
        el('div', { class: 'ep-su-fill', style: `width:${pct}%;background:var(--${level})` }),
      ]),
      el('div', { class: 'ep-cache-detail', text: `cached ${fmt(cached)} · new ${fmt(fresh)}` }),
    ]);
  }
  const exact = (n) => (n || 0).toLocaleString();
  function renderCache(c) {
    const box = $('rail-cache');
    if (!box) return;
    if (!c || !c.supported) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '';
    box.appendChild(el('div', { class: 'ep-rail-usage-head' }, [
      el('span', { text: 'prompt cache' }),
    ]));
    box.appendChild(cacheBlock('last turn', c.lastRatio, c.lastCached, c.lastNew, exact));
    box.appendChild(cacheBlock('session', c.totalRatio, c.totalCached, c.totalNew, fmtTokens));
    if (c.bustCount > 0) {
      box.appendChild(el('div', {
        class: 'ep-cache-busts',
        text: `${c.bustCount} bust${c.bustCount === 1 ? '' : 's'} · ${fmtTokens(c.bustTokens)} rewritten`,
      }));
    }
  }

 // ================= subscription usage (rail bottom) =================
  function fmtDelta(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return '<1m';
  }
  function resetText(iso) {
    if (!iso) return '';
    const dt = Date.parse(iso) - Date.now();
    return dt <= 0 ? 'resetting…' : 'resets in ' + fmtDelta(dt);
  }
  function renderSubUsage(snap) {
    const box = $('rail-usage');
    if (!snap || (!(snap.windows || []).length && !snap.error)) {
      box.hidden = true; box.innerHTML = ''; return;
    }
    box.hidden = false;
    box.innerHTML = '';
    box.classList.toggle('stale', !!snap.error);
    box.appendChild(el('div', { class: 'ep-rail-usage-head' }, [
      el('span', { text: (snap.label || snap.provider) + ' subscription' }),
      snap.error ? el('span', { class: 'ep-rail-usage-stale', title: snap.error, text: 'stale' }) : null,
    ]));
    for (const w of (snap.windows || [])) {
      const pct = Math.max(0, Math.min(100, Math.round(w.usedPct || 0)));
      const level = w.usedPct >= 90 ? 'rose' : w.usedPct >= 70 ? 'amber' : 'green';
      box.appendChild(el('div', { class: 'ep-su-row' }, [
        el('div', { class: 'ep-su-head' }, [
          el('span', { class: 'ep-su-label', text: w.label }),
          el('span', { class: 'ep-su-pct', text: Math.round(w.usedPct || 0) + '%' }),
        ]),
        el('div', { class: 'ep-su-track' }, [
          el('div', { class: 'ep-su-fill', style: `width:${pct}%;background:var(--${level})` }),
        ]),
        el('div', { class: 'ep-su-reset', 'data-reset': w.resetAt || null, text: resetText(w.resetAt) }),
      ]));
    }
  }
 // Reset countdowns tick client-side between polls (same cadence as uptime).
  function tickResets() {
    document.querySelectorAll('#rail-usage .ep-su-reset[data-reset]').forEach((n) => {
      n.textContent = resetText(n.getAttribute('data-reset'));
    });
  }
  setInterval(tickResets, 30000);

 // ================= meta =================
  function renderMeta(m) {
    if (!m) return;
    state.meta = m;
    state.metaAt = Date.now();
    $('git-hash').textContent = m.gitHash || 'unknown';
    if (m.botTag) {
      state.agentName = (m.botTag.split('#')[0]) || 'agent';
      $('agent-avatar').textContent = (state.agentName[0] || '◆').toUpperCase();
    }
    tickUptime();
  }
 // Uptime is sent once at connect; advance it client-side so it doesn't freeze.
  function tickUptime() {
    if (!state.meta) return;
    const up = (state.meta.uptimeMs || 0) + (Date.now() - state.metaAt);
    $('git-uptime').textContent = `up ${fmtUptime(up)} · tree ${state.meta.treeClean ? 'clean' : 'dirty'}`;
  }
  setInterval(tickUptime, 30000);

 // ================= message rendering =================
  function initials(name) {
    if (!name) return '??';
    return name.replace(/[^\w]/g, '').slice(0, 2).toLowerCase() || name.slice(0, 2).toLowerCase();
  }
  const ENVELOPE_CHILD_TAGS = ['reply-to', 'forwarded-from', 'mentions', 'animation-frames', 'attachment-content'];
 // Skip the leading structured children, returning the inline message text.
  function stripLeadingChildren(region) {
    let pos = 0;
    for (;;) {
      while (pos < region.length && /\s/.test(region[pos])) pos++;
      const rest = region.slice(pos);
      const tag = ENVELOPE_CHILD_TAGS.find((t) => rest.startsWith('<' + t));
      if (tag) {
        const ci = region.indexOf('</' + tag + '>', pos);
        if (ci < 0) break;
        pos = ci + tag.length + 3;
        continue;
      }
      const idx = rest.match(/^attachment#\d+:[^\n]*/);
      if (idx) { pos += idx[0].length; continue; }
      break;
    }
    return region.slice(pos);
  }
 // Pull the real utterance out of a stored user message. Real inbound is
 // `<incoming-message ...>[children]\n<text>\n</incoming-message>` — the message
 // text lives inline after the leading children (mirrors the server's
 // extractUtterance in agent.ts). Envelope-less notices fall through whole.
  function utterance(content) {
    content = content || '';
    const open = content.indexOf('<incoming-message');
    if (open < 0) return content.trim();
    const openEnd = content.indexOf('>', open);
    if (openEnd < 0) return content.trim();
    const close = content.lastIndexOf('</incoming-message>');
    const region = close > openEnd ? content.slice(openEnd + 1, close) : content.slice(openEnd + 1);
    return stripLeadingChildren(region).trim();
  }
 // Parse the leading `attachment#N: name (type, size bytes) -> path` metadata
 // lines out of a stored inbound envelope (the lines utterance skips).
 // Mirrors the server's formatAttachmentParts rendering (envelope.ts). Only
 // the leading-children region is scanned, so message text that merely looks
 // like an attachment line can't inject one.
  function attachmentsOf(content) {
    content = content || '';
    const open = content.indexOf('<incoming-message');
    if (open < 0) return [];
    const openEnd = content.indexOf('>', open);
    if (openEnd < 0) return [];
    const close = content.lastIndexOf('</incoming-message>');
    const region = close > openEnd ? content.slice(openEnd + 1, close) : content.slice(openEnd + 1);
    const out = [];
    let pos = 0;
    for (;;) {
      while (pos < region.length && /\s/.test(region[pos])) pos++;
      const rest = region.slice(pos);
      const tag = ENVELOPE_CHILD_TAGS.find((t) => rest.startsWith('<' + t));
      if (tag) {
        const ci = region.indexOf('</' + tag + '>', pos);
        if (ci < 0) break;
        pos = ci + tag.length + 3;
        continue;
      }
      const line = rest.match(/^attachment#\d+:[^\n]*/);
      if (line) {
        const m = line[0].match(/^attachment#\d+: (.*) \(([^()]*), (\d+) bytes\)( -> (.*?))?( \(inlined below\))?$/);
        if (m) out.push({ name: m[1], contentType: m[2], size: +m[3], localPath: m[5] || null });
        pos += line[0].length;
        continue;
      }
      break;
    }
    return out;
  }
  function tokEst(s) { return Math.max(1, Math.ceil((s || '').length / 4)); }

  function channelChip(channelId, prefix) {
    const isInternal = channelId === 'internal';
    const chip = el('span', {
      class: 'ep-chip' + (isInternal ? ' dashed' : ''),
      title: 'Spotlight #' + roomName(channelId),
    }, [
      el('span', { class: 'ep-chip-dot', style: `background:${roomColor(channelId)}` }),
      (prefix || '') + '#' + roomName(channelId),
    ]);
    chip.onclick = () => setRoom(channelId);
    return chip;
  }

  function avatar(kind, name, ch) {
    if (kind === 'assistant') {
      return el('div', { class: 'ep-msg-avatar mote' }, [el('div', { class: 'core' })]);
    }
    if (kind === 'internalbeat') {
      return el('div', { class: 'ep-msg-avatar dash' }, [el('div', { class: 'core' })]);
    }
 // user
    const colors = ['sky', 'violet', 'green', 'rose', 'amber', 'gold'];
    let h = 0; for (const c of (name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return el('div', { class: 'ep-msg-avatar', style: `background:var(--${colors[h % colors.length]})`, text: initials(name) });
  }

  function cotBlock(reasoning, dashed) {
    const details = el('details', { class: 'ep-cot' + (dashed ? ' dashed' : '') });
    details.open = state.cotOpen;
    const summary = el('summary', {}, [
      el('span', { class: 'ep-flower-gold', text: '❋' }),
      ' chain of thought ',
      el('span', { class: 'cot-tok', text: `· reasoning_content · ${tokEst(reasoning)} tok` }),
      el('span', { class: 'cot-caret', text: '▾' }),
    ]);
    summary.onclick = (e) => { e.preventDefault(); state.cotOpen = !state.cotOpen; applyCot(); };
    details.appendChild(summary);
    details.appendChild(el('div', { class: 'ep-cot-body', html: md(reasoning) }));
    return details;
  }

  function runBlock(tc) {
    const details = el('details', { class: 'ep-run ep-tool-fold' });
    details.open = state.toolsOpen;
    details.appendChild(el('summary', { class: 'ep-run-head' }, [
      el('span', { class: 'ep-run-tag', text: 'run()' }),
      el('span', { class: 'ep-run-detail', text: tc.detail || 'execute javascript · vm sandbox' }),
      el('span', { class: 'ep-spacer' }),
      el('span', { class: 'ep-run-sub', text: (tc.id || '').slice(0, 12) }),
      el('span', { class: 'ep-fold-caret', text: '▾' }),
    ]));
    const code = el('code', { class: 'language-javascript', text: tc.code || '' });
    details.appendChild(el('pre', { class: 'ep-run-code' }, code));
    void runCode?.render(code, tc);
    return details;
  }

  function bytes(s) { return s ? new TextEncoder().encode(s).length : 0; }

  function runAttribution(run) {
    if (!run) return '';
    const parts = [];
    const execution = run.execution;
    if (execution) {
      parts.push(execution.alias || execution.kind);
      if (execution.lifecycle) parts.push(execution.lifecycle);
      if (execution.mindId != null) parts.push(`Mind #${execution.mindId}`);
      if (execution.mindTitle) parts.push(execution.mindTitle);
      if (execution.mindStatus) parts.push(execution.mindStatus);
      if (execution.runId) parts.push(execution.runId);
      else if (execution.generation != null) parts.push(`g${execution.generation}`);
      if (execution.resetGeneration != null) parts.push(`reset g${execution.resetGeneration}`);
      if (execution.coldStart) parts.push('cold');
      if (execution.retiring) parts.push('retiring');
      if (execution.statusReminder) parts.push('status reminder');
      if (execution.classifierReminder) parts.push('classifier reminder');
    }
    if (run.detached) parts.push(`detached${run.bgId ? ` ${run.bgId}` : ''}`);
    if (run.wake) {
      let wake = `wake ${run.wake.state} · ${run.wake.kind}`;
      if (run.wake.targetAt) wake += ` → ${new Date(run.wake.targetAt).toISOString()}`;
      if (run.wake.taskId != null) wake += ` · task #${run.wake.taskId}`;
      if (run.wake.advice) wake += ` · ${run.wake.advice.source} ${Math.round(run.wake.advice.delayMs / 60000)}m ${run.wake.advice.reason}`;
      parts.push(wake);
    }
    return parts.join(' · ');
  }

  function resultBlock(entry) {
    const content = entry.content || '';
    const ok = !/\[run FAILED\]/.test(content);
 // split off the console section for the two-pane look
    let head = content, consoleText = '';
    const ci = content.indexOf('\n--- console ---\n');
    if (ci >= 0) { head = content.slice(0, ci); consoleText = content.slice(ci + '\n--- console ---\n'.length); }
 // the value pane drops the leading `[run ok — …]` / `[run FAILED]` status line
 // (already shown as the ● badge) so it isn't duplicated.
    const valueText = head.trim().replace(/^\[run [^\]]*\]\n?/, '').trim();
    const body = el('div', { class: 'ep-result-body' });
    if (consoleText) {
      body.appendChild(el('div', { class: 'ep-result-label', text: 'console' }));
      body.appendChild(el('pre', { class: 'ep-result-pre', text: consoleText }));
    }
    body.appendChild(el('div', { class: 'ep-result-label ep-result-value-head' }, [
      el('span', { text: ok ? 'value → saved as _' : 'error' }),
      el('span', { class: 'ep-spacer' }),
      el('span', { class: 'ep-result-sub', text: `${bytes(valueText)}B` }),
    ]));
    body.appendChild(el('pre', { class: 'ep-result-pre ep-result-scroll value', text: valueText }));
    const attribution = runAttribution(entry.run);
    if (attribution) {
      body.insertBefore(el('div', { class: 'ep-result-sub', text: attribution }), body.firstChild);
    }
    const details = el('details', { class: 'ep-result ep-tool-fold' });
    details.open = state.toolsOpen;
    details.appendChild(el('summary', { class: 'ep-result-head' }, [
      el('span', { class: 'ep-result-status ' + (ok ? 'ok' : 'err'), text: ok ? '● ok' : '● err' }),
      el('span', { class: 'ep-result-detail', text: entry.run?.detail || 'RunResult' }),
      el('span', { class: 'ep-spacer' }),
      el('span', { class: 'ep-result-sub', text: `output ${bytes(valueText)}B · logs ${bytes(consoleText)}B · ~${tokEst(content)} tok` }),
      el('span', { class: 'ep-fold-caret', text: '▾' }),
    ]));
    details.appendChild(body);
    return details;
  }

 // ---- inbound attachment rendering ----
 // Map an on-disk attachment path to the console server's /attachments/ route
 // (server.ts resolveAttachmentPath is the receiving end). Null when the
 // path isn't under the harness attachment dir.
  const ATTACH_ROOT = '/tmp/elpis-attach/';
  function attachmentHref(localPath) {
    if (!localPath || !localPath.startsWith(ATTACH_ROOT)) return null;
    return '/attachments/' + localPath.slice(ATTACH_ROOT.length).split('/').map(encodeURIComponent).join('/');
  }
  function fmtBytes(n) {
    n = n || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return Math.round(n / 1024) + ' kB';
    return n + ' B';
  }
  function attachmentChip(a) {
    const href = attachmentHref(a.localPath);
    const chip = el(href ? 'a' : 'span', {
      class: 'ep-attach-file',
      href: href || null,
      target: href ? '_blank' : null,
      rel: href ? 'noopener' : null,
      title: a.contentType || '',
    }, ['📎 ' + a.name + ' (' + fmtBytes(a.size) + ')']);
    return chip;
  }
  function attachmentsBlock(atts) {
    if (!atts.length) return null;
    const row = el('div', { class: 'ep-attachments' });
    for (const a of atts) {
      const href = attachmentHref(a.localPath);
      if (href && /^image\//i.test(a.contentType || '')) {
        const img = el('img', { class: 'ep-attach-img', src: href, alt: a.name, title: a.name, loading: 'lazy' });
        const link = el('a', { href, target: '_blank', rel: 'noopener' }, [img]);
 // /tmp is cleared on reboot — degrade a vanished file to the chip.
        img.onerror = () => { link.replaceWith(attachmentChip(a)); };
        row.appendChild(link);
      } else {
        row.appendChild(attachmentChip(a));
      }
    }
    return row;
  }

 // Build a DOM node for one stream entry.
  function renderEntry(entry) {
    const ch = entry.channel || 'internal';
    if (entry.kind === 'cleared') {
      const t = entry.ts ? hm(entry.ts) : '';
      return el('div', { class: 'ep-divider cleared', 'data-room': ch, 'data-global': 'true' }, [
        el('div', { class: 'ep-divider-line' }),
        el('div', { class: 'ep-divider-pill' }, [el('span', { text: '⊘' }), ` context cleared — history reset ${t}`]),
        el('div', { class: 'ep-divider-line' }),
      ]);
    }
    if (entry.kind === 'compaction') {
      const t = entry.ts ? hm(entry.ts) : '';
      const node = el('div', { class: 'ep-divider', 'data-room': ch, 'data-global': 'true' }, [
        el('div', { class: 'ep-divider-line' }),
        el('div', { class: 'ep-divider-pill' }, [
          el('span', { class: 'ep-flower-gold', text: '⟳' }),
          ` context compacted — ${entry.replaced || 0} messages summarized · boundary frozen ${t}`,
        ]),
        el('div', { class: 'ep-divider-line' }),
      ]);
      return node;
    }
    if (entry.kind === 'cachebust') {
      const t = entry.ts ? hm(entry.ts) : '';
      return el('div', { class: 'ep-divider cachebust', 'data-room': ch, 'data-global': 'true' }, [
        el('div', { class: 'ep-divider-line' }),
        el('div', { class: 'ep-divider-pill' }, [
          el('span', { class: 'ep-cachebust-mark', text: '⚠' }),
          ` cache busted — ${(entry.rewritten || 0).toLocaleString()} tokens rewritten ${t}`,
        ]),
        el('div', { class: 'ep-divider-line' }),
      ]);
    }
    if (entry.kind === 'yieldnudge') {
      const t = entry.ts ? hm(entry.ts) : '';
      return el('div', { class: 'ep-divider yieldnudge', 'data-room': ch, 'data-global': 'true' }, [
        el('div', { class: 'ep-divider-line' }),
        el('div', { class: 'ep-divider-pill' }, [
          el('span', { class: 'ep-yieldnudge-mark', text: '⚠' }),
          ` yield nudge — ${entry.count || 0} since last yield, no run call ${t}`,
        ]),
        el('div', { class: 'ep-divider-line' }),
      ]);
    }
    if (entry.kind === 'think-result') return el('div', { hidden: true, 'data-room': ch });
    if (entry.kind === 'notice' || entry.kind === 'system') {
      return el('div', { class: 'ep-notice from-user', 'data-room': ch, 'data-global': ch === 'internal' ? 'true' : 'false', html: md(utterance(entry.content) || entry.content) });
    }
    if (entry.kind === 'summary') {
      const nl = entry.content.indexOf('\n');
      const bodyText = nl >= 0 ? entry.content.slice(nl + 1) : entry.content;
      return el('div', { class: 'ep-msg from-user', 'data-room': ch, 'data-global': 'true' }, [
        avatar('internalbeat'),
        el('div', { class: 'ep-msg-col' }, [
          el('div', { class: 'ep-summary' }, [
            el('div', { class: 'ep-summary-head' }, [el('span', { class: 'ep-flower-gold', text: '❋' }), ' earlier memory · summary']),
            el('div', { class: 'ep-summary-body', html: md(bodyText.trim()) }),
          ]),
        ]),
      ]);
    }
    if (entry.kind === 'user') {
      const author = entry.author || 'someone';
      return el('div', { class: 'ep-msg from-user', 'data-room': ch }, [
        avatar('user', author),
        el('div', { class: 'ep-msg-col' }, [
          el('div', { class: 'ep-msg-meta' }, [
            el('span', { class: 'ep-msg-name', text: author }),
            channelChip(ch, ''),
            el('span', { class: 'ep-msg-time', text: hm(entry.ts) }),
          ]),
          el('div', { class: 'ep-bubble', html: md(utterance(entry.content)) }),
          attachmentsBlock(attachmentsOf(entry.content)),
        ]),
      ]);
    }
    if (entry.kind === 'tool') {
      const relatedRooms = [...new Set((entry.sends || []).map((s) => s.channel).filter(Boolean))].join(',');
      const col = el('div', { class: 'ep-msg-col' }, [resultBlock(entry)]);
      for (const s of (entry.sends || [])) {
        col.appendChild(el('div', { class: 'ep-bubble outbound' }, [
          el('div', { class: 'ep-msg-meta' }, [channelChip(s.channel, '→ ')]),
          el('div', { html: md(s.text) }),
        ]));
      }
      return el('div', { class: 'ep-msg from-agent', 'data-room': ch, 'data-related-rooms': relatedRooms }, [avatar('assistant'), col]);
    }
 // assistant
    const isBeat = ch === 'internal';
    const col = el('div', { class: 'ep-msg-col' });
    col.appendChild(el('div', { class: 'ep-msg-meta' }, [
      el('span', { class: 'ep-msg-name', text: state.agentName }),
      channelChip(ch, isBeat ? '' : '→ '),
      el('span', { class: 'ep-msg-time', text: hm(entry.ts) }),
    ]));
    if (entry.reasoning_content) col.appendChild(cotBlock(entry.reasoning_content, isBeat));
    if (entry.content && entry.content.trim()) col.appendChild(el('div', { class: 'ep-monologue', html: md(entry.content.trim()) }));
    for (const tc of (entry.toolCalls || [])) col.appendChild(runBlock(tc));
    return el('div', { class: 'ep-msg from-agent', 'data-room': ch }, [avatar(isBeat ? 'internalbeat' : 'assistant'), col]);
  }

 // ================= stream plumbing =================
  const body = $('stream-body');
  const streamEl = $('stream');
  const threadFollow = window.ElpisScrollFollow.createScrollFollower(streamEl, $('stream-latest'), 80);

  function appendEntry(entry) {
    const node = renderEntry(entry);
    node.dataset.entryId = entry.id;
    body.appendChild(node);
    if (state.oldestId == null || entry.id < state.oldestId) state.oldestId = entry.id;
    applySpotlightNode(node);
    threadFollow.afterGrowth();
  }
  function applySpotlightNode(n) {
    n.classList.toggle('dimmed', !spotlightMatches(n, state.room));
  }

  function prependEntries(entries) {
    const prevH = streamEl.scrollHeight;
    const prevTop = streamEl.scrollTop;
    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      const node = renderEntry(entry);
      node.dataset.entryId = entry.id;
      frag.appendChild(node);
      if (state.oldestId == null || entry.id < state.oldestId) state.oldestId = entry.id;
    }
    body.insertBefore(frag, body.firstChild);
 // preserve visual position
    streamEl.scrollTop = prevTop + (streamEl.scrollHeight - prevH);
    threadFollow.sync();
    applySpotlight();
    applyCot();
  }

  function resetStream(messages) {
    const position = threadFollow.capture();
    const restoring = body.childNodes.length > 0;
    body.innerHTML = '';
    state.oldestId = null;
    for (const m of messages) {
      const node = renderEntry(m);
      node.dataset.entryId = m.id;
      body.appendChild(node);
      if (state.oldestId == null || m.id < state.oldestId) state.oldestId = m.id;
    }
    applyCot();
    applySpotlight();
    if (restoring) threadFollow.restore(position);
    else threadFollow.toLatest();
  }

 // backfill on scroll-to-top
  streamEl.addEventListener('scroll', () => {
    if (streamEl.scrollTop < 120 && state.hasMore && !state.loading && ws && ws.readyState === 1) {
      state.loading = true;
      $('backfill-note').hidden = false;
      ws.send(JSON.stringify({ t: 'backfill', beforeId: state.oldestId }));
    }
  });

 // ================= streaming bubble =================
  const liveEl = $('stream-live');
  let stream = null; // {id, channel, content, reasoning, node}
  function ensureStream(streamId, channel) {
    if (stream && stream.id === streamId) return stream;
    liveEl.innerHTML = '';
    const wait = el('div', { class: 'ep-stream-wait', 'data-room': channel }, [
      el('span', { class: 'ep-stream-dot' }),
      document.createTextNode(`${state.agentName} is thinking`),
    ]);
    liveEl.appendChild(wait);
    stream = { id: streamId, channel, content: '', reasoning: '', wait, bubble: null, reasoningEl: null };
    if (!streamEl.hidden) requestAnimationFrame(() => threadFollow.afterGrowth());
    return stream;
  }

  function materializeStream(s) {
    if (s.bubble) return;
    const bubble = el('div', { class: 'ep-bubble' });
    const caret = el('span', { class: 'ep-caret' });
    bubble.appendChild(document.createTextNode(''));
    bubble.appendChild(caret);
    const reasoning = el('div', { class: 'ep-monologue ep-stream-reasoning' });
    reasoning.hidden = true;
    const node = el('div', { class: 'ep-msg', 'data-room': s.channel }, [
      avatar('assistant'),
      el('div', { class: 'ep-msg-col' }, [
        el('div', { class: 'ep-msg-meta' }, [
          el('span', { class: 'ep-msg-name', text: state.agentName }),
          el('span', { class: 'ep-streaming-tag', text: 'live' }),
        ]),
        reasoning,
        bubble,
      ]),
    ]);
    s.wait.replaceWith(node);
    s.bubble = bubble;
    s.reasoningEl = reasoning;
  }
  function clearStream() { stream = null; liveEl.innerHTML = ''; }

  function restoreStream(saved) {
    clearStream();
    if (!saved) return;
    const s = ensureStream(saved.streamId, saved.channel);
    if (saved.content || saved.reasoning) materializeStream(s);
    if (saved.content) { s.content = saved.content; s.bubble.firstChild.textContent = saved.content; }
    if (saved.reasoning) { s.reasoning = saved.reasoning; s.reasoningEl.hidden = false; s.reasoningEl.textContent = saved.reasoning; }
    if (!streamEl.hidden) requestAnimationFrame(() => threadFollow.afterGrowth());
  }

  function onDelta(msg) {
    const s = ensureStream(msg.streamId, msg.channel);
    materializeStream(s);
    if (msg.kind === 'content') {
      s.content += msg.text;
      s.bubble.firstChild.textContent = s.content;
    } else {
      s.reasoning += msg.text;
      s.reasoningEl.hidden = false;
      s.reasoningEl.textContent = s.reasoning;
    }
    threadFollow.afterGrowth();
  }

 // ================= context explorer =================
 // A second lens over the same column: instead of the rolling mirror (which
 // keeps compacted/cleared history visible), this shows ONLY what is in the
 // context window right now — the exact request body the next LLM call would
 // send (system message first, request-assembly diet applied, wire-shape
 // messages). Request/response uses the same socket ({t:'context'}). While
 // the pane is open, committed history events quietly debounce a fresh build.
  const ctxEl = $('ctx');
  const ctxBody = $('ctx-body');
  const contextFollow = window.ElpisScrollFollow.createScrollFollower(ctxBody, $('ctx-latest'), 80);
  const mindEl = $('mind');
  let ctxData = null;   // last ContextSnapshot received (null = unavailable)
  let ctxReqSeq = 0;    // stale responses (reqId < latest) are dropped
  let ctxRefreshTimer = null;

  function setView(v) {
    state.view = v;
    localStorage.setItem('ep-view', v);
    const inCtx = v === 'context';
    const inMind = v === 'mind';
    streamEl.hidden = inCtx || inMind;
    ctxEl.hidden = !inCtx;
    mindEl.hidden = !inMind;
    $('composer').hidden = inCtx || inMind;
    $('stream-toggle').classList.toggle('active', !inCtx && !inMind);
    $('view-toggle').classList.toggle('active', inCtx);
    $('mind-toggle').classList.toggle('active', inMind);
    $('stream-tools').hidden = inCtx || inMind;
    $('context-tools').hidden = !inCtx;
    $('mind-tools').hidden = !inMind;
    clearTimeout(ctxRefreshTimer);
    ctxRefreshTimer = null;
    if (inCtx) requestContext();
    else if (inMind) requestMindSnapshot();
    else threadFollow.afterGrowth();
  }
  $('stream-toggle').onclick = () => setView('stream');
  $('view-toggle').onclick = () => setView('context');
  $('mind-toggle').onclick = () => setView('mind');
  $('ctx-refresh').onclick = () => {
    clearTimeout(ctxRefreshTimer);
    ctxRefreshTimer = null;
    requestContext();
  };

  function requestContext(quiet = false) {
    if (!(ws && ws.readyState === 1)) return;
    ctxReqSeq++;
    if (!quiet) $('ctx-stat').textContent = 'loading…';
    ws.send(JSON.stringify({ t: 'context', reqId: ctxReqSeq }));
  }

  function scheduleContextRefresh() {
    if (state.view !== 'context') return;
    clearTimeout(ctxRefreshTimer);
    ctxRefreshTimer = setTimeout(() => {
      ctxRefreshTimer = null;
      requestContext(true);
    }, 150);
  }

 // clipboard with an execCommand fallback; flashes the button with the outcome
  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }
  function copyText(text, btn) {
    const done = (ok) => {
      if (!btn) return;
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.textContent = ok ? '✓ copied' : '✗ copy failed';
      setTimeout(() => { btn.textContent = btn.dataset.label; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(fallbackCopy(text)));
    } else {
      done(fallbackCopy(text));
    }
  }
  $('ctx-copy-json').onclick = (e) => {
    if (ctxData) copyText(JSON.stringify(ctxData, null, 2), e.currentTarget);
  };
  $('ctx-copy-jsonl').onclick = (e) => {
    if (ctxData) copyText((ctxData.messages || []).map((m) => JSON.stringify(m)).join('\n'), e.currentTarget);
  };

 // Render a message's `content` for display: either the plain string, or a
 // summary line per multimodal content part (image_url data URIs are huge —
 // the copy buttons still carry them verbatim, only the display abbreviates).
  function ctxContentText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
    return content.map((p) => {
      if (p && p.type === 'text') return p.text || '';
      if (p && p.type === 'image_url') {
        const u = (p.image_url && p.image_url.url) || '';
        return `[image_url · ${u.length > 72 ? u.slice(0, 72) + `… (${u.length.toLocaleString()} chars)` : u}]`;
      }
      return `[${(p && p.type) || 'part'}]`;
    }).join('\n');
  }

 // Label row for one sub-block (reasoning / content / tool_call): name, a
 // ~tok estimate of the block's raw text, and a copy button carrying that
 // raw text verbatim (the head's ⧉ JSON button stays the wire-shape copy).
  function ctxBlockLabel(name, rawText, note) {
    const btn = el('button', { class: 'ep-toggle ep-ctx-btn ep-ctx-blockbtn', text: '⧉', title: 'Copy this block\'s raw text' });
    btn.onclick = () => copyText(rawText, btn);
    return el('div', { class: 'ep-ctx-label' }, [
      el('span', { text: name }),
      note ? el('span', { class: 'ep-ctx-note', text: note }) : null,
      el('span', { class: 'ep-spacer' }),
      el('span', { class: 'ep-ctx-sub', text: `~${tokEst(rawText).toLocaleString()} tok` }),
      btn,
    ]);
  }

  function ctxToolCallBlock(tc) {
    const fn = (tc && tc.function && tc.function.name) || '?';
    const argsRaw = (tc && tc.function && tc.function.arguments) || '';
    let bodyText = argsRaw, note = '', bodyClass = 'ep-ctx-pre code';
    try {
      const parsed = JSON.parse(argsRaw || '{}');
      if (fn === 'think' && parsed && typeof parsed.thoughts === 'string') {
        bodyText = parsed.thoughts;
        note = 'external reasoning';
        bodyClass = 'ep-ctx-pre dim';
      } else if (parsed && typeof parsed.code === 'string') {
        bodyText = parsed.code;
        note = Object.keys(parsed).filter((k) => k !== 'code')
          .map((k) => `${k}: ${JSON.stringify(parsed[k])}`).join(' · ');
      } else {
        bodyText = JSON.stringify(parsed, null, 2);
      }
    } catch (e) { /* unparseable arguments — show raw */ }
    return el('div', {}, [
      ctxBlockLabel(`tool_call · ${fn}() · ${(tc && tc.id) || ''}`, bodyText, note),
      el('pre', { class: bodyClass, text: bodyText }),
    ]);
  }

  const CTX_ROLE_COLORS = { system: 'gold', user: 'sky', assistant: 'green', tool: 'violet' };

  function ctxMsgBlock(msg, i) {
    const role = (msg && msg.role) || '?';
    const color = CTX_ROLE_COLORS[role] || 'faint';
    const compact = JSON.stringify(msg);
    const copyBtn = el('button', { class: 'ep-toggle ep-ctx-btn', text: '⧉ JSON', title: 'Copy this message as JSON' });
    copyBtn.onclick = () => copyText(JSON.stringify(msg, null, 2), copyBtn);
    const head = el('div', { class: 'ep-ctx-msg-head' }, [
      el('span', { class: 'ep-ctx-idx', text: '#' + i }),
      el('span', { class: 'ep-ctx-role', style: `color:var(--${color});border-color:var(--${color})`, text: role }),
      msg && msg.tool_call_id ? el('span', { class: 'ep-ctx-sub', text: '↳ ' + msg.tool_call_id }) : null,
      el('span', { class: 'ep-spacer' }),
      el('span', { class: 'ep-ctx-sub', text: `~${tokEst(compact).toLocaleString()} tok · ${compact.length.toLocaleString()} chars` }),
      copyBtn,
    ]);
    const body = el('div', { class: 'ep-ctx-msg-body' });
    if (msg && msg.reasoning_content) {
      body.appendChild(ctxBlockLabel('reasoning_content', msg.reasoning_content));
      body.appendChild(el('pre', { class: 'ep-ctx-pre dim', text: msg.reasoning_content }));
    }
    const contentText = ctxContentText(msg && msg.content);
    if (contentText) {
 // raw = verbatim content (multimodal parts as JSON — the display line
 // abbreviates image data URIs, the copy must not)
      const raw = typeof (msg && msg.content) === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
      body.appendChild(ctxBlockLabel('content', raw));
      body.appendChild(el('pre', { class: 'ep-ctx-pre', text: contentText }));
    }
    for (const tc of ((msg && msg.tool_calls) || [])) body.appendChild(ctxToolCallBlock(tc));
    if (!body.childNodes.length) body.appendChild(el('div', { class: 'ep-ctx-sub', text: '(empty content)' }));
    return el('div', { class: 'ep-ctx-msg' }, [head, body]);
  }

  function renderContext() {
    const position = contextFollow.capture();
    ctxBody.innerHTML = '';
    if (!ctxData) {
      $('ctx-stat').textContent = 'unavailable';
      ctxBody.appendChild(el('div', { class: 'ep-ctx-empty', text: 'context snapshot unavailable' }));
      contextFollow.restore(position);
      return;
    }
    const msgs = ctxData.messages || [];
    let chars = 0;
    for (const m of msgs) chars += JSON.stringify(m).length;
    $('ctx-stat').textContent =
      `${msgs.length} messages · ~${Math.max(1, Math.ceil(chars / 4)).toLocaleString()} tok est · ${ctxData.model || ''}` +
      (ctxData.reasoning_effort ? ` · effort ${ctxData.reasoning_effort}` : '');
    msgs.forEach((m, i) => ctxBody.appendChild(ctxMsgBlock(m, i)));
    contextFollow.restore(position);
  }

 // ================= logs =================
  const logBody = $('log-body');
  function appendLog(line) {
    const stick = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 40;
    const node = el('div', { class: 'ep-log-line', 'data-level': line.level }, [
      el('span', { class: 'ep-log-ts', text: hms(line.ts) }),
      ' ',
      el('span', { class: 'ep-log-lvl', text: `[${line.level}]` }),
      ' ' + line.msg,
    ]);
    logBody.appendChild(node);
    while (logBody.childNodes.length > 800) logBody.removeChild(logBody.firstChild);
    if (stick) logBody.scrollTop = logBody.scrollHeight;
  }
  $('log-filters').querySelectorAll('.ep-log-chip').forEach((chip) => {
    chip.onclick = () => {
      state.logFilter = chip.getAttribute('data-level');
      logBody.setAttribute('data-filter', state.logFilter);
      $('log-filters').querySelectorAll('.ep-log-chip').forEach((c) => c.classList.toggle('active', c === chip));
    };
  });

 // ================= mind / external cortex =================
  const mindState = { available: null, items: [], stats: null, selectedId: null, detail: null, mode: 'view', req: 0, filter: 'active', tag: null, sort: localStorage.getItem('ep-mind-sort') || 'updated_desc' };
  const mindListEl = $('mind-list');
  const mindDetailEl = $('mind-detail');

  function mindSend(op, payload = {}) {
    if (!(ws && ws.readyState === 1)) { setMindStatus('socket unavailable', true); return 0; }
    const reqId = ++mindState.req;
    ws.send(JSON.stringify({ t: 'mind', op, reqId, ...payload }));
    return reqId;
  }
  function requestMindSnapshot() { mindSend('snapshot'); }
  function requestMindDetail(id) { if (id != null) mindSend('get', { id }); }
  function setMindStatus(text, bad = false) {
    const node = $('mind-status'); node.textContent = text || ''; node.style.color = bad ? 'var(--rose)' : '';
  }
  function mindDate(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function mindRelative(ms) {
    if (!ms) return '';
    const delta = ms - Date.now();
    const abs = Math.abs(delta);
    const units = abs < 60_000 ? ['second', 1000] : abs < 3_600_000 ? ['minute', 60_000] : abs < 86_400_000 ? ['hour', 3_600_000] : abs < 2_592_000_000 ? ['day', 86_400_000] : abs < 31_536_000_000 ? ['month', 2_592_000_000] : ['year', 31_536_000_000];
    return new Intl.RelativeTimeFormat([], { numeric: 'auto' }).format(Math.round(delta / units[1]), units[0]);
  }
  function toLocalInput(ms) {
    if (!ms) return '';
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }
  function fromLocalInput(value) { return value ? new Date(value).getTime() : null; }
  function mindTags(value) { return (value || '').split(',').map((x) => x.trim()).filter(Boolean); }
  function mindIds(value) { return (value || '').split(',').map((x) => x.trim()).filter(Boolean); }

  function applyMindSnapshot(snapshot) {
    if (!snapshot) return;
    mindState.available = snapshot.available !== false;
    mindState.items = snapshot.items || [];
    mindState.stats = snapshot.stats || null;
    setMindStatus(snapshot.error || (mindState.available ? `${mindState.items.length} items` : 'unavailable'), !mindState.available);
    renderMindStats(); renderMindList();
    if (mindState.selectedId != null && mindState.mode !== 'new') requestMindDetail(mindState.selectedId);
  }

  function renderMindStats() {
    const box = $('mind-stats'); box.innerHTML = '';
    const s = mindState.stats;
    if (!s) return;
    const items = mindState.items;
    const values = [
      ['all', items.length], ['active', s.active], ['ready', s.ready], ['blocked', s.blocked],
      ['in_progress', items.filter((x) => x.archivedAt == null && x.status === 'in_progress').length],
      ['waiting', s.waiting], ['overdue', s.overdue], ['done', s.done], ['inbox', s.inbox],
      ['archived', items.filter((x) => x.archivedAt != null).length],
    ];
    for (const [filter, value] of values) {
      const label = filter.replace('_', ' ');
      const pill = el('button', { class: `ep-mind-stat${mindState.filter === filter ? ' active' : ''}`, 'data-filter': filter }, [el('strong', { text: String(value ?? 0) }), document.createTextNode(` ${label}`)]);
      pill.type = 'button';
      pill.onclick = () => { mindState.filter = filter; renderMindStats(); renderMindList(); };
      box.appendChild(pill);
    }
  }

  function compareMindItems(a, b) {
    const sort = mindState.sort;
    const asc = sort.endsWith('_asc');
    const field = sort.startsWith('created') ? 'createdAt' : sort.startsWith('last_comment') ? 'lastCommentAt' : 'updatedAt';
    const av = a[field], bv = b[field];
    if (av == null && bv != null) return 1;
    if (av != null && bv == null) return -1;
    if (av !== bv) return (av < bv ? -1 : 1) * (asc ? 1 : -1);
    return (a.id - b.id) * (asc ? 1 : -1);
  }

  function filteredMindItems() {
    const filter = mindState.filter;
    const query = $('mind-search').value.trim().toLowerCase();
    const now = Date.now();
    return mindState.items.filter((item) => {
      const archived = item.archivedAt != null;
      let pass = true;
      if (filter === 'active') pass = !archived && ['inbox', 'open', 'in_progress', 'waiting'].includes(item.status);
      else if (filter === 'ready') pass = !archived && ['inbox', 'open'].includes(item.status) && item.effectiveStatus !== 'blocked';
      else if (filter === 'blocked') pass = !archived && item.effectiveStatus === 'blocked';
      else if (filter === 'in_progress') pass = !archived && item.status === 'in_progress';
      else if (filter === 'waiting') pass = !archived && item.status === 'waiting';
      else if (filter === 'overdue') pass = !archived && item.dueAt && item.dueAt < now && !['done', 'cancelled'].includes(item.status);
      else if (filter === 'done') pass = !archived && item.status === 'done';
      else if (filter === 'inbox') pass = !archived && item.status === 'inbox';
      else if (filter === 'archived') pass = archived;
      if (pass && mindState.tag) pass = (item.tags || []).includes(mindState.tag);
      if (!pass || !query) return pass;
      return `${item.title} ${item.body} ${(item.tags || []).join(' ')}`.toLowerCase().includes(query);
    }).sort(compareMindItems);
  }

  function renderMindList() {
    mindListEl.innerHTML = '';
    const tagChip = $('mind-tag-filter');
    tagChip.hidden = !mindState.tag;
    tagChip.textContent = mindState.tag ? `#${mindState.tag} ×` : '';
    const items = filteredMindItems();
    if (!items.length) { mindListEl.appendChild(el('div', { class: 'ep-mind-empty', text: 'nothing in this slice' })); return; }
    for (const item of items) {
      const effective = item.effectiveStatus || item.status;
      const tagButtons = (item.tags || []).map((tag) => {
        const button = el('button', { class: `ep-mind-card-tag${mindState.tag === tag ? ' active' : ''}`, text: `#${tag}`, title: `Show only #${tag}` });
        button.type = 'button';
        button.onclick = (event) => { event.stopPropagation(); mindState.tag = mindState.tag === tag ? null : tag; renderMindList(); };
        return button;
      });
      const card = el('div', { class: `ep-mind-card${mindState.selectedId === item.id ? ' active' : ''}`, 'data-status': effective }, [
        el('div', { class: 'ep-mind-card-title', text: `#${item.id} · ${item.title}` }),
        el('div', { class: 'ep-mind-card-meta' }, [
          el('span', { text: effective.replace('_', ' ') }), el('span', { text: `p${item.priority}` }),
          item.dueAt ? el('span', { text: `due ${mindDate(item.dueAt)}` }) : null,
          item.blockedBy && item.blockedBy.length ? el('span', { text: `← ${item.blockedBy.map((x) => '#' + x.id).join(', ')}` }) : null,
          ...tagButtons,
        ]),
        el('div', { class: 'ep-mind-card-times' }, [
          el('span', { text: `created ${mindRelative(item.createdAt)}`, title: `Created ${mindDate(item.createdAt)}` }),
          el('span', { text: `updated ${mindRelative(item.updatedAt)}`, title: `Updated ${mindDate(item.updatedAt)}` }),
          item.lastCommentAt ? el('span', { text: `commented ${mindRelative(item.lastCommentAt)}`, title: `Last comment ${mindDate(item.lastCommentAt)}` }) : null,
        ]),
      ]);
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Open item #${item.id}: ${item.title}`);
      card.tabIndex = 0;
      card.onclick = () => { mindState.mode = 'view'; mindState.selectedId = item.id; renderMindList(); requestMindDetail(item.id); };
      card.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); card.click(); }
      };
      mindListEl.appendChild(card);
    }
  }

  function selectControl(values, current) {
    const select = el('select', { class: 'ep-field' });
    for (const [value, label] of values) { const o = el('option', { text: label }); o.value = value; if (value === current) o.selected = true; select.appendChild(o); }
    return select;
  }
  function field(label, control, wide = false) { control.setAttribute('aria-label', label); return el('div', { class: `ep-mind-field${wide ? ' wide' : ''}` }, [el('label', { text: label }), control]); }
  function mini(label, fn) { const b = el('button', { class: 'ep-mind-mini', text: label }); b.type = 'button'; b.onclick = fn; return b; }
  function section(title, actions = []) {
    const box = el('div', { class: 'ep-mind-section' });
    box.appendChild(el('div', { class: 'ep-mind-section-head' }, [
      el('div', { class: 'ep-mind-section-title', text: title }),
      actions.length ? el('div', { class: 'ep-mind-section-actions' }, actions) : null,
    ]));
    return box;
  }
  function copyMini(text, title = 'Copy raw markdown') {
    let button;
    button = mini('⧉ copy', () => copyText(text || '', button));
    button.title = title;
    return button;
  }
  function mindFact(label, value) {
    return el('div', { class: 'ep-mind-fact' }, [
      el('div', { class: 'ep-mind-fact-label', text: label }),
      el('div', { class: 'ep-mind-fact-value', text: value == null || value === '' ? '—' : String(value) }),
    ]);
  }
  function mindMarkdown(text, empty = 'Nothing written yet.') {
    return text && text.trim()
      ? el('div', { class: 'ep-mind-markdown', html: md(text) })
      : el('div', { class: 'ep-mind-empty-inline', text: empty });
  }
  function renderMindReadDetail(item) {
    const root = el('div', { class: 'ep-mind-read' });
    const edit = mini('✎ edit', () => { mindState.mode = 'edit'; renderMindDetail(item); });
    edit.title = 'Edit item fields and relations';
    const archive = mini(item.archivedAt ? 'restore' : 'archive', () => {
      if (!item.archivedAt && !confirm(`Archive #${item.id}?`)) return;
      mindSend(item.archivedAt ? 'restore' : 'archive', { id: item.id });
    });
    root.appendChild(el('div', { class: 'ep-mind-read-head' }, [
      el('div', { class: 'ep-mind-read-title', text: `#${item.id} · ${item.title}` }),
      el('div', { class: 'ep-mind-actions' }, [edit, archive]),
    ]));
    const priorities = ['none', 'low', 'normal', 'high', 'urgent'];
    root.appendChild(el('div', { class: 'ep-mind-facts' }, [
      mindFact('kind', item.kind),
      mindFact('state', item.effectiveStatus),
      mindFact('stored status', item.status),
      mindFact('priority', `p${item.priority} · ${priorities[item.priority] || 'custom'}`),
      mindFact('due', item.dueAt ? mindDate(item.dueAt) : null),
      mindFact('parent', item.parentId ? `#${item.parentId}` : null),
      mindFact('tags', (item.tags || []).map((tag) => `#${tag}`).join(' ')),
      mindFact('created by', item.createdBy),
      mindFact('created', item.createdAt ? mindDate(item.createdAt) : null),
      mindFact('updated', item.updatedAt ? mindDate(item.updatedAt) : null),
    ]));
    const details = section('details', [copyMini(item.body, 'Copy raw item body markdown')]);
    details.appendChild(mindMarkdown(item.body));
    root.appendChild(details);
    renderMindRelations(item, root, false);
    mindDetailEl.appendChild(root);
  }

  function renderMindDetail(item = mindState.detail) {
    mindDetailEl.innerHTML = '';
    const creating = mindState.mode === 'new';
    if (!creating && !item) { mindDetailEl.appendChild(el('div', { class: 'ep-mind-empty', text: 'Select an item, or make the next true piece of work.' })); return; }
    if (!creating && mindState.mode !== 'edit') { renderMindReadDetail(item); return; }
    const source = creating ? { title: '', body: '', kind: 'task', status: 'open', priority: 2, tags: [], parentId: null, dueAt: null } : item;
    const form = el('form', { class: 'ep-mind-form' });
    const grid = el('div', { class: 'ep-mind-form-grid' });
    const title = el('input', { class: 'ep-field' }); title.value = source.title || ''; title.required = true; title.maxLength = 240;
    const body = el('textarea', { class: 'ep-field' }); body.value = source.body || '';
    const kind = selectControl([['task','task'],['project','project'],['idea','idea'],['question','question'],['reminder','reminder']], source.kind || 'task');
    const status = selectControl([['inbox','inbox'],['open','open'],['in_progress','in progress'],['waiting','waiting'],['done','done'],['cancelled','cancelled']], source.status || 'open');
    const priority = selectControl([['0','none'],['1','low'],['2','normal'],['3','high'],['4','urgent']], String(source.priority ?? 2));
    const due = el('input', { class: 'ep-field' }); due.type = 'datetime-local'; due.value = toLocalInput(source.dueAt);
    const tags = el('input', { class: 'ep-field' }); tags.value = (source.tags || []).join(', '); tags.placeholder = 'harness, writing';
    const parent = el('input', { class: 'ep-field' }); parent.value = source.parentId || ''; parent.placeholder = 'optional item id';
    grid.append(field('title', title, true), field('details', body, true), field('kind', kind), field('status', status), field('priority', priority), field('due', due), field('tags', tags), field('parent', parent));
    let initialDeps = null;
    if (creating) { initialDeps = el('input', { class: 'ep-field' }); initialDeps.placeholder = 'comma-separated prerequisite ids'; grid.appendChild(field('depends on', initialDeps, true)); }
    form.appendChild(grid);
    const actions = el('div', { class: 'ep-mind-actions' });
    const save = el('button', { class: 'ep-toggle ep-mind-btn primary', text: creating ? 'create item' : 'save changes' }); save.type = 'submit'; actions.appendChild(save);
    if (!creating) {
      actions.appendChild(mini('cancel', () => { mindState.mode = 'view'; renderMindDetail(source); }));
      actions.appendChild(el('span', { class: 'ep-mind-note', text: `editing #${source.id} · ${source.effectiveStatus}${source.updatedAt ? ' · updated ' + mindDate(source.updatedAt) : ''}` }));
    }
    form.appendChild(actions);
    form.onsubmit = (event) => {
      event.preventDefault();
      const itemPayload = { title: title.value, body: body.value, kind: kind.value, status: status.value, priority: Number(priority.value), dueAt: fromLocalInput(due.value), tags: mindTags(tags.value), parentId: parent.value.trim() || null };
      if (creating) {
        itemPayload.dependsOn = mindIds(initialDeps.value);
        mindSend('create', { item: itemPayload });
      } else mindSend('update', { id: source.id, patch: itemPayload });
      setMindStatus('saving…');
    };
    mindDetailEl.appendChild(form);
    if (!creating) renderMindRelations(source, form, true);
  }

  function renderMindRelations(item, root, editable) {
    const deps = section('dependencies');
    const dependencies = item.dependencies || [];
    if (!dependencies.length) deps.appendChild(el('div', { class: 'ep-mind-empty-inline', text: 'No prerequisites.' }));
    for (const dep of dependencies) deps.appendChild(el('div', { class: 'ep-mind-row' }, [
      el('div', { class: 'ep-mind-row-main', text: `#${dep.id} · ${dep.title} [${dep.effectiveStatus}]` }),
      mini('open', () => { mindState.selectedId = dep.id; requestMindDetail(dep.id); }),
      editable ? mini('unlink', () => mindSend('unlink', { id: item.id, dependsOn: dep.id })) : null,
    ]));
    if (editable) {
      const depInput = el('input', { class: 'ep-field' }); depInput.placeholder = 'prerequisite id';
      const depAdd = mini('link', () => { if (depInput.value.trim()) mindSend('link', { id: item.id, dependsOn: depInput.value.trim() }); });
      deps.appendChild(el('div', { class: 'ep-mind-inline' }, [depInput, depAdd]));
    }
    if (item.blocks && item.blocks.length) deps.appendChild(el('div', { class: 'ep-mind-note', text: `blocks: ${item.blocks.map((x) => '#' + x.id + ' ' + x.title).join(' · ')}` }));
    if (item.children && item.children.length) deps.appendChild(el('div', { class: 'ep-mind-note', text: `children: ${item.children.map((x) => '#' + x.id + ' ' + x.title).join(' · ')}` }));
    root.appendChild(deps);

    const reminders = section('reminders');
    const liveReminders = (item.reminders || []).filter((x) => !x.cancelledAt);
    if (!liveReminders.length) reminders.appendChild(el('div', { class: 'ep-mind-empty-inline', text: 'No active reminders.' }));
    for (const reminder of liveReminders) reminders.appendChild(el('div', { class: 'ep-mind-row' }, [
      el('div', { class: 'ep-mind-row-main' }, [el('div', { text: `r#${reminder.id} · ${mindDate(reminder.fireAt)}` }), el('div', { class: 'ep-mind-row-meta', text: reminder.firedAt ? `fired ${mindDate(reminder.firedAt)}` : 'scheduled' })]),
      editable && !reminder.firedAt ? mini('cancel', () => mindSend('cancelReminder', { reminderId: reminder.id })) : null,
    ]));
    if (editable) {
      const remindAt = el('input', { class: 'ep-field' }); remindAt.type = 'datetime-local';
      reminders.appendChild(el('div', { class: 'ep-mind-inline' }, [remindAt, mini('schedule', () => { const at = fromLocalInput(remindAt.value); if (at) mindSend('remind', { id: item.id, at }); })]));
    }
    root.appendChild(reminders);

    const comments = section('comments');
    const commentRows = [...(item.comments || [])].sort((a, b) => {
      const aTime = Date.parse(a.createdAt || '') || 0;
      const bTime = Date.parse(b.createdAt || '') || 0;
      return bTime - aTime || b.id - a.id;
    });
    if (!commentRows.length) comments.appendChild(el('div', { class: 'ep-mind-empty-inline', text: 'No comments yet.' }));
    for (const comment of commentRows) comments.appendChild(el('div', { class: 'ep-mind-row ep-mind-comment' }, [
      el('div', { class: 'ep-mind-row-main' }, [mindMarkdown(comment.body, 'Empty comment.'), el('div', { class: 'ep-mind-row-meta', text: `c#${comment.id} · ${comment.author} · ${mindDate(comment.updatedAt || comment.createdAt)}` })]),
      copyMini(comment.body, `Copy raw markdown for comment c#${comment.id}`),
      editable ? mini('edit', () => { const body = prompt('Edit comment', comment.body); if (body != null) mindSend('updateComment', { commentId: comment.id, body }); }) : null,
      editable ? mini('delete', () => { if (confirm(`Delete comment c#${comment.id}?`)) mindSend('deleteComment', { commentId: comment.id }); }) : null,
    ]));
    if (editable) {
      const commentBody = el('textarea', { class: 'ep-field' }); commentBody.placeholder = 'append a note, decision, or result…'; commentBody.rows = 3;
      comments.appendChild(commentBody);
      comments.appendChild(el('div', { class: 'ep-mind-actions' }, [mini('add comment', () => { if (commentBody.value.trim()) mindSend('comment', { id: item.id, body: commentBody.value }); })]));
    }
    root.appendChild(comments);

    const activity = section('activity');
    for (const event of (item.events || []).slice(0, 30)) activity.appendChild(el('div', { class: 'ep-mind-activity', text: `${mindDate(event.createdAt)} · ${event.actor} · ${event.type}` }));
    root.appendChild(activity);
  }

  function applyMindDetail(message) {
    mindState.detail = message.item || null;
    if (mindState.detail) { mindState.selectedId = mindState.detail.id; mindState.mode = 'view'; }
    renderMindList(); renderMindDetail();
  }
  function applyMindResult(message) {
    if (!message.ok) { setMindStatus(message.error || 'operation failed', true); return; }
    setMindStatus(`${message.op} complete`);
    const result = message.result;
    const id = result && typeof result === 'object' ? (result.itemId || result.id) : mindState.selectedId;
    if (id) { mindState.selectedId = id; mindState.mode = 'view'; requestMindDetail(id); }
  }

  const mindSorts = ['created_asc', 'created_desc', 'updated_asc', 'updated_desc', 'last_comment_asc', 'last_comment_desc'];
  if (!mindSorts.includes(mindState.sort)) mindState.sort = 'updated_desc';
  $('mind-sort').value = mindState.sort;
  $('mind-sort').onchange = (event) => { mindState.sort = event.target.value; localStorage.setItem('ep-mind-sort', mindState.sort); renderMindList(); };
  $('mind-tag-filter').onclick = () => { mindState.tag = null; renderMindList(); };
  $('mind-search').oninput = renderMindList;
  $('mind-refresh').onclick = requestMindSnapshot;
  $('mind-new').onclick = () => { mindState.mode = 'new'; mindState.selectedId = null; mindState.detail = null; renderMindList(); renderMindDetail(); };

 // ================= log dock resize =================
 // the split is persisted in localStorage; the stored px height is re-clamped
 // against the CURRENT viewport on restore, so a window that shrank between
 // sessions can never resurrect a dock taller than the stream.
  const resizer = $('resizer'), logdock = $('logdock'), logToggle = $('log-toggle');
  const LOGDOCK_KEY = 'ep-logdock-h';
  const MOBILE_LOG_KEY = 'ep-mobile-log';
  const clampDock = (h) => Math.max(96, Math.min(Math.max(120, window.innerHeight - 240), h));
  let mobileLogOpen = false;

  try {
    const saved = parseInt(localStorage.getItem(LOGDOCK_KEY), 10);
    if (Number.isFinite(saved)) logdock.style.height = clampDock(saved) + 'px';
    mobileLogOpen = localStorage.getItem(MOBILE_LOG_KEY) === 'open';
  } catch (e) { /* storage blocked — fall back to the CSS defaults */ }

  function applyMobileLog() {
    const open = mobileViewport.matches && mobileLogOpen;
    logdock.setAttribute('data-mobile-open', String(open));
    logToggle.setAttribute('aria-expanded', String(open));
    logToggle.textContent = open ? 'hide' : 'show';
  }
  logToggle.onclick = () => {
    mobileLogOpen = !mobileLogOpen;
    try { localStorage.setItem(MOBILE_LOG_KEY, mobileLogOpen ? 'open' : 'closed'); } catch (e) { /* non-fatal */ }
    applyMobileLog();
  };
  if (mobileViewport.addEventListener) mobileViewport.addEventListener('change', applyMobileLog);
  else mobileViewport.addListener(applyMobileLog);
  applyMobileLog();

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = logdock.offsetHeight;
    const onMove = (ev) => {
      const dy = startY - ev.clientY;
      logdock.style.height = clampDock(startH + dy) + 'px';
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      try { localStorage.setItem(LOGDOCK_KEY, String(logdock.offsetHeight)); } catch (e) { /* non-fatal */ }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.userSelect = 'none';
  });


 // ================= console chat composer =================
  const composer = $('composer');
  const composerText = $('composer-text');
  const composerStatus = $('composer-status');
  const pendingChats = new Map();

  function resizeComposer() {
    composerText.style.height = 'auto';
    composerText.style.height = `${Math.min(160, composerText.scrollHeight)}px`;
  }
  function submitConsoleChat() {
    const content = composerText.value;
    if (!content.trim()) return;
    if (!(ws && ws.readyState === WebSocket.OPEN)) {
      composerStatus.textContent = 'console disconnected — message kept locally';
      return;
    }
    const nonce = crypto.randomUUID();
    pendingChats.set(nonce, content);
    ws.send(JSON.stringify({ t: 'chat', nonce, content }));
    composerText.value = '';
    resizeComposer();
    composerStatus.textContent = '';
  }
  composer.addEventListener('submit', (event) => { event.preventDefault(); submitConsoleChat(); });
  composerText.addEventListener('input', resizeComposer);
  composerText.addEventListener('focus', () => { if (state.room !== 'console') setRoom('console'); });
  composerText.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitConsoleChat();
    }
  });

 // ================= websocket =================
  let ws = null, backoff = 500;
  function setWs(stateName) {
    const chip = $('ws-chip');
    chip.setAttribute('data-state', stateName);
    $('ws-state').textContent = '· ' + stateName;
  }
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    $('ws-url').textContent = `${location.host}/ws`;
    setWs('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => { setWs('live'); backoff = 500; };
    ws.onclose = () => { setWs('dropped'); clearStream(); setTimeout(connect, backoff); backoff = Math.min(8000, backoff * 2); };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      handle(m);
    };
  }

  function handle(m) {
    switch (m.t) {
      case 'snapshot':
        renderMeta(m.meta);
        renderUsage(m.usage);
        renderRooms(m.rooms || [], m.participants);
        renderSubUsage(m.subUsage);
        state.hasMore = !!m.hasMore;
        resetStream(m.messages || []);
        restoreStream(m.stream || null);
        logBody.innerHTML = '';
        for (const l of (m.logs || [])) appendLog(l);
        logBody.scrollTop = logBody.scrollHeight;
 // a reconnect while the explorer is open re-fetches the (possibly
 // changed) context window
        if (m.mind) applyMindSnapshot(m.mind);
        if (state.view === 'context') requestContext();
        else if (state.view === 'mind' && !m.mind) requestMindSnapshot();
        break;
      case 'message':
 // an assistant/tool message ends the live streaming bubble
        if (m.msg.kind === 'assistant' || m.msg.kind === 'tool') clearStream();
 // a compaction divider means the fold applied — clear the "compacting" badge
        if (m.msg.kind === 'compaction') $('compacting').hidden = true;
        appendEntry(m.msg);
        scheduleContextRefresh();
        break;
      case 'history':
        state.loading = false;
        $('backfill-note').hidden = true;
        state.hasMore = !!m.hasMore;
        if (m.messages && m.messages.length) prependEntries(m.messages);
        break;
      case 'delta': onDelta(m); break;
      case 'streamStart': ensureStream(m.streamId, m.channel); break;
      case 'streamEnd': clearStream(); break;
      case 'usage': renderUsage(m.usage); break;
      case 'subUsage': renderSubUsage(m.usage); break;
      case 'rooms': renderRooms(m.rooms || [], m.participants); break;
      case 'log': appendLog(m.line); break;
      case 'moderateResult': appendLog({ level: m.ok ? 'info' : 'warn', ts: Date.now(), msg: m.note }); break;
      case 'chatResult':
        if (m.ok) pendingChats.delete(m.nonce);
        else if (pendingChats.has(m.nonce)) composerText.value = pendingChats.get(m.nonce);
        composerStatus.textContent = m.ok ? '' : `not sent · ${m.note}`;
        if (!m.ok) { pendingChats.delete(m.nonce); resizeComposer(); composerText.focus(); }
        break;
      case 'mindSnapshot': applyMindSnapshot(m); break;
      case 'mindDetail': applyMindDetail(m); break;
      case 'mindResult': applyMindResult(m); break;
      case 'context':
 // drop stale responses — only the latest request paints the pane
        if (m.reqId === ctxReqSeq) { ctxData = m.context || null; renderContext(); }
        break;
      case 'compaction':
 // a fold started in the background — show the badge until the divider lands
        if (m.phase === 'started') $('compacting').hidden = false;
        break;
    }
  }

 // ================= boot =================
  applyTheme();
  applyCot();
  applyTools();
  setView(state.view); // restore the persisted pane; the snapshot handler fetches the context if needed
  connect();
})();
