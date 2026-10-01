import type { RunScope } from '../sandbox/globals.js';

export type ResidentSourceInspectionAction = () => string;
export type ResidentSourceAuthorizationAction = (candidateId: string) => string;
export type ResidentIdentitySystemDerivationAction = (
  authorizationId: string,
) => string;
export type ResidentWorldProfileBindingAction = (
  derivationId: string,
) => string;

const actions = new WeakMap<RunScope, ResidentSourceInspectionAction>();
const authorizationActions = new WeakMap<
  RunScope,
  ResidentSourceAuthorizationAction
>();
const derivationActions = new WeakMap<
  RunScope,
  ResidentIdentitySystemDerivationAction
>();
const worldProfileBindingActions = new WeakMap<
  RunScope,
  ResidentWorldProfileBindingAction
>();

export function bindResidentSourceInspectionAction(
  scope: RunScope,
  action: ResidentSourceInspectionAction,
): void {
  if (actions.has(scope))
    throw new Error('resident source inspection: run scope is already bound');
  actions.set(scope, action);
}

export function residentSourceInspectionActionForScope(
  scope: RunScope,
): ResidentSourceInspectionAction | undefined {
  return actions.get(scope);
}

export function bindResidentSourceAuthorizationAction(
  scope: RunScope,
  action: ResidentSourceAuthorizationAction,
): void {
  if (authorizationActions.has(scope)) {
    throw new Error('resident source authorization: run scope is already bound');
  }
  authorizationActions.set(scope, action);
}

export function residentSourceAuthorizationActionForScope(
  scope: RunScope,
): ResidentSourceAuthorizationAction | undefined {
  return authorizationActions.get(scope);
}

export function bindResidentIdentitySystemDerivationAction(
  scope: RunScope,
  action: ResidentIdentitySystemDerivationAction,
): void {
  if (derivationActions.has(scope)) {
    throw new Error('resident identity derivation: run scope is already bound');
  }
  derivationActions.set(scope, action);
}

export function residentIdentitySystemDerivationActionForScope(
  scope: RunScope,
): ResidentIdentitySystemDerivationAction | undefined {
  return derivationActions.get(scope);
}

export function bindResidentWorldProfileBindingAction(
  scope: RunScope,
  action: ResidentWorldProfileBindingAction,
): void {
  if (worldProfileBindingActions.has(scope)) {
    throw new Error('resident world profile binding: run scope is already bound');
  }
  worldProfileBindingActions.set(scope, action);
}

export function residentWorldProfileBindingActionForScope(
  scope: RunScope,
): ResidentWorldProfileBindingAction | undefined {
  return worldProfileBindingActions.get(scope);
}
