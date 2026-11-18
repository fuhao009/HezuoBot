import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import { connect, type Socket } from 'node:net';

const FAILURE = 'Network request denied';
type Answer = { address: string; family: number };
export interface BrowserProxy { server: string; close(): Promise<void> }

/** No destinations, headers, bodies or raw exception text may cross this boundary. */
export interface BrowserNetworkDiagnostic {
  kind: 'local-failure' | 'upstream-response' | 'tunnel-error';
  phase: 'validation' | 'http' | 'connect';
  code?: string;
}

/** Internal trusted-host/test dependencies. Never expose these options to model/tool input. */
export interface BrowserNetworkInternalOptions {
  resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly Answer[]>;
  connect?: (address: string, port: number, family: number) => Socket;
  onDiagnostic?: (event: Readonly<BrowserNetworkDiagnostic>) => void;
}

/** Syntax/protocol validation only; resolution and reachability belong to the platform. */
export function validateBrowserUrl(value: string): URL {
  try {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f]/u.test(value)) throw new Error();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error();
    return url;
  } catch { throw new Error(FAILURE); }
}

/** Compatibility name: no public-address, DNS, port or query-parameter policy is applied. */
export async function validatePublicUrl(value: string): Promise<URL> { return validateBrowserUrl(value); }

/** Optional forwarding proxy for existing internal consumers; BrowserSession uses Chromium networking directly. */
export function createBrowserNetworkForInternalUse(options: BrowserNetworkInternalOptions = {}) {
  const resolve = options.resolve ?? (async (hostname: string) => lookup(hostname, { all: true }));
  const dial = options.connect ?? ((address, port, family) => connect({ host: address, port, family }));
  const report = (kind: BrowserNetworkDiagnostic['kind'], phase: BrowserNetworkDiagnostic['phase'], error?: unknown) => {
    let code: string | undefined;
    try {
      const candidate = (error as NodeJS.ErrnoException | undefined)?.code;
      if (typeof candidate === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(candidate)) code = candidate;
    } catch { /* Ignore untrusted diagnostic getters. */ }
    try { options.onDiagnostic?.(Object.freeze({ kind, phase, ...(code ? { code } : {}) })); }
    catch { /* Observers must not affect network behavior. */ }
  };

  async function start(): Promise<BrowserProxy> {
    const sockets = new Set<Socket>();
    const upstreams = new Set<http.ClientRequest>();
    const controller = new AbortController();
    let closing = false;
    let closePromise: Promise<void> | undefined;
    const fail = (response: http.ServerResponse, phase: 'validation' | 'http', error: unknown) => {
      report('local-failure', phase, error);
      if (response.headersSent) response.destroy();
      else { response.writeHead(502, { 'content-type': 'text/plain' }); response.end(FAILURE); }
    };
    const server = http.createServer((request, response) => {
      let url: URL;
      try {
        url = validateBrowserUrl(request.url ?? '');
        // HTTPS travels via CONNECT; sending TLS URLs as cleartext is not valid proxy framing.
        if (url.protocol !== 'http:') throw new Error(FAILURE);
      } catch (error) { fail(response, 'validation', error); return; }
      void (async () => {
        const host = url.hostname.replace(/^\[|\]$/g, '');
        const answers = await resolve(host, controller.signal);
        if (closing || !answers.length) throw new Error(FAILURE);
        const answer = answers[0];
        const agent = new http.Agent();
        agent.createConnection = () => dial(answer.address, Number(url.port || 80), answer.family);
        const upstream = http.request({
          hostname: host, port: url.port || 80, method: request.method,
          path: url.pathname + url.search,
          headers: { ...cleanHeaders(request.headers), host: url.host },
          agent,
        }, incoming => {
          report('upstream-response', 'http');
          response.writeHead(incoming.statusCode ?? 502, cleanHeaders(incoming.headers));
          incoming.on('error', () => response.destroy());
          incoming.pipe(response);
        });
        upstreams.add(upstream);
        upstream.once('close', () => { upstreams.delete(upstream); agent.destroy(); });
        upstream.on('error', error => fail(response, 'http', error));
        request.on('aborted', () => upstream.destroy());
        response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
        request.pipe(upstream);
      })().catch(error => fail(response, 'http', error));
    });
    // Disable Node's server-side policy deadlines; socket/protocol/OS limits still apply.
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.timeout = 0;
    server.keepAliveTimeout = 0;
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      if (closing) socket.destroy();
    });
    server.on('connect', (request, client, head) => {
      let established = false;
      let upstream: Socket | undefined;
      const failure = (error: unknown) => {
        report(established ? 'tunnel-error' : 'local-failure', 'connect', error);
        if (!established && !client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        else client.destroy();
        upstream?.destroy();
      };
      void (async () => {
        const authority = request.url ?? '';
        if (/[/?#@]/u.test(authority)) throw new Error(FAILURE);
        const url = validateBrowserUrl(`https://${authority}`);
        const answers = await resolve(url.hostname.replace(/^\[|\]$/g, ''), controller.signal);
        if (closing || client.destroyed || !answers.length) throw new Error(FAILURE);
        const answer = answers[0];
        upstream = dial(answer.address, Number(url.port || 443), answer.family);
        sockets.add(upstream);
        const socket = upstream;
        socket.once('close', () => { sockets.delete(socket); client.destroy(); });
        client.once('close', () => socket.destroy());
        socket.on('error', failure);
        socket.once('connect', () => {
          if (closing || client.destroyed) { socket.destroy(); return; }
          established = true;
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) socket.write(head);
          client.pipe(socket); socket.pipe(client);
        });
      })().catch(failure);
    });
    const listening = Promise.withResolvers<void>();
    server.once('error', listening.reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', listening.reject); listening.resolve(); });
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error(FAILURE);
    return {
      server: `http://127.0.0.1:${address.port}`,
      close() {
        if (!closePromise) {
          const closed = Promise.withResolvers<void>();
          closePromise = closed.promise;
          closing = true;
          controller.abort();
          server.close(() => closed.resolve());
          for (const request of upstreams) request.destroy();
          for (const socket of sockets) socket.destroy();
        }
        return closePromise;
      },
    };
  }
  return { validatePublicUrl, startBrowserProxy: start };
}

function cleanHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const blocked = new Set(['connection', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection',
    'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  for (const token of (headers.connection ?? '').split(',')) blocked.add(token.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())));
}

export async function startBrowserProxy(): Promise<BrowserProxy> { return createBrowserNetworkForInternalUse().startBrowserProxy(); }
