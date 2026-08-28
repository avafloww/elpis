import type { Config } from '../config.js';

const MIN_SECRET_LENGTH = 8;
const MAX_SECRET_BYTES = 4096;

function validSecret(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_SECRET_LENGTH &&
    Buffer.byteLength(value, 'utf8') <= MAX_SECRET_BYTES
  );
}

/** Live process-local redaction state. Secret bytes remain inside a private set;
 * callers can mutate membership or ask for redaction, never enumerate values. */
export class SecretRegistry {
  readonly #values = new Set<string>();

  constructor(initial: Iterable<string> = []) {
    for (const value of initial) this.register(value);
  }

  get size(): number {
    return this.#values.size;
  }

  register(value: string): boolean {
    if (!validSecret(value))
      throw new TypeError('secret registry value must be a bounded string');
    const size = this.#values.size;
    this.#values.add(value);
    return this.#values.size !== size;
  }

  unregister(value: string): boolean {
    if (!validSecret(value)) return false;
    return this.#values.delete(value);
  }

  redact(text: string): string {
    let out = text;
    const values = [...this.#values].sort((a, b) => b.length - a.length);
    for (const value of values)
      if (out.includes(value)) out = out.split(value).join('[SECRET REDACTED]');
    return out;
  }
}

/** Config is the boot source. Later credential state registers through the same
 * instance instead of rebuilding a stale snapshot. */
export function collectSecretValues(config: Config): string[] {
  const candidates = [
    config.llm.apiKey,
    config.discord.botToken,
    config.kagi.apiKey,
    config.bluesky?.appPassword,
    config.dashboard.remote?.enrollmentToken,
  ];
  const out: string[] = [];
  for (const value of candidates) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (!validSecret(value))
      throw new TypeError('configured secret exceeds the redaction bound');
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

export function createSecretRegistry(config: Config): SecretRegistry {
  return new SecretRegistry(collectSecretValues(config));
}

/** Redact known values before text crosses a model/log/receipt boundary. Arrays
 * remain accepted for small pure callers; Agent uses the live registry. */
export function redactSecrets(
  text: string,
  secrets: SecretRegistry | readonly string[],
): string {
  if (secrets instanceof SecretRegistry) return secrets.redact(text);
  let out = text;
  for (const value of [...secrets].sort((a, b) => b.length - a.length))
    if (value.length > 0 && out.includes(value))
      out = out.split(value).join('[SECRET REDACTED]');
  return out;
}
