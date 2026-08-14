// pkce.ts — RFC 7636 PKCE (Proof Key for Code Exchange) code verifier/challenge.
//
// Provider-agnostic: shared by every OAuth provider added under src/llm/oauth/
// (Anthropic authorization-code login today; reusable by any later browser
// OAuth flow). Codex device login receives its verifier from the server.

import { createHash, randomBytes } from 'node:crypto';

/** base64url (no padding), the encoding both the verifier and the S256
 * challenge use per RFC 7636. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface Pkce {
  /** The high-entropy secret, sent on the token exchange as `code_verifier`. */
  verifier: string;
  /** SHA-256(verifier), base64url — sent on the authorize URL as
 * `code_challenge` with `code_challenge_method=S256`. */
  challenge: string;
}

/** Generate a fresh PKCE pair. 32 random bytes → 43-char base64url verifier,
 * comfortably inside RFC 7636's 43–128 range. */
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** A random `state` value for CSRF protection on the OAuth round trip. */
export function randomState(): string {
  return base64url(randomBytes(24));
}
