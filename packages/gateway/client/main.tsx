import { render, type RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  createGatewayClient,
  type GatewayClient,
  type GatewayState,
} from './api.js';
import { AddInstanceDialog } from './enrollment-modal.js';
import {
  GatewayIdentityDock,
  type GatewayIdentityView,
} from './identity-dock.js';
import {
  formatTimestamp,
  gatewayErrorMessage,
  setupDefaultOrigin,
  shortenPublicId,
} from './presentation.js';
import { GatewayResidentDashboard } from './resident-dashboard.js';
import {
  ALL_INSTANCES_SELECTION,
  gatewayIdentityState,
  gatewayInstanceStatus,
  reconcileGatewaySelection,
  type GatewaySelection,
} from './selection.js';
import './styles.css';

const client = createGatewayClient();

type LoadView =
  | Readonly<{ phase: 'loading' }>
  | Readonly<{ phase: 'ready'; state: GatewayState }>
  | Readonly<{ phase: 'failure'; message: string }>;

type SetupEffect =
  | Readonly<{ phase: 'idle' }>
  | Readonly<{ phase: 'pending' }>
  | Readonly<{ phase: 'failure'; message: string }>;

interface SetupCardProps {
  gatewayClient: GatewayClient;
  onComplete(state: GatewayState): void;
}

export function SetupCard({ gatewayClient, onComplete }: SetupCardProps) {
  const [publicUrl, setPublicUrl] = useState(() =>
    setupDefaultOrigin(window.location.origin),
  );
  const [effect, setEffect] = useState<SetupEffect>({ phase: 'idle' });
  const pending = useRef(false);

  const submit = (event: Event): void => {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setEffect({ phase: 'pending' });
    void gatewayClient.setup(publicUrl).then(
      (state) => {
        pending.current = false;
        onComplete(state);
      },
      (error: unknown) => {
        pending.current = false;
        setEffect({ phase: 'failure', message: gatewayErrorMessage(error) });
      },
    );
  };

  return (
    <section class='setup-card panel-card' aria-labelledby='setup-title'>
      <p class='eyebrow'>Gateway setup</p>
      <h2 id='setup-title'>Set the public URL</h2>
      <p class='lead'>
        Enter the exact HTTPS origin instances will use to reach this Gateway.
        Setup is explicit and must be authorized from that browser origin.
      </p>
      <form onSubmit={submit} autocomplete='off' class='setup-form'>
        <label class='field-label' for='public-url'>
          Public URL
        </label>
        <input
          id='public-url'
          name='public-url'
          type='url'
          required
          value={publicUrl}
          onInput={(event) => setPublicUrl(event.currentTarget.value)}
          autocomplete='off'
          spellcheck={false}
          inputMode='url'
          aria-describedby='public-url-help'
          disabled={effect.phase === 'pending'}
        />
        <p id='public-url-help' class='field-help'>
          Use a canonical origin such as https://gateway.example with no path,
          query, fragment, or trailing slash.
        </p>
        {effect.phase === 'failure' && (
          <p class='status-error form-status' role='alert'>
            {effect.message}
          </p>
        )}
        <button
          class='primary-button'
          type='submit'
          disabled={effect.phase === 'pending'}
        >
          {effect.phase === 'pending' ? 'Saving setup…' : 'Complete setup'}
        </button>
      </form>
    </section>
  );
}

interface FleetProps {
  state: GatewayState;
  onAdd(): void;
  addButtonRef: RefObject<HTMLButtonElement>;
}

