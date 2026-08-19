/* Self-hosted run-card formatting. Executed source is never changed. */
(() => {
  'use strict';

  const MAX_FORMAT_CHARS = 250_000;
  const JS_ALIASES = new Set(['js', 'javascript', 'jsx', 'node']);
  const TS_ALIASES = new Set(['ts', 'typescript', 'tsx']);

  function restoreHeredocs(input, heredocs) {
    let code = input;
    for (const heredoc of heredocs || []) {
      const doubleQuoted = JSON.stringify(heredoc.token);
      const singleQuoted = `'${heredoc.token}'`;
      if (code.includes(doubleQuoted)) code = code.replace(doubleQuoted, heredoc.source);
      else if (code.includes(singleQuoted)) code = code.replace(singleQuoted, heredoc.source);
      else throw new Error(`formatted code lost heredoc placeholder ${heredoc.token}`);
    }
    return code;
  }

  function pluginsFor(parser) {
    const plugins = window.prettierPlugins || {};
    return parser === 'typescript'
      ? [plugins.typescript, plugins.estree].filter(Boolean)
      : [plugins.babel, plugins.estree].filter(Boolean);
  }

  let heredocToolsPromise;
  async function fallbackDisplay(raw) {
    if (!raw.includes('<<<')) return undefined;
    try {
      heredocToolsPromise ??= import('./heredoc-display.js');
      const tools = await heredocToolsPromise;
      const protectedCode = tools.protectDisplayHeredocs(raw);
      if (!protectedCode.error && protectedCode.heredocs.length > 0) {
        return { code: protectedCode.code, heredocs: protectedCode.heredocs };
      }
    } catch {}
    return undefined;
  }

  async function formatSource(card) {
    const raw = typeof card?.code === 'string' ? card.code : '';
    if (!window.prettier?.format || raw.length > MAX_FORMAT_CHARS) return { source: raw, language: 'javascript', formatted: false };
    const display = typeof card?.display?.code === 'string' ? card.display : await fallbackDisplay(raw);
    const input = typeof display?.code === 'string' ? display.code : raw;
    const heredocs = Array.isArray(display?.heredocs) ? display.heredocs : [];
    for (const parser of ['babel', 'typescript']) {
      try {
        const formatted = (await window.prettier.format(input, {
          parser, plugins: pluginsFor(parser), printWidth: 100, tabWidth: 2,
          singleQuote: true, semi: true, trailingComma: 'all',
        })).trimEnd();
        return {
          source: restoreHeredocs(formatted, heredocs),
          highlightSource: formatted,
          heredocs,
          language: parser === 'typescript' ? 'typescript' : 'javascript',
          formatted: true,
        };
      } catch {}
    }
    return { source: raw, language: 'javascript', formatted: false };
  }

  function highlight(element, source, language) {
    const Prism = window.Prism;
    const normalized = TS_ALIASES.has(language) ? 'typescript' : JS_ALIASES.has(language) ? 'javascript' : language;
    if (!Prism?.highlight || !Prism.languages?.[normalized]) {
      element.textContent = source;
      return;
    }
    element.className = `language-${normalized}`;
    element.innerHTML = Prism.highlight(source, Prism.languages[normalized], normalized);
  }

  function escapeHtml(source) {
    return source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightProtected(element, source, language, heredocs) {
    const Prism = window.Prism;
    const normalized = TS_ALIASES.has(language) ? 'typescript' : 'javascript';
    if (!Prism?.highlight || !Prism.languages?.[normalized]) {
      element.textContent = restoreHeredocs(source, heredocs);
      return;
    }
    let html = Prism.highlight(source, Prism.languages[normalized], normalized);
    for (const heredoc of heredocs) {
      const replacement = `<span class="token string heredoc">${escapeHtml(heredoc.source)}</span>`;
      const singleQuoted = `<span class="token string">'${heredoc.token}'</span>`;
      const doubleQuoted = `<span class="token string">"${heredoc.token}"</span>`;
      if (html.includes(singleQuoted)) html = html.replace(singleQuoted, replacement);
      else if (html.includes(doubleQuoted)) html = html.replace(doubleQuoted, replacement);
      else {
        highlight(element, restoreHeredocs(source, heredocs), normalized);
        return;
      }
    }
    element.className = `language-${normalized}`;
    element.innerHTML = html;
  }

  async function render(element, card) {
    const raw = typeof card?.code === 'string' ? card.code : '';
    highlight(element, raw, 'javascript');
    const result = await formatSource(card);
    if (result.formatted && result.heredocs?.length) highlightProtected(element, result.highlightSource, result.language, result.heredocs);
    else highlight(element, result.source, result.language);
  }

  window.ElpisRunCode = { formatSource, highlight, highlightProtected, render, restoreHeredocs };
})();
