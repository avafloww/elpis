export const PLURALKIT_BOT_ID = '466378653216014359';
export const PLURALKIT_REQUEST_TIMEOUT_MS = 5000;

export interface PluralKitMember {
  name?: string | null;
  display_name?: string | null;
}

export interface PluralKitMessage {
  id: string;
  original: string;
  sender: string;
  member?: PluralKitMember | null;
}

export interface PluralKitIdentity {
  author: string;
  authorId: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function pluralKitIdentity(info: PluralKitMessage, fallbackAuthor: string): PluralKitIdentity {
  const displayName = info.member?.display_name?.trim();
  const memberName = info.member?.name?.trim();
  return {
    author: displayName || memberName || fallbackAuthor,
    authorId: info.sender,
  };
}

export function isPluralKitCommand(content: string): boolean {
  return /^\s*pk;/i.test(content);
}

export class PluralKitResolver {
  private readonly cache = new Map<string, PluralKitMessage>();

  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly baseUrl = 'https://api.pluralkit.me/v2',
    private readonly originalHoldMs = 2500,
  ) {}

  async resolve(messageId: string, holdForOriginal = false): Promise<PluralKitMessage | null> {
    const cached = this.cache.get(messageId);
    if (cached) return cached;

    if (holdForOriginal && this.originalHoldMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.originalHoldMs));
      const afterHold = this.cache.get(messageId);
      if (afterHold) return afterHold;
    }

    const res = await this.fetcher(`${this.baseUrl}/messages/${encodeURIComponent(messageId)}`, {
      headers: { 'User-Agent': 'elpis/0.1' },
      signal: AbortSignal.timeout(PLURALKIT_REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const raw = await res.json() as Partial<PluralKitMessage>;
    if (typeof raw.id !== 'string' || typeof raw.original !== 'string' || typeof raw.sender !== 'string') {
      throw new Error('response omitted id/original/sender');
    }
    const info = raw as PluralKitMessage;
    if (this.cache.size >= 1000) this.cache.clear();
    this.cache.set(info.id, info);
    this.cache.set(info.original, info);
    return info;
  }
}
