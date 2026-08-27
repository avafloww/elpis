import type { RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { shortenPublicId } from './presentation.js';
import type { GatewayIdentityState, GatewaySelection } from './selection.js';

export type GatewayIdentityView =
  | Readonly<{ phase: 'loading' }>
  | Readonly<{ phase: 'failure' }>
  | Readonly<{ phase: 'ready'; state: GatewayIdentityState }>;

interface GatewayIdentityDockProps {
  view: GatewayIdentityView;
  selection: GatewaySelection;
  open: boolean;
  dockRef: RefObject<HTMLButtonElement>;
  onOpen(): void;
  onClose(restoreFocus?: boolean): void;
  onSelect(selection: GatewaySelection): void;
  onAdd(): void;
}

function dockLabel(
  view: GatewayIdentityView,
  selection: GatewaySelection,
): string {
  if (view.phase !== 'ready') return 'Gateway status';
  if (!view.state.setupComplete) return 'Gateway Setup';
  if (selection.kind === 'resident') {
    const resident = view.state.residents.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    if (resident) return resident.displayName;
  }
  return 'All Instances';
}

interface GatewayIdentityPickerProps {
  view: GatewayIdentityView;
  selection: GatewaySelection;
  onClose(restoreFocus?: boolean): void;
  onSelect(selection: GatewaySelection): void;
  onAdd(): void;
}

function GatewayIdentityPicker({
  view,
  selection,
  onClose,
  onSelect,
  onAdd,
}: GatewayIdentityPickerProps) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);

  const keyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || panel.current === null) return;
    const focusable = Array.from(
      panel.current.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled)',
      ),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      panel.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last ||
        !(active instanceof Node) ||
        !panel.current.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  };

  const select = (next: GatewaySelection): void => {
    onSelect(next);
    onClose();
  };

  let browserState = 'Loading';
  let gatewayStatus = 'Reading state';
  let publicUrl = 'Not loaded';
  let instanceCount = 'Not loaded';
  if (view.phase === 'failure') {
    browserState = 'Unavailable';
    gatewayStatus = 'State unavailable';
  } else if (view.phase === 'ready') {
    browserState = 'Loaded';
    gatewayStatus = view.state.setupComplete ? 'Configured' : 'Setup required';
    publicUrl = view.state.publicUrl ?? 'Not configured';
    instanceCount = String(view.state.residents.length);
  }

  const configured = view.phase === 'ready' && view.state.setupComplete;
  const residents =
    configured && view.phase === 'ready' ? view.state.residents : [];

  return (
    <div
      class='identity-picker-layer'
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        id='gateway-identity-picker'
        class='identity-picker'
        role='dialog'
        aria-modal='true'
        aria-labelledby='identity-picker-title'
        tabIndex={-1}
        ref={panel}
        onKeyDown={keyDown}
      >
        <div class='identity-picker-header'>
          <div>
            <p class='eyebrow'>Elpis Gateway</p>
            <h2 id='identity-picker-title'>Choose a view</h2>
          </div>
          <button
            class='icon-button identity-close'
            type='button'
            aria-label='Close Gateway picker'
            onClick={() => onClose()}
          >
            ×
          </button>
        </div>

        <dl class='gateway-status-card' aria-label='Gateway status'>
          <div>
            <dt>Browser state</dt>
            <dd>{browserState}</dd>
          </div>
          <div>
            <dt>Gateway</dt>
            <dd>{gatewayStatus}</dd>
          </div>
          <div>
            <dt>Public URL</dt>
            <dd
              title={
                view.phase === 'ready'
                  ? (view.state.publicUrl ?? undefined)
                  : undefined
              }
            >
              {publicUrl}
            </dd>
          </div>
          <div>
            <dt>Instances</dt>
            <dd>{instanceCount}</dd>
          </div>
        </dl>

        <div class='identity-options' aria-label='Gateway views'>
          <button
            type='button'
            class='identity-option'
            aria-pressed={selection.kind === 'all-instances'}
            onClick={() => select({ kind: 'all-instances' })}
          >
            <span class='identity-option-mark' aria-hidden='true'>
              ◫
            </span>
            <span>
              <strong>All Instances</strong>
              <small>Gateway overview and enrolled fleet</small>
            </span>
            {selection.kind === 'all-instances' && (
              <span class='identity-check' aria-hidden='true'>
                ✓
              </span>
            )}
          </button>

          {residents.length > 0 && (
            <p class='identity-group-label'>Enrolled residents</p>
          )}
          {residents.map((resident) => {
            const selected =
              selection.kind === 'resident' &&
              selection.instanceId === resident.instanceId;
            return (
              <button
                type='button'
                class='identity-option resident-option'
                aria-pressed={selected}
                onClick={() =>
                  select({ kind: 'resident', instanceId: resident.instanceId })
                }
                key={resident.instanceId}
              >
                <span class='resident-avatar' aria-hidden='true'>
                  {resident.displayName.slice(0, 1).toUpperCase()}
                </span>
                <span class='identity-resident-copy'>
                  <strong>{resident.displayName}</strong>
                  <small>
                    <code title={resident.instanceId}>
                      {shortenPublicId(resident.instanceId)}
                    </code>
                    <span class={'identity-status ' + resident.status.tone}>
                      {resident.status.label}
                    </span>
                  </small>
                </span>
                {selected && (
                  <span class='identity-check' aria-hidden='true'>
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {configured && (
          <button
            class='identity-add-button'
            type='button'
            onClick={() => {
              onClose(false);
              onAdd();
            }}
          >
            <span aria-hidden='true'>＋</span>
            Add Instance
          </button>
        )}
      </div>
    </div>
  );
}

export function GatewayIdentityDock({
  view,
  selection,
  open,
  dockRef,
  onOpen,
  onClose,
  onSelect,
  onAdd,
}: GatewayIdentityDockProps) {
  const label = dockLabel(view, selection);
  return (
    <div class='gateway-identity-dock'>
      <button
        class='identity-dock-button'
        type='button'
        aria-label={'Open Gateway identity picker. Current view: ' + label}
        aria-haspopup='dialog'
        aria-expanded={open}
        aria-controls='gateway-identity-picker'
        onClick={() => (open ? onClose() : onOpen())}
        ref={dockRef}
      >
        <span class='dock-avatar' aria-hidden='true'>
          G
        </span>
        <span class='dock-copy'>
          <small>Gateway</small>
          <strong>{label}</strong>
        </span>
        <span class='dock-chevron' aria-hidden='true'>
          ⌃
        </span>
      </button>
      {open && (
        <GatewayIdentityPicker
          view={view}
          selection={selection}
          onClose={onClose}
          onSelect={onSelect}
          onAdd={onAdd}
        />
      )}
    </div>
  );
}
