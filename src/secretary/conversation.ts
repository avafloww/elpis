import { randomBytes } from 'node:crypto';
import type { ChatMessage } from '../llm/llm.js';
import type { Database } from '../store/db.js';
import {
  isSecretarySessionId,
  resolveSecretarySession,
  type SecretarySessionBinding,
} from './session.js';

const TURN_ID_RE = /^stn-[A-Za-z0-9_-]{22}$/;
const MAX_CONTENT_CHARS = 32_768;
const MAX_CONVERSATION_TURNS = 16;

export type SecretaryTurnStatus =
  'queued' | 'claimed' | 'completed' | 'ambiguous' | 'cancelled';

export interface SecretaryConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SecretaryTurn {
  id: string;
  sessionId: string;
  sequence: number;
  status: SecretaryTurnStatus;
  request: SecretaryConversationMessage & { role: 'user' };
  response: (SecretaryConversationMessage & { role: 'assistant' }) | null;
  createdAt: number;
  updatedAt: number;
  claimedAt: number | null;
  completedAt: number | null;
  lastError: string | null;
}

export interface SecretaryTurnClaim {
  turn: SecretaryTurn;
  messages: SecretaryConversationMessage[];
}

export interface SecretaryConversationStoreOptions {
  db: Database;
  now?: () => number;
  id?: () => string;
}

export class SecretaryConversationError extends Error {
  constructor(
    public readonly code:
      | 'unauthorized'
      | 'invalid_request'
      | 'not_found'
      | 'unavailable'
      | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'SecretaryConversationError';
  }
}

export function isSecretaryTurnId(value: unknown): value is string {
  return typeof value === 'string' && TURN_ID_RE.test(value);
}

export function newSecretaryTurnId(
  bytes: (size: number) => Buffer = randomBytes,
): string {
  const id = `stn-${bytes(16).toString('base64url')}`;
  if (!isSecretaryTurnId(id))
    throw new Error('secretary turn id source did not return 128 bits');
  return id;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1000,
  );
}

function message(
  value: ChatMessage,
  role: 'user' | 'assistant',
): SecretaryConversationMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SecretaryConversationError(
      'invalid_request',
      `secretary ${role} message must be an object`,
    );
  const input = value as unknown as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== 'content' ||
    keys[1] !== 'role' ||
    input.role !== role ||
    typeof input.content !== 'string' ||
    input.content.trim().length === 0
  )
    throw new SecretaryConversationError(
      'invalid_request',
      `secretary ${role} message must contain exactly role=${role} and non-empty content`,
    );
  if (Buffer.byteLength(input.content, 'utf8') > MAX_CONTENT_CHARS)
    throw new SecretaryConversationError(
      'invalid_request',
      `secretary ${role} message exceeds ${MAX_CONTENT_CHARS} UTF-8 bytes`,
    );
  return { role, content: input.content };
}

function parseMessage(
  raw: unknown,
  role: 'user' | 'assistant',
): SecretaryConversationMessage {
  if (typeof raw !== 'string')
    throw new Error('secretary turn JSON is missing');
  return message(JSON.parse(raw) as ChatMessage, role);
}

function rowTurn(row: Record<string, unknown>): SecretaryTurn {
  if (!isSecretaryTurnId(row.id))
    throw new Error('secretary turn has invalid identity');
  if (!isSecretarySessionId(row.session_id))
    throw new Error('secretary turn has invalid session identity');
  const status = row.status;
  if (
    status !== 'queued' &&
    status !== 'claimed' &&
    status !== 'completed' &&
    status !== 'ambiguous' &&
    status !== 'cancelled'
  )
    throw new Error('secretary turn has invalid status');
  const sequence = Number(row.sequence);
  const createdAt = Number(row.created_at);
  const updatedAt = Number(row.updated_at);
  const claimedAt = row.claimed_at == null ? null : Number(row.claimed_at);
  const completedAt =
    row.completed_at == null ? null : Number(row.completed_at);
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !Number.isSafeInteger(createdAt) ||
    !Number.isSafeInteger(updatedAt) ||
    (claimedAt !== null && !Number.isSafeInteger(claimedAt)) ||
    (completedAt !== null && !Number.isSafeInteger(completedAt))
  )
    throw new Error('secretary turn has invalid lifecycle numbers');
  const request = parseMessage(
    row.request_json,
    'user',
  ) as SecretaryTurn['request'];
  const response =
    row.response_json == null
      ? null
      : (parseMessage(
          row.response_json,
          'assistant',
        ) as SecretaryTurn['response']);
  return {
    id: row.id,
    sessionId: row.session_id,
    sequence,
    status,
    request,
    response,
    createdAt,
    updatedAt,
    claimedAt,
    completedAt,
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}

