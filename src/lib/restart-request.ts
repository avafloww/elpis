const MAX_REASON_CHARS = 1000;
const BOOT_RESTART_ENDPOINT = process.env.ELPIS_RESTART_ENDPOINT;

export interface RestartRequestOptions {
  endpoint?: string;
  timeoutMs?: number;
}

function payload(reason?: string): string {
  return JSON.stringify({
    protocol: 1,
    at: new Date().toISOString(),
    reason:
      typeof reason === 'string' ? reason.slice(0, MAX_REASON_CHARS) : null,
  });
}

export async function requestRestrictedRestart(
  reason?: string,
  options: RestartRequestOptions = {},
): Promise<void> {
  const endpoint = options.endpoint ?? BOOT_RESTART_ENDPOINT;
  if (!endpoint) throw new Error('ELPIS_RESTART_ENDPOINT is not configured');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error(`unsupported restart endpoint protocol: ${url.protocol}`);
  if (url.username || url.password || url.hash)
    throw new Error(
      'restart endpoint must not contain credentials or a fragment',
    );
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('restart timeout must be a positive finite number');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload(reason),
      redirect: 'error',
      signal: controller.signal,
    });
    await response.body?.cancel();
    if (!response.ok)
      throw new Error(`restart broker returned HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}
