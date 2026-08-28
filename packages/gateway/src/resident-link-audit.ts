import type { GatewayResidentLinkAudit, GatewayResidentLinkAuditEvent } from './resident-link-registry.js';
import type { GatewayAuditInput } from './store.js';

const FAILED_ACTIONS = new Set<GatewayResidentLinkAuditEvent['action']>([
  'protocol-error',
  'handshake-timeout',
  'backpressure',
  'transport-error',
]);

export interface GatewayResidentLinkAuditStore {
  appendAudit(input: GatewayAuditInput): unknown;
}

export function createGatewayResidentLinkAuditWriter(
  store: GatewayResidentLinkAuditStore,
): GatewayResidentLinkAudit {
  if (!store || typeof store.appendAudit !== 'function')
    throw new Error('resident link audit store is invalid');
  return (event) => {
    const detail: Record<string, unknown> = { linkAction: event.action };
    if (event.credentialId !== undefined)
      detail.credentialId = event.credentialId;
    if (event.connectionId !== undefined)
      detail.connectionId = event.connectionId;
    if (event.generation !== undefined) detail.generation = event.generation;
    if (event.protocolCode !== undefined)
      detail.protocolCode = event.protocolCode;
    store.appendAudit({
      actorKind: 'gateway',
      action: 'gateway.resident.link.' + event.action,
      targetKind: 'instance',
      targetId: event.instanceId ?? null,
      outcome: event.action.endsWith('-rejected')
        ? 'denied'
        : FAILED_ACTIONS.has(event.action)
          ? 'failed'
          : 'succeeded',
      detail,
    });
  };
}