function Fleet({ state, onAdd, addButtonRef }: FleetProps) {
  return (
    <>
      <section class='overview-grid' aria-label='Gateway overview'>
        <div class='overview-copy'>
          <p class='eyebrow'>Gateway overview</p>
          <h2>Fleet enrollment</h2>
          <p class='lead'>Manage instance enrollment from this Gateway.</p>
        </div>
        <dl class='overview-facts'>
          <div>
            <dt>Public URL</dt>
            <dd>{state.setup.publicUrl}</dd>
          </div>
          <div>
            <dt>Instances</dt>
            <dd>{state.instances.length}</dd>
          </div>
        </dl>
      </section>

      <section class='fleet-section' aria-labelledby='fleet-title'>
        <div class='section-header'>
          <div>
            <p class='eyebrow'>Configured fleet</p>
            <h2 id='fleet-title'>Instances</h2>
          </div>
          <button
            class='primary-button add-button'
            type='button'
            onClick={onAdd}
            ref={addButtonRef}
          >
            Add instance
          </button>
        </div>
        {state.instances.length === 0 ? (
          <div class='empty-state'>
            <h3>No instances enrolled</h3>
            <p>
              Generate a one-time bootstrap file to enroll the first instance.
            </p>
          </div>
        ) : (
          <ul class='instance-list'>
            {state.instances.map((instance) => {
              const credentialStatus = gatewayInstanceStatus(instance);
              return (
                <li class='instance-card' key={instance.id}>
                  <div class='instance-heading'>
                    <div>
                      <h3>{instance.displayName}</h3>
                      <code title={instance.id}>
                        {shortenPublicId(instance.id)}
                      </code>
                    </div>
                    <span class={'status-badge ' + credentialStatus.tone}>
                      <span aria-hidden='true' />
                      {credentialStatus.label}
                    </span>
                  </div>
                  <dl class='instance-facts'>
                    <div>
                      <dt>Enrolled</dt>
                      <dd>{formatTimestamp(instance.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>Last used</dt>
                      <dd>
                        {instance.activeCredentialId === null
                          ? 'No active credential'
                          : instance.lastUsedAt === null
                            ? 'Never'
                            : formatTimestamp(instance.lastUsedAt)}
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

export function GatewayApp({
  gatewayClient = client,
}: {
  gatewayClient?: GatewayClient;
}) {
  const [view, setView] = useState<LoadView>({ phase: 'loading' });
  const [selection, setSelection] = useState<GatewaySelection>(
    ALL_INSTANCES_SELECTION,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const dockButton = useRef<HTMLButtonElement | null>(null);
  const dialogReturnTarget = useRef<'dock' | 'fleet'>('fleet');
  const loadPending = useRef(false);

  const replaceState = (state: GatewayState): void => {
    setSelection((current) =>
      state.setup.complete
        ? reconcileGatewaySelection(current, state.instances)
        : ALL_INSTANCES_SELECTION,
    );
    setView({ phase: 'ready', state });
  };

  const load = (): void => {
    if (loadPending.current) return;
    loadPending.current = true;
    setView({ phase: 'loading' });
    void gatewayClient.getState().then(
      (state) => {
        loadPending.current = false;
        replaceState(state);
      },
      (error: unknown) => {
        loadPending.current = false;
        setView({ phase: 'failure', message: gatewayErrorMessage(error) });
      },
    );
  };

  useEffect(() => {
    load();
  }, []);

  const openDialog = (source: 'dock' | 'fleet'): void => {
    if (view.phase !== 'ready' || !view.state.setup.complete) return;
    setPickerOpen(false);
    dialogReturnTarget.current = source;
    setDialogOpen(true);
  };

  const closeDialog = (): void => {
    setDialogOpen(false);
    const target = dialogReturnTarget.current;
    window.setTimeout(() => {
      if (target === 'dock') dockButton.current?.focus();
      else addButton.current?.focus();
    }, 0);
  };

  const closePicker = (restoreFocus = true): void => {
    setPickerOpen(false);
    if (restoreFocus) window.setTimeout(() => dockButton.current?.focus(), 0);
  };

  let content;
  let residentMode = false;
  if (view.phase === 'loading') {
    content = (
      <section
        class='panel-card loading-card'
        aria-live='polite'
        aria-busy='true'
      >
        <span class='spinner' aria-hidden='true' />
        <div>
          <p class='eyebrow'>Gateway status</p>
          <h2>Loading Gateway state</h2>
          <p class='muted'>Reading the verifier-free fleet summary.</p>
        </div>
      </section>
    );
  } else if (view.phase === 'failure') {
    content = (
      <section class='panel-card error-card' role='alert'>
        <p class='eyebrow'>Gateway status</p>
        <h2>State unavailable</h2>
        <p class='status-error'>{view.message}</p>
        <button type='button' onClick={load}>
          Refresh
        </button>
      </section>
    );
  } else if (!view.state.setup.complete) {
    content = (
      <SetupCard gatewayClient={gatewayClient} onComplete={replaceState} />
    );
  } else {
    const resident =
      selection.kind === 'resident'
        ? view.state.instances.find(
            (instance) => instance.id === selection.instanceId,
          )
        : undefined;
    if (resident) {
      residentMode = true;
      content = (
        <GatewayResidentDashboard key={resident.id} instanceId={resident.id} />
      );
    } else {
      content = (
        <Fleet
          state={view.state}
          onAdd={() => openDialog('fleet')}
          addButtonRef={addButton}
        />
      );
    }
  }

  const identityView: GatewayIdentityView =
    view.phase === 'ready'
      ? { phase: 'ready', state: gatewayIdentityState(view.state) }
      : { phase: view.phase };

  return (
    <main
      class={`gateway-shell${residentMode ? ' gateway-shell-resident' : ''}`}
    >
      <header class='gateway-header'>
        <div class='brand-lockup'>
          <span class='brand-mark' aria-hidden='true' />
          <div>
            <p class='eyebrow'>Elpis</p>
            <h1>Gateway</h1>
          </div>
        </div>
        <GatewayIdentityDock
          view={identityView}
          selection={selection}
          open={pickerOpen}
          dockRef={dockButton}
          onOpen={() => {
            if (!dialogOpen) setPickerOpen(true);
          }}
          onClose={closePicker}
          onSelect={setSelection}
          onAdd={() => openDialog('dock')}
        />
        {view.phase === 'ready' && view.state.setup.complete && (
          <button
            class='quiet-button refresh-button'
            type='button'
            onClick={load}
          >
            Refresh
          </button>
        )}
      </header>
      {content}
      {dialogOpen && (
        <AddInstanceDialog client={gatewayClient} onClose={closeDialog} />
      )}
    </main>
  );
}

const root = document.querySelector('#app');
if (!(root instanceof HTMLElement))
  throw new Error('Gateway app root is missing');
render(<GatewayApp />, root);
