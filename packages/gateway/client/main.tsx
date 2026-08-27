import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { createGatewayClient, type GatewayState } from './api.js';
import './styles.css';

const MAX_ATTEMPTS = 3;
const client = createGatewayClient();

type View =
  | Readonly<{ phase: 'loading'; attempt: number }>
  | Readonly<{ phase: 'ready'; attempt: number; state: GatewayState }>
  | Readonly<{ phase: 'error'; attempt: number }>;

function GatewayApp() {
  const [view, setView] = useState<View>({ phase: 'loading', attempt: 1 });

  const load = (attempt: number): void => {
    setView({ phase: 'loading', attempt });
    void client.getState().then(
      (state) => setView({ phase: 'ready', attempt, state }),
      () => setView({ phase: 'error', attempt }),
    );
  };

  useEffect(() => {
    load(1);
  }, []);

  let content;
  if (view.phase === 'loading') {
    content = (
      <section class='status-card' aria-live='polite' aria-busy='true'>
        <p class='eyebrow'>Gateway status</p>
        <h2>Loading gateway state</h2>
        <p class='muted'>Checking this Gateway’s local configuration.</p>
      </section>
    );
  } else if (view.phase === 'ready') {
    const configured = view.state.setup.complete;
    content = (
      <section class='status-card' aria-live='polite'>
        <p class='eyebrow'>Foundation ready</p>
        <h2>{configured ? 'Gateway configured' : 'Setup required'}</h2>
        <p class='muted'>
          {configured
            ? 'The Gateway browser foundation is connected.'
            : 'Gateway setup has not been completed yet.'}
        </p>
      </section>
    );
  } else {
    const canRetry = view.attempt < MAX_ATTEMPTS;
    content = (
      <section class='status-card' role='alert'>
        <p class='eyebrow'>Gateway status</p>
        <h2>State unavailable</h2>
        <p class='muted'>The Gateway state could not be loaded.</p>
        {canRetry ? (
          <button type='button' onClick={() => load(view.attempt + 1)}>
            Retry
          </button>
        ) : (
          <p class='retry-limit'>Retry limit reached. Refresh to try again.</p>
        )}
      </section>
    );
  }

  return (
    <main class='gateway-shell'>
      <header class='gateway-header'>
        <span class='brand-mark' aria-hidden='true' />
        <div>
          <p class='eyebrow'>Elpis</p>
          <h1>Gateway</h1>
        </div>
      </header>
      {content}
    </main>
  );
}

const root = document.querySelector('#app');
if (!(root instanceof HTMLElement))
  throw new Error('Gateway app root is missing');
render(<GatewayApp />, root);
