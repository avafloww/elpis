import type { WorkerMailboxKind, WorkerMailboxMessage } from './mailbox.js';
import type { WorkerSessionBinding } from './session.js';

export class WorkerMailboxRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerMailboxRequestError';
  }
}

export interface WorkerMailboxService {
  pullForWorker(
    token: string,
    limit?: number,
  ): { binding: WorkerSessionBinding; messages: WorkerMailboxMessage[] };
  acknowledgeForWorker(token: string, ids: number[]): number;
  postFromWorker(
    token: string,
    messageKey: string,
    kind: WorkerMailboxKind,
    body: string,
  ): WorkerMailboxMessage;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkerMailboxRequestError('request must be an object');
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0)
    throw new WorkerMailboxRequestError(
      `unknown request field ${JSON.stringify(extra[0])}`,
    );
}

export function dispatchWorkerMailboxRequest(
  service: WorkerMailboxService,
  token: string,
  value: unknown,
): unknown {
  const input = record(value);
  if (input.protocol !== 1)
    throw new WorkerMailboxRequestError('protocol must equal 1');
  switch (input.operation) {
    case 'pull': {
      exact(input, ['protocol', 'operation', 'limit']);
      if (
        input.limit !== undefined &&
        (!Number.isInteger(input.limit) ||
          Number(input.limit) < 1 ||
          Number(input.limit) > 100)
      )
        throw new WorkerMailboxRequestError(
          'limit must be an integer from 1 to 100',
        );
      return {
        protocol: 1,
        ...service.pullForWorker(token, input.limit as number | undefined),
      };
    }
    case 'ack': {
      exact(input, ['protocol', 'operation', 'ids']);
      if (
        !Array.isArray(input.ids) ||
        input.ids.length < 1 ||
        input.ids.length > 100 ||
        input.ids.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0)
      )
        throw new WorkerMailboxRequestError(
          'ids must contain 1 to 100 positive safe integers',
        );
      return {
        protocol: 1,
        acknowledged: service.acknowledgeForWorker(
          token,
          input.ids as number[],
        ),
      };
    }
    case 'post': {
      exact(input, ['protocol', 'operation', 'messageKey', 'kind', 'body']);
      if (input.kind !== 'message' && input.kind !== 'finish')
        throw new WorkerMailboxRequestError('kind must be message or finish');
      if (
        typeof input.messageKey !== 'string' ||
        typeof input.body !== 'string'
      )
        throw new WorkerMailboxRequestError(
          'messageKey and body must be strings',
        );
      return {
        protocol: 1,
        message: service.postFromWorker(
          token,
          input.messageKey,
          input.kind,
          input.body,
        ),
      };
    }
    default:
      throw new WorkerMailboxRequestError(
        'operation must be pull, ack, or post',
      );
  }
}
