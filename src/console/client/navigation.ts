import type { MindOrigin } from './types.js';

export type MindBackTarget = MindOrigin | { view: 'mind' };

export function roomAfterSelection(current: string, selected: string): string {
  return current === selected && selected !== 'all' ? 'all' : selected;
}

export function mindBackTarget(origin: MindOrigin | null): MindBackTarget {
  return origin ?? { view: 'mind' };
}
