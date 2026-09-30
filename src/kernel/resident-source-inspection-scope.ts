import type { RunScope } from '../sandbox/globals.js';

export type ResidentSourceInspectionAction = () => string;

const actions = new WeakMap<RunScope, ResidentSourceInspectionAction>();

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
