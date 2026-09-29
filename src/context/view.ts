import type { ChatMessage } from '../llm/llm.js';
import type {
  ContextGraphStore,
  EventMessageProjectionId,
  SystemLayerProjectionId,
  SystemLayerKind,
  WorldId,
} from '../store/context-graph.js';

const SYSTEM_LAYER_ORDER: Readonly<Record<SystemLayerKind, number>> = {
  runtime_contract: 0,
  identity: 1,
  integrated_self: 2,
  world_policy: 3,
  private_frontier: 4,
  legacy_memory: 5,
  legacy_focus: 6,
  runtime_hint: 7,
};

export function materializeSystemProjection(input: {
  store: ContextGraphStore;
  worldId: WorldId;
  rendererGeneration: number;
  policyGeneration: number;
  layerIds: readonly SystemLayerProjectionId[];
}): ChatMessage {
  if (
    !Number.isSafeInteger(input.rendererGeneration) ||
    input.rendererGeneration < 1 ||
    !Number.isSafeInteger(input.policyGeneration) ||
    input.policyGeneration < 1
  ) {
    throw new Error('system projection generation is invalid');
  }
  const seen = new Set<SystemLayerProjectionId>();
  const kinds: SystemLayerKind[] = [];
  let previousOrder = -1;
  const content = input.layerIds.map((layerId) => {
    if (seen.has(layerId)) {
      throw new Error(`duplicate system layer projection: ${layerId}`);
    }
    seen.add(layerId);
    const layer = input.store.getSystemLayerProjection(layerId);
    if (!layer) {
      throw new Error(`system layer projection is missing: ${layerId}`);
    }
    if (
      layer.rendererGeneration !== input.rendererGeneration ||
      layer.policyGeneration !== input.policyGeneration
    ) {
      throw new Error(`system layer generation mismatch: ${layerId}`);
    }
    if (
      layer.visibility === 'legacy_mixed' ||
      layer.visibility === 'integrated_self_candidate' ||
      layer.visibility === 'private_root'
    ) {
      throw new Error(`system layer is not branch-visible: ${layerId}`);
    }
    if (
      (layer.visibility === 'world' && layer.worldId !== input.worldId) ||
      (layer.visibility !== 'world' && layer.worldId !== null)
    ) {
      throw new Error(`system layer world mismatch: ${layerId}`);
    }
    if (
      (layer.visibility === 'global_contract' &&
        layer.kind !== 'runtime_contract') ||
      (layer.visibility === 'integrated_self' &&
        layer.kind !== 'identity' &&
        layer.kind !== 'integrated_self') ||
      (layer.visibility === 'world' && layer.kind !== 'world_policy')
    ) {
      throw new Error(`system layer scope mismatch: ${layerId}`);
    }
    const order = SYSTEM_LAYER_ORDER[layer.kind];
    if (order <= previousOrder) {
      throw new Error('system layer order is invalid');
    }
    previousOrder = order;
    kinds.push(layer.kind);
    return layer.content;
  });
  if (
    kinds[0] !== 'runtime_contract' ||
    !kinds.some((kind) => kind === 'identity' || kind === 'integrated_self')
  ) {
    throw new Error('system projection is incomplete');
  }
  return { role: 'system', content: content.join('') };
}

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
