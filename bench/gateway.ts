import * as readline from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CompleteResult } from '../src/llm/llm.js';

export type GatewayRequest =
  | { type: 'complete'; id: string; messages: unknown[] }
  | { type: 'summarize'; id: string; text: string }
  | { type: 'reset-session'; id: string }
  | { type: 'advance-clock'; id: string; ms: number }
  | { type: 'episode-result'; id: string; result: unknown }
  | { type: 'episode-restart'; id: string }
  | { type: 'episode-error'; id: string; error: string };
export type GatewayResponse = { type: 'response'; id: string; ok: true; value?: unknown } | { type: 'response'; id: string; ok: false; error: string };

export interface CompletionGateway {
  complete(messages: unknown[]): Promise<CompleteResult>;
  summarize(text: string): Promise<string>;
  resetSession(): Promise<void>;
  advanceClock(ms: number): Promise<void>;
}

export function writeJsonLine(stream: NodeJS.WritableStream, value: unknown): void { stream.write(JSON.stringify(value) + '\n'); }

/** Serve container-originated completion/clock requests. Credentials and model
 * clients stay in this host process; only messages for the current episode
 * cross the pipe. */
export function serveGateway(child: ChildProcessWithoutNullStreams, gateway: CompletionGateway): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout });
    const respond = (response: GatewayResponse) => writeJsonLine(child.stdin, response);
    rl.on('line', async (line) => {
      let request: GatewayRequest;
      try { request = JSON.parse(line) as GatewayRequest; } catch { return; }
      if (request.type === 'episode-result') { resolve(request.result); return; }
      if (request.type === 'episode-restart') { resolve({ restart: true }); return; }
      if (request.type === 'episode-error') { reject(new Error(request.error)); return; }
      try {
        let value: unknown;
        if (request.type === 'complete') value = await gateway.complete(request.messages);
        else if (request.type === 'summarize') value = await gateway.summarize(request.text);
        else if (request.type === 'reset-session') value = await gateway.resetSession();
        else if (request.type === 'advance-clock') value = await gateway.advanceClock(request.ms);
        respond({ type: 'response', id: request.id, ok: true, value });
      } catch (error) {
        respond({ type: 'response', id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[container] ${chunk}`));
    child.once('error', reject);
    child.once('exit', (code) => { if (code !== 0) reject(new Error(`ElpisBench container exited with code ${code}`)); });
  });
}
