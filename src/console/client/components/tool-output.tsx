import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

export function CopyButton({
  value,
  label = 'Copy',
}: {
  value: string;
  label?: string;
}) {
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type='button'
      class='tool-copy'
      aria-label={label}
      onClick={async () => {
        clearTimeout(timer.current);
        try {
          await navigator.clipboard.writeText(value);
          setStatus('Copied');
        } catch {
          setStatus('Copy failed');
        }
        timer.current = setTimeout(() => setStatus(''), 2000);
      }}
    >
      <span aria-live='polite'>{status || label}</span>
    </button>
  );
}

/** Output remains text, including HTML and resident speech headers. */
export function ToolOutput({
  label,
  value,
  meta,
  warning,
  children,
}: {
  label: string;
  value: string;
  meta?: string;
  warning?: string;
  children?: ComponentChildren;
}) {
  const [wrap, setWrap] = useState(true);
  return (
    <section class='tool-output'>
      <header>
        <strong>{label}</strong>
        <span>
          {meta ??
            `${value.split('\n').length.toLocaleString()} ${value.includes('\n') ? 'lines' : 'line'}`}
        </span>
        <div class='surface-spacer' />
        <button
          type='button'
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          Wrap
        </button>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </header>
      {warning ? <p class='tool-output-warning'>{warning}</p> : null}
      <pre
        class={wrap ? 'tool-output-wrap' : ''}
        tabIndex={0}
        aria-label={label}
      >
        {children ?? value}
      </pre>
    </section>
  );
}
