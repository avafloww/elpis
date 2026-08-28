import type {
  ConsoleTransport,
  ConsoleTransportListener,
} from './transport.js';
import type { JsonObject, ServerFrame } from './types.js';

/** Preserve the standalone Console's same-origin /ws connection and retry policy. */
export function createStandaloneConsoleTransport(): ConsoleTransport {
  let socket: WebSocket | null = null;
  let subscribed = false;

  return {
    send(frame: JsonObject): boolean {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      try {
        socket.send(JSON.stringify(frame));
        return true;
      } catch {
        return false;
      }
    },

    subscribe(listener: ConsoleTransportListener): () => void {
      if (subscribed)
        throw new Error('Console transport already has an active subscriber');
      subscribed = true;
      let disposed = false;
      let retry = 500;
      let retryTimer: number | null = null;

      const connect = (): void => {
        if (disposed) return;
        listener({
          type: 'connection',
          value: retry === 500 ? 'connecting' : 'reconnecting',
        });
        const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${protocol}://${location.host}/ws`);
        socket = ws;
        ws.onopen = () => {
          retry = 500;
          listener({ type: 'connection', value: 'connected' });
        };
        ws.onmessage = (event) => {
          let frame: ServerFrame;
          try {
            frame = JSON.parse(String(event.data)) as ServerFrame;
          } catch {
            listener({ type: 'malformed' });
            return;
          }
          listener({ type: 'frame', frame });
        };
        ws.onerror = () => ws.close();
        ws.onclose = () => {
          if (disposed) return;
          listener({ type: 'connection', value: 'reconnecting' });
          const delay = retry;
          retry = Math.min(8000, delay * 2);
          retryTimer = window.setTimeout(connect, delay);
        };
      };

      connect();
      return () => {
        disposed = true;
        subscribed = false;
        if (retryTimer !== null) window.clearTimeout(retryTimer);
        const current = socket;
        socket = null;
        current?.close();
      };
    },
  };
}
