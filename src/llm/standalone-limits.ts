export function addStandaloneOutputBytes(
  current: number,
  chunk: string,
  limit: number | undefined,
  abort?: () => void,
): number {
  if (limit === undefined) return current;
  const next = current + Buffer.byteLength(chunk, 'utf8');
  if (next <= limit) return next;
  abort?.();
  throw Object.assign(
    new Error(`standalone visible output exceeds ${limit} UTF-8 bytes`),
    { status: 400, code: 'standalone_output_limit' },
  );
}

export function assertStandaloneOutputBytes(
  content: string,
  limit: number | undefined,
): void {
  addStandaloneOutputBytes(0, content, limit);
}

export function isStandaloneOutputLimitError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 3; depth++) {
    if (!current || typeof current !== 'object') return false;
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      return false;
    }
    if (descriptors.code?.value === 'standalone_output_limit') return true;
    current = descriptors.cause?.value;
  }
  return false;
}
