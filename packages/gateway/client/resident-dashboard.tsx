import { useMemo } from 'preact/hooks';
import { ConsoleDashboard } from '../../../src/console/client/dashboard.js';
import { useConsole } from '../../../src/console/client/use-console.js';
import { createGatewayConsoleTransport } from './console-transport.js';

export function GatewayResidentDashboard({
  instanceId,
}: {
  instanceId: string;
}) {
  const transport = useMemo(
    () => createGatewayConsoleTransport(instanceId),
    [instanceId],
  );
  const [state, actions] = useConsole(transport);
  return (
    <section
      class='gateway-resident-dashboard'
      aria-label='Selected resident dashboard'
    >
      <ConsoleDashboard
        state={state}
        actions={actions}
        mediaResolver={transport}
      />
    </section>
  );
}
