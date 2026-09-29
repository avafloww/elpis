import type { ChatMessage } from '../llm/llm.js';
import type {
  ContextGraphStore,
  EventMessageProjectionId,
  WorldId,
} from '../store/context-graph.js';

export function materializeWorldConversation(input: {
  store: ContextGraphStore;
  worldId: WorldId;
  rendererGeneration: number;
  projectionIds: readonly EventMessageProjectionId[];
}): ChatMessage[] {
  if (
    !Number.isSafeInteger(input.rendererGeneration) ||
    input.rendererGeneration < 1
  ) {
    throw new Error('renderer generation is invalid');
  }
  const seen = new Set<EventMessageProjectionId>();
  let previousSequence = -1;
  return input.projectionIds.map((projectionId) => {
    if (seen.has(projectionId)) {
      throw new Error(`duplicate projection: ${projectionId}`);
    }
    seen.add(projectionId);
    const projection = input.store.getEventMessageProjection(projectionId);
    if (!projection) {
      throw new Error(`event message projection is missing: ${projectionId}`);
    }
    if (projection.worldId !== input.worldId) {
      throw new Error(`projection world mismatch: ${projectionId}`);
    }
    if (projection.rendererGeneration !== input.rendererGeneration) {
      throw new Error(`projection renderer mismatch: ${projectionId}`);
    }
    const source = input.store.getWorldEvent(projection.sourceEventId);
    if (!source || source.worldId !== input.worldId) {
      throw new Error(`projection source mismatch: ${projectionId}`);
    }
    if (source.sequence <= previousSequence) {
      throw new Error('projection order is invalid');
    }
    previousSequence = source.sequence;
    return {
      ...projection.message,
      worldId: input.worldId,
      eventId: projection.sourceEventId,
      sequence: source.sequence,
    };
  });
}
