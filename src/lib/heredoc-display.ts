import { blankLiterals } from './jslex.js';

export interface DisplayHeredoc {
  token: string;
  source: string;
}

export interface ProtectedDisplayCode {
  code: string;
  heredocs: DisplayHeredoc[];
  error?: string;
}

const HEREDOC_MAX = 100;

function uniqueToken(code: string, index: number): string {
  let token = `__ELPIS_HEREDOC_${index}__`;
  while (code.includes(token)) token = `_${token}`;
  return token;
}

export function protectDisplayHeredocs(input: string): ProtectedDisplayCode {
  let code = input;
  const heredocs: DisplayHeredoc[] = [];
  for (let n = 0; n < HEREDOC_MAX; n++) {
    const blanked = blankLiterals(code);
    const match = /<<<([A-Za-z_][A-Za-z0-9_]*)[ \t]*\r?\n/.exec(blanked);
    if (!match) return { code, heredocs };
    const tag = match[1];
    const contentStart = match.index + match[0].length;
    const rest = code.slice(contentStart);
    const terminator = new RegExp(
      `^[ \\t]*${tag}(?![A-Za-z0-9_])([^\\r\\n]*)\\r?$`,
      'm',
    ).exec(rest);
    if (!terminator)
      return {
        code: input,
        heredocs: [],
        error: `heredoc <<<${tag} has no terminator`,
      };
    const trailer = terminator[1] ?? '';
    const carriage = terminator[0].endsWith('\r') ? 1 : 0;
    const terminatorTagLength =
      terminator[0].length - trailer.length - carriage;
    const sourceEnd = contentStart + terminator.index + terminatorTagLength;
    const blockEnd = contentStart + terminator.index + terminator[0].length;
    const token = uniqueToken(code, heredocs.length);
    heredocs.push({ token, source: code.slice(match.index, sourceEnd) });
    code =
      code.slice(0, match.index) +
      JSON.stringify(token) +
      trailer +
      code.slice(blockEnd);
  }
  return {
    code: input,
    heredocs: [],
    error: `too many heredocs in one run (max ${HEREDOC_MAX})`,
  };
}

export function restoreDisplayHeredocs(
  input: string,
  heredocs: DisplayHeredoc[],
): string {
  let code = input;
  for (const heredoc of heredocs) {
    const doubleQuoted = JSON.stringify(heredoc.token);
    const singleQuoted = `'${heredoc.token}'`;
    if (code.includes(doubleQuoted))
      code = code.replace(doubleQuoted, heredoc.source);
    else if (code.includes(singleQuoted))
      code = code.replace(singleQuoted, heredoc.source);
    else
      throw new Error(
        `formatted code lost heredoc placeholder ${heredoc.token}`,
      );
  }
  return code;
}