export class SecretaryConversationStore {
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly options: SecretaryConversationStoreOptions) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? newSecretaryTurnId;
  }

  status(turnId: string): SecretaryTurn {
    if (!isSecretaryTurnId(turnId))
      throw new SecretaryConversationError(
        'invalid_request',
        'turnId must be an exact canonical stn- identity',
      );
    const row = this.options.db
      .prepare('SELECT * FROM secretary_turns WHERE id = ?')
      .get(turnId) as Record<string, unknown> | undefined;
    if (!row)
      throw new SecretaryConversationError(
        'not_found',
        'secretary turn is unavailable',
      );
    return rowTurn(row);
  }

  list(sessionId: string): SecretaryTurn[] {
    this.validateSessionId(sessionId);
    return (
      this.options.db
        .prepare(
          'SELECT * FROM secretary_turns WHERE session_id = ? ORDER BY sequence',
        )
        .all(sessionId) as Record<string, unknown>[]
    ).map(rowTurn);
  }

  enqueue(sessionId: string, request: ChatMessage): SecretaryTurn {
    this.validateSessionId(sessionId);
    const canonical = message(request, 'user');
    const requestJson = JSON.stringify(canonical);
    const now = this.time();
    let turnId = '';
    this.options.db.exec('BEGIN IMMEDIATE');
    try {
      this.requireReadySession(sessionId);
      const count = this.options.db
        .prepare(
          'SELECT COUNT(*) AS n FROM secretary_turns WHERE session_id = ?',
        )
        .get(sessionId) as { n: number };
      if (Number(count.n) >= MAX_CONVERSATION_TURNS)
        throw new SecretaryConversationError(
          'unavailable',
          `secretary conversation reached ${MAX_CONVERSATION_TURNS} turn limit`,
        );
      const active = this.options.db
        .prepare(
          "SELECT 1 FROM secretary_turns WHERE session_id = ? AND status IN ('queued','claimed')",
        )
        .get(sessionId);
      if (active)
        throw new SecretaryConversationError(
          'conflict',
          'secretary session already has an active turn',
        );
      const previous = this.options.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) AS n FROM secretary_turns WHERE session_id = ?',
        )
        .get(sessionId) as { n: number };
      const sequence = Number(previous.n) + 1;
      for (let attempt = 0; attempt < 32; attempt++) {
        const candidate = this.id();
        if (!isSecretaryTurnId(candidate))
          throw new SecretaryConversationError(
            'invalid_request',
            'secretary turn id source returned a non-canonical identity',
          );
        if (
          !this.options.db
            .prepare('SELECT 1 FROM secretary_turns WHERE id = ?')
            .get(candidate)
        ) {
          turnId = candidate;
          break;
        }
      }
      if (!turnId)
        throw new SecretaryConversationError(
          'conflict',
          'secretary turn id space is exhausted',
        );
      this.options.db
        .prepare(
          `INSERT INTO secretary_turns
             (id,session_id,sequence,status,request_json,created_at,updated_at)
           VALUES (?,?,?,'queued',?,?,?)`,
        )
        .run(turnId, sessionId, sequence, requestJson, now, now);
      this.options.db.exec('COMMIT');
    } catch (error) {
      this.options.db.exec('ROLLBACK');
      if (error instanceof SecretaryConversationError) throw error;
      throw new SecretaryConversationError('conflict', boundedError(error));
    }
    return this.status(turnId);
  }

  claim(sessionId: string): SecretaryTurnClaim | null {
    this.validateSessionId(sessionId);
    const now = this.time();
    let turn: SecretaryTurn | null = null;
    let messages: SecretaryConversationMessage[] = [];
    this.options.db.exec('BEGIN IMMEDIATE');
    try {
      this.requireReadySession(sessionId);
      const row = this.options.db
        .prepare(
          `SELECT * FROM secretary_turns
           WHERE session_id = ? AND status = 'queued'
           ORDER BY sequence LIMIT 1`,
        )
        .get(sessionId) as Record<string, unknown> | undefined;
      if (!row) {
        this.options.db.exec('COMMIT');
        return null;
      }
      const queued = rowTurn(row);
      const changed = this.options.db
        .prepare(
          `UPDATE secretary_turns
           SET status='claimed', claimed_at=?, updated_at=?
           WHERE id=? AND session_id=? AND status='queued'`,
        )
        .run(now, now, queued.id, sessionId);
      if (Number(changed.changes) !== 1)
        throw new SecretaryConversationError(
          'conflict',
          'secretary turn changed while being claimed',
        );
      const transcript = this.options.db
        .prepare(
          `SELECT * FROM secretary_turns
           WHERE session_id = ? AND sequence <= ?
             AND (status = 'completed' OR id = ?)
           ORDER BY sequence`,
        )
        .all(sessionId, queued.sequence, queued.id) as Record<
        string,
        unknown
      >[];
      for (const entry of transcript.map(rowTurn)) {
        messages.push(entry.request);
        if (entry.status === 'completed') {
          if (!entry.response)
            throw new Error('completed secretary turn has no response');
          messages.push(entry.response);
        }
      }
      turn = rowTurn(
        this.options.db
          .prepare('SELECT * FROM secretary_turns WHERE id = ?')
          .get(queued.id) as Record<string, unknown>,
      );
      this.options.db.exec('COMMIT');
    } catch (error) {
      this.options.db.exec('ROLLBACK');
      if (error instanceof SecretaryConversationError) throw error;
      throw new SecretaryConversationError('conflict', boundedError(error));
    }
    return { turn: turn!, messages };
  }

  complete(
    sessionId: string,
    turnId: string,
    response: ChatMessage,
  ): SecretaryTurn {
    this.validateSessionId(sessionId);
    if (!isSecretaryTurnId(turnId))
      throw new SecretaryConversationError(
        'invalid_request',
        'turnId must be an exact canonical stn- identity',
      );
    const canonical = message(response, 'assistant');
    const responseJson = JSON.stringify(canonical);
    const now = this.time();
    let result: SecretaryTurn;
    this.options.db.exec('BEGIN IMMEDIATE');
    try {
      this.requireReadySession(sessionId);
      const row = this.options.db
        .prepare(
          'SELECT * FROM secretary_turns WHERE id = ? AND session_id = ?',
        )
        .get(turnId, sessionId) as Record<string, unknown> | undefined;
      if (!row)
        throw new SecretaryConversationError(
          'not_found',
          'secretary turn is unavailable',
        );
      const current = rowTurn(row);
      if (current.status === 'completed') {
        if (JSON.stringify(current.response) !== responseJson)
          throw new SecretaryConversationError(
            'conflict',
            'secretary turn was completed with a different response',
          );
        result = current;
      } else {
        if (current.status !== 'claimed')
          throw new SecretaryConversationError(
            'conflict',
            'secretary turn is not claimed',
          );
        const changed = this.options.db
          .prepare(
            `UPDATE secretary_turns
             SET status='completed', response_json=?, completed_at=?, updated_at=?
             WHERE id=? AND session_id=? AND status='claimed'`,
          )
          .run(responseJson, now, now, turnId, sessionId);
        if (Number(changed.changes) !== 1)
          throw new SecretaryConversationError(
            'conflict',
            'secretary turn changed while completing',
          );
        result = rowTurn(
          this.options.db
            .prepare('SELECT * FROM secretary_turns WHERE id = ?')
            .get(turnId) as Record<string, unknown>,
        );
      }
      this.options.db.exec('COMMIT');
    } catch (error) {
      this.options.db.exec('ROLLBACK');
      if (error instanceof SecretaryConversationError) throw error;
      throw new SecretaryConversationError('conflict', boundedError(error));
    }
    return result;
  }

  recoverClaimed(): number {
    const now = this.time();
    const result = this.options.db
      .prepare(
        `UPDATE secretary_turns
         SET status='ambiguous', updated_at=?, last_error=?
         WHERE status='claimed'`,
      )
      .run(now, 'secretary host restarted with a claimed turn');
    return Number(result.changes);
  }

  settleSession(sessionId: string, reason: string): number {
    this.validateSessionId(sessionId);
    if (typeof reason !== 'string' || reason.length < 1 || reason.length > 1000)
      throw new SecretaryConversationError(
        'invalid_request',
        'session settlement reason must contain 1 to 1000 characters',
      );
    const now = this.time();
    this.options.db.exec('BEGIN IMMEDIATE');
    try {
      const queued = this.options.db
        .prepare(
          `UPDATE secretary_turns
           SET status='cancelled', updated_at=?, last_error=?
           WHERE session_id=? AND status='queued'`,
        )
        .run(now, reason, sessionId);
      const claimed = this.options.db
        .prepare(
          `UPDATE secretary_turns
           SET status='ambiguous', updated_at=?, last_error=?
           WHERE session_id=? AND status='claimed'`,
        )
        .run(now, reason, sessionId);
      this.options.db.exec('COMMIT');
      return Number(queued.changes) + Number(claimed.changes);
    } catch (error) {
      this.options.db.exec('ROLLBACK');
      if (error instanceof SecretaryConversationError) throw error;
      throw new SecretaryConversationError('conflict', boundedError(error));
    }
  }

  private validateSessionId(sessionId: string): void {
    if (!isSecretarySessionId(sessionId))
      throw new SecretaryConversationError(
        'invalid_request',
        'sessionId must be an exact canonical sec- identity',
      );
  }

  private requireReadySession(sessionId: string): void {
    const row = this.options.db
      .prepare('SELECT status FROM secretary_sessions WHERE id = ?')
      .get(sessionId) as { status: unknown } | undefined;
    if (!row)
      throw new SecretaryConversationError(
        'not_found',
        'secretary session is unavailable',
      );
    if (row.status !== 'ready')
      throw new SecretaryConversationError(
        'unavailable',
        'secretary session is not ready',
      );
  }

  private time(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value))
      throw new SecretaryConversationError(
        'invalid_request',
        'secretary conversation time is invalid',
      );
    return value;
  }
}

