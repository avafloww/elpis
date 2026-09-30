import type { ResidentRunScopeHandle } from './resident-run-provenance.js';
import type { RunScope } from '../sandbox/globals.js';

const handles = new WeakMap<RunScope, ResidentRunScopeHandle>();

export function bindResidentRunHandle(
  scope: RunScope,
  handle: ResidentRunScopeHandle,
): void {
  if (handles.has(scope))
    throw new Error('resident run provenance: run scope is already bound');
  handles.set(scope, handle);
}

export function residentRunHandleForScope(
  scope: RunScope,
): ResidentRunScopeHandle | undefined {
  return handles.get(scope);
}
