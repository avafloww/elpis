// secrets.ts — secret collection + redaction for tool-result text. Redacting
// credentials from model-visible tool results is an unconditional safety
// property of result formatting.

import type { Config } from '../config.js';

/** The live secret values worth scanning tool results for. Only values ≥8 chars
 * are considered (shorter ones would false-positive on tiny common substrings).
 *
 * Sourced from the loaded config, NOT from process.env: config.yaml is the sole
 * home of these credentials and the systemd unit carries no EnvironmentFile, so
 * reading the env here would silently yield [] — turning redactSecrets into a
 * no-op with no boot warning. */
export function collectSecretValues(config: Config): string[] {
  const candidates = [
    config.llm.apiKey,
    config.discord.botToken,
    config.kagi.apiKey,
    config.bluesky?.appPassword,
  ];
  const out: string[] = [];
  for (const v of candidates) {
    if (v && v.length >= 8) out.push(v);
  }
  return out;
}

/** Redact known secret values from a tool-result/preview string (D4). */
export function redactSecrets(text: string, secretValues: string[]): string {
  let out = text;
  for (const s of secretValues) {
    if (s.length > 0 && out.includes(s)) {
      out = out.split(s).join('[SECRET REDACTED]');
    }
  }
  return out;
}
