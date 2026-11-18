import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { connect, type Socket } from 'node:net';
import { createBrowserNetworkForInternalUse, validateBrowserUrl, validatePublicUrl, type BrowserNetworkDiagnostic } from '../src/browser-network.ts';

const accepted = [
  'http://localhost:1234/', 'http://intranet/', 'http://127.0.0.1:8080/',
  'http://10.0.0.1/', 'http://169.254.169.254/latest/', 'http://[::1]:9090/',
  'https://[fc00::1]/', 'http://service.internal/', 'http://host.local/',
  'http://192.0.2.1/', 'http://[2001:db8::1]/', 'https://user:pass@example.test:8443/?token=abc#secret=x',
  'https://example.com/?password=x&session=y&code=z',
];
test('HTTP(S) validation accepts local/private/reserved hosts, ports and credential parameters without resolving DNS', async () => {
  const network = createBrowserNetworkForInternalUse({ resolve: async () => { throw new Error('validation must not resolve'); } });
  for (const value of accepted) {
    assert.equal(validateBrowserUrl(value).href, new URL(value).href);
    assert.equal((await validatePublicUrl(value)).href, new URL(value).href);
    assert.equal((await network.validatePublicUrl(value)).href, new URL(value).href);
  }
});

test('basic URL syntax and protocol checks remain', async () => {
  for (const value of ['', 'not a url', 'https://', 'http://[::1', 'http://host:65536/', 'http://host:abc/',
    'http://host/has space', 'http://host/\n', 'http://host\\path', 'file:///etc/passwd', 'javascript:alert(1)',
    'data:text/html,test', 'ftp://host/', 'ws://host/']) {
    assert.throws(() => validateBrowserUrl(value), /Network request denied/);
    await assert.rejects(validatePublicUrl(value), /Network request denied/);
  }
});

async function listen(server: http.Server): Promise<number> {
  const ready = Promise.withResolvers<void>();
  server.once('error', ready.reject);
  server.listen(0, '127.0.0.1', ready.resolve);
  await ready.promise;
  const address = server.address();
  assert(address && typeof address === 'object');
  return address.port;
}
async function close(server: http.Server): Promise<void> {
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  server.closeAllConnections();
  await closed.promise;
}
async function request(proxy: string, target: string, body = ''): Promise<{ status: number; body: string; location?: string }> {
  const result = Promise.withResolvers<{ status: number; body: string; location?: string }>();
  const req = http.request(proxy, { method: body ? 'POST' : 'GET', path: target, agent: false }, response => {
    let data = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { data += chunk; });
    response.on('error', result.reject);
    response.on('end', () => result.resolve({ status: response.statusCode!, body: data, location: response.headers.location }));
  });
  req.on('error', result.reject);
  req.end(body);
  return result.promise;
}

test('compatibility proxy forwards private DNS answers, nonstandard ports, redirects and bodies beyond former 1MB cap', async () => {
  let received = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/large?token=allowed' }); res.end(); return; }
    for await (const chunk of req) received += chunk.length;
    res.end('forwarded');
  });
  const port = await listen(upstream);
  const dials: { address: string; port: number }[] = [];
  const network = createBrowserNetworkForInternalUse({
    resolve: async () => [{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.1', family: 4 }],
    connect: (address, port, family) => { dials.push({ address, port }); return connect({ host: address, port, family }); },
  });
  const proxy = await network.startBrowserProxy();
  try {
    const redirect = await request(proxy.server, `http://service.internal:${port}/redirect`);
    assert.equal(redirect.status, 302);
    const body = 'x'.repeat(1024 * 1024 + 1);
    const forwarded = await request(proxy.server, `http://service.internal:${port}${redirect.location}`, body);
    assert.equal(forwarded.status, 200);
    assert.equal(forwarded.body, 'forwarded');
    assert.equal(received, body.length);
    assert.deepEqual(dials, [{ address: '127.0.0.1', port }, { address: '127.0.0.1', port }]);
  } finally { await proxy.close(); await close(upstream); }
});

test('upstream HTTP errors pass through while local failures expose only safe diagnostics', async () => {
  const events: Readonly<BrowserNetworkDiagnostic>[] = [];
  const upstream = http.createServer((_req, res) => { res.writeHead(502); res.end('upstream response'); });
  const port = await listen(upstream);
  const proxy = await createBrowserNetworkForInternalUse({ onDiagnostic: event => events.push(event) }).startBrowserProxy();
  try {
    assert.equal((await request(proxy.server, `http://127.0.0.1:${port}/`)).body, 'upstream response');
    assert(events.some(event => event.kind === 'upstream-response'));
    assert.equal((await request(proxy.server, 'file:///private/SECRET')).status, 502);
    assert(!JSON.stringify(events).includes('SECRET'));
  } finally { await proxy.close(); await close(upstream); }
  const failed = await createBrowserNetworkForInternalUse({
    resolve: async () => { throw Object.assign(new Error('SECRET_DESTINATION'), { code: 'EAI_AGAIN' }); },
    onDiagnostic: event => { events.push(event); throw new Error('observer'); },
  }).startBrowserProxy();
  try {
    const result = await request(failed.server, 'http://internal/');
    assert.equal(result.status, 502);
    assert.equal(result.body, 'Network request denied');
    assert(events.some(event => event.code === 'EAI_AGAIN'));
    assert(!JSON.stringify(events).includes('SECRET'));
  } finally { await failed.close(); }
});

test('CONNECT permits local destinations on arbitrary ports and close destroys idle tunnels', async () => {
  const upstream = http.createServer();
  const port = await listen(upstream);
  const proxy = await createBrowserNetworkForInternalUse().startBrowserProxy();
  let socket: Socket | undefined;
  try {
    const connected = Promise.withResolvers<Socket>();
    const req = http.request(proxy.server, { method: 'CONNECT', path: `127.0.0.1:${port}`, agent: false });
    req.on('connect', (response, tunnel) => {
      if (response.statusCode !== 200) { tunnel.destroy(); connected.reject(new Error('CONNECT failed')); }
      else connected.resolve(tunnel);
    });
    req.on('error', connected.reject); req.end();
    socket = await connected.promise;
    const closed = Promise.withResolvers<void>();
    socket.once('close', () => closed.resolve());
    socket.resume();
    await Promise.all([proxy.close(), proxy.close()]);
    await closed.promise;
    assert(socket.destroyed);
  } finally { socket?.destroy(); await proxy.close(); await close(upstream); }
});