export interface SecretaryConversationPullReply {
  binding: SecretarySessionBinding;
  turn: {
    id: string;
    sequence: number;
    messages: SecretaryConversationMessage[];
  } | null;
}

export interface SecretaryConversationCompleteReply {
  binding: SecretarySessionBinding;
  turn: {
    id: string;
    sequence: number;
    status: 'completed';
    completedAt: number;
  };
}

export class SecretaryConversationBroker {
  readonly store: SecretaryConversationStore;

  constructor(
    private readonly db: Database,
    store?: SecretaryConversationStore,
  ) {
    this.store = store ?? new SecretaryConversationStore({ db });
  }

  pull(token: string): SecretaryConversationPullReply {
    const binding = this.binding(token);
    const session = this.db
      .prepare('SELECT status FROM secretary_sessions WHERE id = ?')
      .get(binding.sessionId) as { status: unknown } | undefined;
    if (session?.status === 'starting') return { binding, turn: null };
    const claim = this.store.claim(binding.sessionId);
    return {
      binding,
      turn: claim
        ? {
            id: claim.turn.id,
            sequence: claim.turn.sequence,
            messages: claim.messages,
          }
        : null,
    };
  }

  complete(
    token: string,
    turnId: string,
    response: ChatMessage,
  ): SecretaryConversationCompleteReply {
    const binding = this.binding(token);
    const turn = this.store.complete(binding.sessionId, turnId, response);
    if (turn.status !== 'completed' || turn.completedAt === null)
      throw new Error('completed secretary turn has no completion receipt');
    return {
      binding,
      turn: {
        id: turn.id,
        sequence: turn.sequence,
        status: turn.status,
        completedAt: turn.completedAt,
      },
    };
  }

  private binding(token: string): SecretarySessionBinding {
    const binding = resolveSecretarySession(this.db, token);
    if (!binding)
      throw new SecretaryConversationError(
        'unauthorized',
        'secretary session is unavailable',
      );
    return binding;
  }
}
