import type { GatewayInstanceSummary, GatewayState } from './api.js';

export type GatewaySelection =
  | Readonly<{ kind: 'all-instances' }>
  | Readonly<{ kind: 'resident'; instanceId: string }>;

export const ALL_INSTANCES_SELECTION: GatewaySelection = Object.freeze({
  kind: 'all-instances',
});

export type GatewayInstanceStatus = Readonly<{
  tone: 'active' | 'inactive' | 'revoked';
  label: 'Credential active' | 'Credential inactive' | 'Revoked';
}>;

export interface GatewayIdentityResident {
  readonly instanceId: string;
  readonly displayName: string;
  readonly status: GatewayInstanceStatus;
}

export interface GatewayIdentityState {
  readonly setupComplete: boolean;
  readonly publicUrl: string | null;
  readonly residents: readonly GatewayIdentityResident[];
}

/** Truthful enrollment status derived without inventing runtime availability. */
export function gatewayInstanceStatus(
  instance: Pick<GatewayInstanceSummary, 'revokedAt' | 'activeCredentialId'>,
): GatewayInstanceStatus {
  if (instance.revokedAt !== null)
    return Object.freeze({ tone: 'revoked', label: 'Revoked' });
  if (instance.activeCredentialId === null)
    return Object.freeze({ tone: 'inactive', label: 'Credential inactive' });
  return Object.freeze({ tone: 'active', label: 'Credential active' });
}

/**
 * The only selection reconciliation seam. A resident remains selected while
 * present in the verifier-free state, including after revocation; removed ids
 * return to the fleet overview.
 */
export function reconcileGatewaySelection(
  selection: GatewaySelection,
  instances: readonly Pick<GatewayInstanceSummary, 'id'>[],
): GatewaySelection {
  if (selection.kind === 'all-instances') return selection;
  return instances.some((instance) => instance.id === selection.instanceId)
    ? selection
    : ALL_INSTANCES_SELECTION;
}

/** Strip the API state down to fields that are safe and useful in the picker. */
export function gatewayIdentityState(
  state: GatewayState,
): GatewayIdentityState {
  return Object.freeze({
    setupComplete: state.setup.complete,
    publicUrl: state.setup.publicUrl,
    residents: Object.freeze(
      state.instances.map((instance) =>
        Object.freeze({
          instanceId: instance.id,
          displayName: instance.displayName,
          status: gatewayInstanceStatus(instance),
        }),
      ),
    ),
  });
}
