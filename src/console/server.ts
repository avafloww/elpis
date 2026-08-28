// console/server.ts — the HTTP + single-WebSocket transport for the console.
//
// Serves the static SPA (console/public/) over HTTP and upgrades ONE WebSocket
// endpoint at `/ws` for the entire app (design decision #1: one socket, not
// REST). Every connected socket is registered with the ConsoleHub, which sends
// it a snapshot and then streams incremental events; the socket also carries the
// client's backfill requests back to the hub.
//
// The server serves the observer console and delegates the opt-in `/mcp` route
// to a bounded Mind adapter. It never mutates agent state directly. Binding
// failures are logged and swallowed so the console cannot take down the agent.

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from '../config.js';
import type { ConsoleHub, HubClient } from './hub.js';
import type { McpHttpEndpoint } from '../mcp/server.js';
import { createConsoleMediaReader } from './media.js';

export { resolveAttachmentPath, resolveFramePath } from './media.js';

export interface ConsoleServer {
  start(): Promise<void>;
  stop(): void;
  readonly port: number;
}

const PUBLIC_DIR = path.join(
  url.fileURLToPath(new URL('.', import.meta.url)),
  'public',
);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

/** Wrap a ws.WebSocket as the minimal HubClient the hub talks to. */
function asHubClient(ws: WebSocket): HubClient {
  return {
    send(data: string) {
      ws.send(data);
    },
    get closed() {
      return ws.readyState !== ws.OPEN;
    },
  };
}

/**
 * True when a WebSocket upgrade's `Origin` header is either ABSENT (a
 * non-browser client — curl, a script, a test — which is the legitimate
 * operator path and sends no Origin at all) or names the console's own
 * origin (`127.0.0.1`/`localhost` on the configured port).
 *
 * Browser WebSocket connections are not subject to the same-origin policy and
 * send no preflight, so without this guard any web page the operator's
 * browser happens to visit could open `ws://127.0.0.1:<port>/ws` itself and
 * — through chat/Mind/moderation ops — mutate the private agent home. Binding to
 * loopback keeps the socket off the network; this guard keeps it off the
 * browser's ambient reach into that loopback. Exported for direct unit
 * testing without standing up a real server.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  port: number,
): boolean {
  if (!origin) return true;
  let parsed: url.URL;
  try {
    parsed = new url.URL(origin);
  } catch {
    return false;
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')
    return false;
  const originPort =
    parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return originPort === String(port);
}

export function createConsoleServer(
  config: Config,
  hub: ConsoleHub,
  mcp?: McpHttpEndpoint,
): ConsoleServer {
  const log = config.logger;
  const media = createConsoleMediaReader({
    dataDirectory: config.paths.dataDirectory,
    avatarPath: path.join(PUBLIC_DIR, 'elpis-icon-512.png'),
  });

  const server = http.createServer((req, res) => {
    // Static file server for the SPA. Only GET, only within PUBLIC_DIR.
    const rawPath = (req.url ?? '/').split('?')[0];
    let reqPath: string;
    try {
      reqPath = decodeURIComponent(rawPath);
    } catch {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    if (reqPath === '/mcp') {
      if (!config.console.mcpEnabled || !mcp) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      void mcp.handle(req, res);
      return;
    }
    if (
      rawPath.startsWith('/frames/') ||
      rawPath.startsWith('/attachments/') ||
      rawPath === '/identity/avatar'
    ) {
      void media.read(rawPath).then((result) => {
        if (!result.ok) {
          const unsafe = result.reason === 'invalid_route';
          res.writeHead(unsafe ? 403 : 404);
          res.end(unsafe ? 'forbidden' : 'not found');
          return;
        }
        res.writeHead(200, {
          'content-type': result.mediaType,
          'cache-control': 'private, max-age=3600',
        });
        res.end(result.bytes);
      });
      return;
    }
    let rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
    // Prevent path traversal.
    const resolved = path.join(PUBLIC_DIR, rel);
    // Trailing separator so a sibling dir named `public*` can't be served.
    if (
      resolved !== PUBLIC_DIR &&
      !resolved.startsWith(PUBLIC_DIR + path.sep)
    ) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(resolved, (err, data) => {
      if (err) {
        // SPA fallback: unknown non-file paths serve index.html.
        if (!path.extname(resolved)) {
          fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
            if (e2) {
              res.writeHead(404);
              res.end('not found');
              return;
            }
            res.writeHead(200, { 'content-type': CONTENT_TYPES['.html'] });
            res.end(html);
          });
          return;
        }
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      // no-cache: the SPA is tiny and redeploys often — the operator must always
      // get current assets after a build, never a stale bundle.
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
        'cache-control': 'no-cache, no-store, must-revalidate',
      });
      res.end(data);
    });
  });

  // One WebSocket endpoint for the whole app. verifyClient rejects a browser
  // page's drive-by connection attempt (an Origin that isn't the console's
  // own) while still accepting the legitimate operator paths: a same-machine
  // non-browser client (no Origin header) or the SPA itself.
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (
      info: { origin: string; secure: boolean; req: http.IncomingMessage },
      cb: (res: boolean, code?: number, message?: string) => void,
    ) => {
      if (isAllowedOrigin(info.origin, config.console.port)) {
        cb(true);
        return;
      }
      log.warn(
        `[console] rejected websocket upgrade — origin '${info.origin}' is not the console's own origin`,
      );
      cb(false, 403, 'Forbidden');
    },
  });
  wss.on('connection', (ws: WebSocket) => {
    const client = asHubClient(ws);
    void hub.addClient(client);
    log.debug('[console] client connected');
    ws.on('message', (raw) => {
      try {
        hub.handleClientMessage(client, raw.toString());
      } catch {
        /* ignore bad frame */
      }
    });
    ws.on('close', () => {
      hub.removeClient(client);
      log.debug('[console] client disconnected');
    });
    ws.on('error', () => {
      hub.removeClient(client);
    });
  });

  return {
    get port() {
      return config.console.port;
    },
    start(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.once('error', (e) => {
          log.warn(
            `[console] server failed to bind :${config.console.port} — ${e instanceof Error ? e.message : String(e)} (console disabled this run)`,
          );
          resolve();
        });
        server.listen(config.console.port, config.console.host, () => {
          log.info(
            `[console] listening on http://${config.console.host}:${config.console.port} (ws at /ws${config.console.mcpEnabled ? ', mcp at /mcp' : ''})`,
          );
          resolve();
        });
      });
    },
    stop(): void {
      try {
        wss.close();
      } catch {
        /* ignore */
      }
      void mcp?.close();
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
  };
}
