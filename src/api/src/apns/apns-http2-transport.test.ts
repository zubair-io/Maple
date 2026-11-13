import { afterEach, describe, expect, it } from 'bun:test';
import { once } from 'node:events';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { exportPKCS8, generateKeyPair } from 'jose';
import { ApnsSender } from './apns-sender.ts';
import { Http2ApnsTransport } from './apns-http2-transport.ts';

interface TestServer {
  origin: string;
  server: http2.Http2Server;
  sessions: http2.ServerHttp2Session[];
  requests: { path: string; headers: http2.IncomingHttpHeaders; body: string }[];
}

const openServers: http2.Http2Server[] = [];
const openTransports: Http2ApnsTransport[] = [];

async function startServer(
  respond: (stream: http2.ServerHttp2Stream, requestNumber: number) => void,
): Promise<TestServer> {
  const server = http2.createServer();
  const sessions: http2.ServerHttp2Session[] = [];
  const requests: TestServer['requests'] = [];
  server.on('session', (session) => sessions.push(session));
  server.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      requests.push({
        path: String(headers[':path']),
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      respond(stream, requests.length);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, server, sessions, requests };
}

function transport(): Http2ApnsTransport {
  const instance = new Http2ApnsTransport();
  openTransports.push(instance);
  return instance;
}

afterEach(() => {
  openTransports.splice(0).forEach((t) => t.close());
  openServers.splice(0).forEach((s) => s.close());
});

describe('Http2ApnsTransport', () => {
  it('POSTs the path, headers and body over HTTP/2 and returns status and body', async () => {
    const srv = await startServer((stream) => {
      stream.respond({ ':status': 410 });
      stream.end('{"reason":"Unregistered"}');
    });
    const result = await transport().post(
      `${srv.origin}/3/device/abc`,
      { 'apns-topic': 't', 'content-type': 'application/json' },
      '{}',
    );
    expect(result).toEqual({ status: 410, body: '{"reason":"Unregistered"}' });
    expect(srv.requests[0]!.path).toBe('/3/device/abc');
    expect(srv.requests[0]!.headers['apns-topic']).toBe('t');
    expect(srv.requests[0]!.body).toBe('{}');
  });

  it('multiplexes sequential sends over one long-lived session', async () => {
    const srv = await startServer((stream) => {
      stream.respond({ ':status': 200 });
      stream.end();
    });
    const t = transport();
    await t.post(`${srv.origin}/3/device/a`, {}, '{}');
    await t.post(`${srv.origin}/3/device/b`, {}, '{}');
    expect(srv.sessions).toHaveLength(1);
    expect(srv.requests).toHaveLength(2);
  });

  it('reconnects on a fresh session after the server sends GOAWAY', async () => {
    const srv = await startServer((stream, n) => {
      stream.respond({ ':status': 200 });
      stream.end();
      if (n === 1) stream.session?.goaway();
    });
    const t = transport();
    await t.post(`${srv.origin}/3/device/a`, {}, '{}');
    await Bun.sleep(50);
    const second = await t.post(`${srv.origin}/3/device/b`, {}, '{}');
    expect(second.status).toBe(200);
    expect(srv.sessions).toHaveLength(2);
  });

  it('reconnects after the server destroys the session', async () => {
    const srv = await startServer((stream) => {
      stream.respond({ ':status': 200 });
      stream.end();
    });
    const t = transport();
    await t.post(`${srv.origin}/3/device/a`, {}, '{}');
    srv.sessions[0]!.destroy();
    await Bun.sleep(50);
    const second = await t.post(`${srv.origin}/3/device/b`, {}, '{}');
    expect(second.status).toBe(200);
    expect(srv.sessions).toHaveLength(2);
  });

  it('rejects with a transport error when the host is unreachable', async () => {
    const srv = await startServer((stream) => {
      stream.respond({ ':status': 200 });
      stream.end();
    });
    const { origin } = srv;
    const t = transport();
    await t.post(`${origin}/3/device/a`, {}, '{}');
    srv.sessions.forEach((s) => s.destroy());
    srv.server.close();
    await Bun.sleep(50);
    await expect(t.post(`${origin}/3/device/b`, {}, '{}')).rejects.toThrow();
  });
});

describe('ApnsSender over a real HTTP/2 session', () => {
  it('prunes on 410 Unregistered and survives a GOAWAY between sends', async () => {
    const srv = await startServer((stream, n) => {
      stream.respond({ ':status': 410 });
      stream.end('{"reason":"Unregistered"}');
      if (n === 1) stream.session?.goaway();
    });
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const inner = transport();
    const sender = new ApnsSender(
      { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey) },
      {
        post: (url, headers, body) =>
          inner.post(url.replace(/^https:\/\/[^/]+/, srv.origin), headers, body),
        close: () => inner.close(),
      },
    );
    const first = await sender.sendFileProviderWake('gone', 'production');
    await Bun.sleep(50);
    const second = await sender.sendFileProviderWake('gone2', 'sandbox');
    for (const result of [first, second]) {
      expect(result).toEqual({ ok: false, status: 410, reason: 'Unregistered', shouldPrune: true });
    }
    expect(srv.sessions).toHaveLength(2);
  });
});
