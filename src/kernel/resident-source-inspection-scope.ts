import type { RunScope } from '../sandbox/globals.js';

export type ResidentSourceInspectionAction = () => string;
export type ResidentSourceAuthorizationAction = (candidateId: string) => string;

const actions = new WeakMap<RunScope, ResidentSourceInspectionAction>();
const authorizationActions = new WeakMap<
  RunScope,
  ResidentSourceAuthorizationAction
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
