import { createHash } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  type GatewayToResidentFrame,
  type ResidentToGatewayFrame,
} from './types.js';

export const CANONICAL_IDS = Object.freeze({
  instanceId: 'egi1.AAAAAAAAAAAAAAAAAAAAAA',
  connectionId: 'egx1.BBBBBBBBBBBBBBBBBBBBBB',
  viewerId: 'egv1.CCCCCCCCCCCCCCCCCCCCCC',
  requestId: 'egr1.DDDDDDDDDDDDDDDDDDDDDD',
} as const);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const mediaData = Buffer.from('hi').toString('base64');
const mediaSha256 = createHash('sha256').update('hi').digest('hex');

/** Stable examples used by both sides as wire-contract fixtures. */
export const CANONICAL_V1 = deepFreeze({
  residentHello: {
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 1,
    type: 'hello',
    instanceId: CANONICAL_IDS.instanceId,
    capabilities: ['console.v1', 'identity.v1', 'media.v1'],
    identity: { name: 'Elpis' },
    build: { version: '0.0.0', revision: 'contract-vector', state: 'clean' },
  } satisfies ResidentToGatewayFrame,
  gatewayAck: {
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 1,
    type: 'hello.ack',
    instanceId: CANONICAL_IDS.instanceId,
    capabilities: ['console.v1', 'identity.v1', 'media.v1'],
  } satisfies GatewayToResidentFrame,
  viewerOpen: {
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 2,
    type: 'viewer.open',
    requestId: CANONICAL_IDS.requestId,
    viewerId: CANONICAL_IDS.viewerId,
  } satisfies GatewayToResidentFrame,
  operationResult: {
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 2,
    type: 'operation.result',
    requestId: CANONICAL_IDS.requestId,
    viewerId: CANONICAL_IDS.viewerId,
    operation: 'viewer.open',
    ok: true,
  } satisfies ResidentToGatewayFrame,
  consoleOutput: {
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 3,
    type: 'console.output',
    viewerId: CANONICAL_IDS.viewerId,
    payload: '{"type":"snapshot","reqId":"inner-id-is-opaque"}',
  } satisfies ResidentToGatewayFrame,
  mediaResult: {
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 4,
    type: 'media.result',
    requestId: CANONICAL_IDS.requestId,
    ok: true,
    mediaType: 'text/plain; charset=utf-8',
    byteLength: 2,
    sha256: mediaSha256,
    data: mediaData,
  } satisfies ResidentToGatewayFrame,
});
