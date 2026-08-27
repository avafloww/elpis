import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import {
  GatewayClientError,
  type GatewayClient,
  type GatewayEnrollmentGrant,
} from './api.js';
import {
  formatExpiryCountdown,
  formatTimestamp,
  gatewayErrorMessage,
} from './presentation.js';

export interface ClipboardWriter {
  writeText(value: string): Promise<void>;
}

export async function copyBootstrapOnRequest(
  value: string,
  clipboard: ClipboardWriter = navigator.clipboard,
): Promise<void> {
  await clipboard.writeText(value);
}

export interface BootstrapDownloadEnvironment {
  createObjectURL(value: Blob): string;
  revokeObjectURL(value: string): void;
  click(value: string, filename: string): void;
}

function browserDownloadEnvironment(): BootstrapDownloadEnvironment {
  return {
    createObjectURL: (value) => URL.createObjectURL(value),
    revokeObjectURL: (value) => URL.revokeObjectURL(value),
    click: (value, filename) => {
      const anchor = document.createElement('a');
      anchor.href = value;
      anchor.download = filename;
      anchor.click();
      anchor.remove();
    },
  };
}

export function downloadBootstrapOnRequest(
  value: string,
  environment: BootstrapDownloadEnvironment = browserDownloadEnvironment(),
): void {
  const blob = new Blob([value], { type: 'application/yaml;charset=utf-8' });
  const objectUrl = environment.createObjectURL(blob);
  try {
    environment.click(objectUrl, 'elpis-gateway-enrollment.yaml');
  } finally {
    environment.revokeObjectURL(objectUrl);
  }
}

type TransferStatus = 'idle' | 'pending' | 'success' | 'failure';
type HeldGrant = Readonly<{
  response: GatewayEnrollmentGrant;
  copyStatus: TransferStatus;
  downloadStatus: TransferStatus;
}>;

export type EnrollmentView =
  | Readonly<{ phase: 'idle' }>
  | Readonly<{ phase: 'generating' }>
  | (Readonly<{ phase: 'ready' }> & HeldGrant)
  | Readonly<{ phase: 'generate-failure'; message: string }>
  | (Readonly<{ phase: 'revoking' }> & HeldGrant)
  | (Readonly<{ phase: 'revoke-failure'; message: string }> & HeldGrant)
  | Readonly<{ phase: 'revoked'; replayed: boolean }>;

export type EnrollmentEvent =
  | Readonly<{ type: 'generate' }>
  | Readonly<{ type: 'generated'; response: GatewayEnrollmentGrant }>
  | Readonly<{ type: 'generate-failed'; message: string }>
  | Readonly<{ type: 'copy-pending' }>
  | Readonly<{ type: 'copy-finished'; successful: boolean }>
  | Readonly<{ type: 'download-pending' }>
  | Readonly<{ type: 'download-finished'; successful: boolean }>
  | Readonly<{ type: 'revoke' }>
  | Readonly<{ type: 'revoke-failed'; message: string }>
  | Readonly<{ type: 'revoked'; replayed: boolean }>
  | Readonly<{ type: 'close' }>;

type HeldEnrollmentView = Extract<EnrollmentView, HeldGrant>;

function held(view: EnrollmentView): view is HeldEnrollmentView {
  return (
    view.phase === 'ready' ||
    view.phase === 'revoking' ||
    view.phase === 'revoke-failure'
  );
}

/** Pure state boundary: secrets exist only in a mounted dialog reducer state. */
export function enrollmentReducer(
  view: EnrollmentView,
  event: EnrollmentEvent,
): EnrollmentView {
  switch (event.type) {
    case 'generate':
      return view.phase === 'idle' ? { phase: 'generating' } : view;
    case 'generated':
      return view.phase === 'generating'
        ? {
            phase: 'ready',
            response: event.response,
            copyStatus: 'idle',
            downloadStatus: 'idle',
          }
        : view;
    case 'generate-failed':
      return view.phase === 'generating'
        ? { phase: 'generate-failure', message: event.message }
        : view;
    case 'copy-pending':
      return held(view) &&
        view.phase !== 'revoking' &&
        view.copyStatus !== 'pending'
        ? { ...view, copyStatus: 'pending' }
        : view;
    case 'copy-finished':
      return held(view) &&
        view.phase !== 'revoking' &&
        view.copyStatus === 'pending'
        ? { ...view, copyStatus: event.successful ? 'success' : 'failure' }
        : view;
    case 'download-pending':
      return held(view) &&
        view.phase !== 'revoking' &&
        view.downloadStatus !== 'pending'
        ? { ...view, downloadStatus: 'pending' }
        : view;
    case 'download-finished':
      return held(view) &&
        view.phase !== 'revoking' &&
        view.downloadStatus === 'pending'
        ? { ...view, downloadStatus: event.successful ? 'success' : 'failure' }
        : view;
    case 'revoke':
      return held(view) && view.phase === 'ready'
        ? { ...view, phase: 'revoking' }
        : view;
    case 'revoke-failed':
      return held(view) && view.phase === 'revoking'
        ? { ...view, phase: 'revoke-failure', message: event.message }
        : view;
    case 'revoked':
      return view.phase === 'revoking'
        ? { phase: 'revoked', replayed: event.replayed }
        : view;
    case 'close':
      return view.phase === 'generating' ||
        view.phase === 'revoking' ||
        (held(view) && view.copyStatus === 'pending')
        ? view
        : { phase: 'idle' };
  }
}

