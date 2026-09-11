import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createCodexWebRtcMediaChildRuntime,
  type CodexWebRtcMediaChildLimits,
  type CodexWebRtcMediaPeer,
  type CodexWebRtcPeerCallbacks,
} from './codex-webrtc-media-child.js';
import { createDefaultCodexWeriftMediaPeer } from './codex-werift-peer.js';

type ProcessListener = (...args: unknown[]) => void;

type MediaProcess = {
  connected?: boolean;
  send?: (
    message: Record<string, unknown>,
    callback: (error: Error | null) => void,
  ) => boolean;
  on(event: string, listener: ProcessListener): unknown;
  removeListener(event: string, listener: ProcessListener): unknown;
  exit(code: number): void;
};

export type CodexWebRtcMediaProcessOptions = {
  process: MediaProcess;
  createPeer(callbacks: CodexWebRtcPeerCallbacks): CodexWebRtcMediaPeer;
  limits?: CodexWebRtcMediaChildLimits;
};

export const CODEX_WEBRTC_MEDIA_CHILD_LIMITS: CodexWebRtcMediaChildLimits =
  Object.freeze({
    maxIpcMessageBytes: 128 * 1024,
    maxCallIdBytes: 256,
    maxSdpBytes: 64 * 1024,
    maxAudioBytes: 5_760,
    maxInputAudioBytes: 960,
    maxEventBytes: 128 * 1024,
  });

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

export function startCodexWebRtcMediaProcess(
  options: CodexWebRtcMediaProcessOptions,
): void {
  const child = options.process;
  if (child.connected === false || typeof child.send !== 'function')
    throw new Error('Codex WebRTC media child requires connected fork IPC');

  let exited = false;
  const listeners: Array<[string, ProcessListener]> = [];
  const detach = (): void => {
    for (const [event, listener] of listeners.splice(0))
      child.removeListener(event, listener);
  };
  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    detach();
    child.exit(code);
  };
  let runtime;
  try {
    runtime = createCodexWebRtcMediaChildRuntime({
      createPeer: options.createPeer,
      limits: options.limits ?? CODEX_WEBRTC_MEDIA_CHILD_LIMITS,
      send: (message, callback) => {
        if (
          exited ||
          child.connected === false ||
          typeof child.send !== 'function'
        ) {
          callback(new Error('media IPC is disconnected'));
          return false;
        }
        try {
          return child.send(message, callback);
        } catch (error) {
          callback(asError(error, 'media IPC send failed'));
          return false;
        }
      },
      exit,
    });
  } catch {
    exit(1);
    return;
  }
  if (exited) return;
  const attach = (event: string, listener: ProcessListener): void => {
    if (exited) return;
    listeners.push([event, listener]);
    try {
      child.on(event, listener);
      if (exited) child.removeListener(event, listener);
    } catch (error) {
      try {
        child.removeListener(event, listener);
      } catch {
        // Termination below still fences the runtime if listener removal fails.
      }
      const index = listeners.findIndex(
        ([savedEvent, savedListener]) =>
          savedEvent === event && savedListener === listener,
      );
      if (index >= 0) listeners.splice(index, 1);
      throw error;
    }
  };
  const terminate = (value: unknown, fallback: string): void => {
    runtime.terminate(asError(value, fallback));
  };
  try {
    attach('message', (message) => runtime.receive(message));
    attach('disconnect', () =>
      terminate(undefined, 'parent media IPC disconnected'),
    );
    attach('SIGTERM', () =>
      terminate(undefined, 'media child received SIGTERM'),
    );
    attach('SIGINT', () => terminate(undefined, 'media child received SIGINT'));
    attach('uncaughtException', (error) =>
      terminate(error, 'uncaught media child failure'),
    );
    attach('unhandledRejection', (error) =>
      terminate(error, 'unhandled media child rejection'),
    );
  } catch (error) {
    terminate(error, 'media child listener attachment failed');
  }
}

const modulePath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === modulePath) {
  try {
    startCodexWebRtcMediaProcess({
      process: process as unknown as MediaProcess,
      createPeer: (callbacks) =>
        createDefaultCodexWeriftMediaPeer({
          maxInboundPcmBytes: 5_760,
          maxInboundTextBytes: 128 * 1024,
          maxBufferedAmount: 128 * 1024,
          ...callbacks,
        }),
    });
  } catch {
    process.exit(1);
  }
}
