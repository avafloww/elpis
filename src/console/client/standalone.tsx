import { render } from 'preact';
import { ConsoleDashboard } from './main.js';
import { useConsole } from './use-console.js';
import { createStandaloneConsoleTransport } from './websocket-transport.js';

const transport = createStandaloneConsoleTransport();
const VIEW_KEY = 'elpis-view';
const LOG_RAIL_KEY = 'ep-logdock-h';
const preferences = {
  read: (): string | null => localStorage.getItem(VIEW_KEY),
  write: (view: string): void => localStorage.setItem(VIEW_KEY, view),
  readLogRailHeight: (): number | null => {
    const value = Number.parseInt(localStorage.getItem(LOG_RAIL_KEY) ?? '', 10);
    return Number.isFinite(value) ? value : null;
  },
  writeLogRailHeight: (value: number): void =>
    localStorage.setItem(LOG_RAIL_KEY, String(value)),
};

function StandaloneConsole() {
  const [state, actions] = useConsole(transport, preferences);
  return (
    <ConsoleDashboard
      state={state}
      actions={actions}
      preferences={preferences}
    />
  );
}

render(<StandaloneConsole />, document.getElementById('app')!);
