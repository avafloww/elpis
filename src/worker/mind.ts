import type { Database } from '../store/db.js';
import type {
  CreateMindItem,
  MindDetail,
  MindComment,
  MindService,
  MindStatus,
} from '../store/mind.js';
import type { MindId } from '../store/mind-id.js';
import { resolveWorkerSession, type WorkerSessionBinding } from './session.js';

export class WorkerMindError extends Error {
  constructor(
    public readonly code: 'unauthorized' | 'outside_scope' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'WorkerMindError';
  }
}

export class WorkerMindBroker {
  constructor(
    private readonly db: Database,
    private readonly mind: MindService,
  ) {}

  private binding(token: string): WorkerSessionBinding {
    const binding = resolveWorkerSession(this.db, token);
    if (!binding)
      throw new WorkerMindError(
        'unauthorized',
        'worker session is unavailable',
      );
    return binding;
  }

  private scoped(binding: WorkerSessionBinding, id: MindId): void {
    const row = this.db
      .prepare(
        `WITH RECURSIVE scope(id) AS (
         SELECT ? UNION ALL SELECT i.id FROM mind_items i JOIN scope s ON i.parent_id = s.id
       ) SELECT 1 AS ok FROM scope WHERE id = ? LIMIT 1`,
      )
      .get(binding.mindId, id);
    if (!row)
      throw new WorkerMindError(
        'outside_scope',
        'Mind item is outside worker scope',
      );
  }

  get(
    token: string,
    id?: MindId,
  ): { binding: WorkerSessionBinding; item: MindDetail } {
    const binding = this.binding(token);
    const target = id ?? (binding.mindId as MindId);
    this.scoped(binding, target);
    const item = this.mind.get(target);
    if (!item)
      throw new WorkerMindError('not_found', 'Mind item does not exist');
    return { binding, item };
  }

  createChild(
    token: string,
    input: Omit<CreateMindItem, 'parentId' | 'actor' | 'dependsOn'> & {
      parentId?: MindId;
    },
  ): MindDetail {
    const binding = this.binding(token);
    const parentId = input.parentId ?? (binding.mindId as MindId);
    this.scoped(binding, parentId);
    return this.mind.create({ ...input, parentId, actor: binding.worker });
  }

  addComment(token: string, id: MindId, body: string): MindComment {
    const binding = this.binding(token);
    this.scoped(binding, id);
    return this.mind.addComment(id, body, binding.worker);
  }

  setStatus(token: string, id: MindId, status: MindStatus): MindDetail {
    const binding = this.binding(token);
    this.scoped(binding, id);
    return this.mind.setStatus(id, status, binding.worker);
  }
}
