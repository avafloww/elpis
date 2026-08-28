import { render } from 'preact';
import { ConsoleDashboard } from './main.js';
import { useConsole } from './use-console.js';
import { createStandaloneConsoleTransport } from './websocket-transport.js';

const transport = createStandaloneConsoleTransport();

function StandaloneConsole() {
  const [state, actions] = useConsole(transport);
  return <ConsoleDashboard state={state} actions={actions} />;
}

render(<StandaloneConsole />, document.getElementById('app')!);
