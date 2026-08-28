import type { ConnectionState, JsonObject, ServerFrame } from './types.js';

export type ConsoleTransportEvent =
  | { type: 'connection'; value: ConnectionState }
  | { type: 'frame'; frame: ServerFrame }
  | { type: 'malformed' };

export type ConsoleTransportListener = (event: ConsoleTransportEvent) => void;

/** The complete transport authority exposed to the shared Console client. */
export interface ConsoleTransport {
  send(frame: JsonObject): boolean;
  subscribe(listener: ConsoleTransportListener): () => void;
}
