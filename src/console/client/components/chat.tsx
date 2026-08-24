import { useState } from 'preact/hooks';

export function ChatComposer({
  onSend,
  disabled = false,
  placeholder = 'Write a message…',
  contextLabel,
  mobile = false,
}: {
  onSend(value: string): boolean | void;
  disabled?: boolean;
  placeholder?: string;
  contextLabel?: string;
  mobile?: boolean;
}) {
  const [draft, setDraft] = useState('');
  return (
    <form
      class={`thread-composer ${mobile ? 'mobile-composer' : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        const value = draft.trim();
        if (!value || disabled) return;
        if (onSend(value) !== false) setDraft('');
      }}
    >
      <div>
        <textarea
          rows={1}
          value={draft}
          disabled={disabled}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={placeholder}
        />
        {contextLabel && !mobile ? <span>{contextLabel}</span> : null}
        <button disabled={!draft.trim() || disabled}>↑</button>
      </div>
    </form>
  );
}

export function ActivityStrip({
  label,
  detail,
  tone = 'thinking',
}: {
  label: string;
  detail?: string;
  tone?: 'thinking' | 'waiting' | 'compacting';
}) {
  return (
    <div class={`activity-row activity-${tone}`} role='status' title={detail}>
      <div class='message-avatar agent-avatar activity-avatar'>◆</div>
      <div class='activity-copy'>
        <span class='activity-dots' aria-hidden='true'>
          <i />
          <i />
          <i />
        </span>
        <strong>{label}</strong>
      </div>
    </div>
  );
}