export interface MutationGuard {
  begin(): boolean;
  finish(): void;
}

/** Synchronous admission prevents duplicate effects before a UI rerender. */
export function createMutationGuard(): MutationGuard {
  let pending = false;
  return {
    begin() {
      if (pending) return false;
      pending = true;
      return true;
    },
    finish() {
      pending = false;
    },
  };
}

interface AddInstanceDialogProps {
  client: GatewayClient;
  onClose(): void;
}

export function AddInstanceDialog({ client, onClose }: AddInstanceDialogProps) {
  const [view, dispatch] = useReducer(enrollmentReducer, { phase: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  const dialog = useRef<HTMLDivElement>(null);
  const generateGuard = useRef<MutationGuard | undefined>(undefined);
  const copyGuard = useRef<MutationGuard | undefined>(undefined);
  const revokeGuard = useRef<MutationGuard | undefined>(undefined);
  if (generateGuard.current === undefined)
    generateGuard.current = createMutationGuard();
  if (copyGuard.current === undefined)
    copyGuard.current = createMutationGuard();
  if (revokeGuard.current === undefined)
    revokeGuard.current = createMutationGuard();

  const pending =
    view.phase === 'generating' ||
    view.phase === 'revoking' ||
    (held(view) && view.copyStatus === 'pending');

  const close = (): void => {
    if (pending) return;
    dispatch({ type: 'close' });
    onClose();
  };

  useEffect(() => {
    dialog.current?.focus();
  }, []);

  useEffect(() => {
    if (!held(view)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [held(view) ? view.response.grant.expiresAt : null]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab' || dialog.current === null) return;
      const focusable = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), textarea:not(:disabled), input:not(:disabled)',
        ),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === dialog.current)) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last ||
          !(active instanceof Node) ||
          !dialog.current.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [pending, onClose]);

  const generate = (): void => {
    if (view.phase !== 'idle' || !generateGuard.current!.begin()) return;
    dispatch({ type: 'generate' });
    void client.createEnrollmentGrant().then(
      (response) => {
        generateGuard.current!.finish();
        dispatch({ type: 'generated', response });
      },
      (error: unknown) => {
        generateGuard.current!.finish();
        dispatch({
          type: 'generate-failed',
          message: gatewayErrorMessage(error),
        });
      },
    );
  };

  const copy = (): void => {
    if (
      !held(view) ||
      view.phase === 'revoking' ||
      view.copyStatus === 'pending' ||
      !copyGuard.current!.begin()
    )
      return;
    const value = view.response.bootstrapYaml;
    dispatch({ type: 'copy-pending' });
    void copyBootstrapOnRequest(value).then(
      () => {
        copyGuard.current!.finish();
        dispatch({ type: 'copy-finished', successful: true });
      },
      () => {
        copyGuard.current!.finish();
        dispatch({ type: 'copy-finished', successful: false });
      },
    );
  };

  const download = (): void => {
    if (
      !held(view) ||
      view.phase === 'revoking' ||
      view.downloadStatus === 'pending'
    )
      return;
    dispatch({ type: 'download-pending' });
    try {
      downloadBootstrapOnRequest(view.response.bootstrapYaml);
      dispatch({ type: 'download-finished', successful: true });
    } catch {
      dispatch({ type: 'download-finished', successful: false });
    }
  };

  const revoke = (): void => {
    if (view.phase !== 'ready' || !revokeGuard.current!.begin()) return;
    const id = view.response.grant.id;
    dispatch({ type: 'revoke' });
    void client.revokeEnrollmentGrant(id).then(
      (receipt) => {
        revokeGuard.current!.finish();
        if (receipt.grant.id !== id) {
          dispatch({
            type: 'revoke-failed',
            message: gatewayErrorMessage(
              new GatewayClientError(0, 'invalid_response'),
            ),
          });
          return;
        }
        dispatch({ type: 'revoked', replayed: receipt.grant.replayed });
      },
      (error: unknown) => {
        revokeGuard.current!.finish();
        dispatch({
          type: 'revoke-failed',
          message: gatewayErrorMessage(error),
        });
      },
    );
  };

  let content;
  if (view.phase === 'idle') {
    content = (
      <>
        <p class='dialog-copy'>
          Generate a short-lived, one-response enrollment file for a new Elpis
          instance. Nothing is generated by opening this dialog.
        </p>
        <button class='primary-button' type='button' onClick={generate}>
          Generate enrollment
        </button>
      </>
    );
  } else if (view.phase === 'generating') {
    content = (
      <div class='effect-state' aria-live='polite' aria-busy='true'>
        <span class='spinner' aria-hidden='true' />
        <p>Generating enrollment…</p>
      </div>
    );
  } else if (view.phase === 'generate-failure') {
    content = (
      <div class='effect-state' role='alert'>
        <p class='status-error'>{view.message}</p>
        <p class='muted'>No retry was attempted.</p>
      </div>
    );
  } else if (view.phase === 'revoked') {
    content = (
      <div class='receipt' role='status'>
        <span class='receipt-mark' aria-hidden='true'>
          ✓
        </span>
        <div>
          <h3>Enrollment grant revoked</h3>
          <p>
            The local enrollment file display was cleared. The server confirmed
            {view.replayed ? ' the grant was already revoked.' : ' revocation.'}
          </p>
        </div>
      </div>
    );
  } else {
    const expiry = view.response.grant.expiresAt;
    content = (
      <>
        <div class='expiry-row' role='status'>
          <span>{formatExpiryCountdown(expiry, now)}</span>
          <span>Expires {formatTimestamp(expiry)}</span>
        </div>
        <p class='one-time-warning'>
          This bootstrap YAML is shown once. Closing this dialog loses this
          local display but does not revoke the server grant.
        </p>
        <label class='field-label' for='bootstrap-output'>
          Bootstrap YAML
        </label>
        <textarea
          id='bootstrap-output'
          class='bootstrap-output'
          value={view.response.bootstrapYaml}
          readOnly
          spellcheck={false}
          rows={7}
        />
        <div class='transfer-actions'>
          <button
            type='button'
            onClick={copy}
            disabled={
              view.phase === 'revoking' || view.copyStatus === 'pending'
            }
          >
            {view.copyStatus === 'pending' ? 'Copying…' : 'Copy'}
          </button>
          <button
            type='button'
            onClick={download}
            disabled={
              view.phase === 'revoking' || view.downloadStatus === 'pending'
            }
          >
            {view.downloadStatus === 'pending' ? 'Preparing…' : 'Download YAML'}
          </button>
          <button
            class='danger-button'
            type='button'
            onClick={revoke}
            disabled={view.phase !== 'ready'}
          >
            {view.phase === 'revoking' ? 'Revoking…' : 'Revoke grant'}
          </button>
        </div>
        <div class='transfer-status' aria-live='polite'>
          {view.copyStatus === 'success' && <p>Copied to clipboard.</p>}
          {view.copyStatus === 'failure' && (
            <p class='status-error'>Clipboard copy failed.</p>
          )}
          {view.downloadStatus === 'success' && <p>Download started.</p>}
          {view.downloadStatus === 'failure' && (
            <p class='status-error'>Download could not be started.</p>
          )}
          {view.phase === 'revoke-failure' && (
            <>
              <p class='status-error' role='alert'>
                {view.message}
              </p>
              <p class='muted'>No retry was attempted.</p>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <div class='dialog-backdrop'>
      <div
        class='dialog-panel'
        role='dialog'
        aria-modal='true'
        aria-labelledby='add-instance-title'
        tabIndex={-1}
        ref={dialog}
      >
        <div class='dialog-header'>
          <div>
            <p class='eyebrow'>Fleet enrollment</p>
            <h2 id='add-instance-title'>Add instance</h2>
          </div>
          <button
            class='icon-button'
            type='button'
            onClick={close}
            disabled={pending}
            aria-label='Close Add Instance dialog'
          >
            <span aria-hidden='true'>×</span>
          </button>
        </div>
        <div class='dialog-body'>{content}</div>
      </div>
    </div>
  );
}
