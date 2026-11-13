import http2 from 'node:http2';
import type { ApnsTransport, ApnsTransportResponse } from './apns-sender.ts';

const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;

export class Http2ApnsTransport implements ApnsTransport {
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();

  post(url: string, headers: Record<string, string>, body: string): Promise<ApnsTransportResponse> {
    const { origin, pathname } = new URL(url);
    return this.postOnce(origin, pathname, headers, body).catch((error: unknown) =>
      isStaleSessionError(error)
        ? this.postOnce(origin, pathname, headers, body)
        : Promise.reject(error),
    );
  }

  close(): void {
    this.sessions.forEach((session) => session.destroy());
    this.sessions.clear();
  }

  private sessionFor(origin: string): http2.ClientHttp2Session {
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(origin);
    const drop = () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.on('goaway', drop);
    session.on('close', drop);
    session.on('error', drop);
    const connectTimer = setTimeout(() => session.destroy(), CONNECT_TIMEOUT_MS).unref();
    session.once('connect', () => clearTimeout(connectTimer));
    session.once('close', () => clearTimeout(connectTimer));
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }

  private postOnce(
    origin: string,
    path: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<ApnsTransportResponse> {
    return new Promise((resolve, reject) => {
      const session = this.sessionFor(origin);
      const request = session.request({ ':method': 'POST', ':path': path, ...headers });
      const statusRef = { value: 0 };
      const chunks: Buffer[] = [];
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.close(http2.constants.NGHTTP2_CANCEL));
      request.on('response', (responseHeaders) => {
        statusRef.value = Number(responseHeaders[':status']);
      });
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () =>
        resolve({ status: statusRef.value, body: Buffer.concat(chunks).toString('utf8') }),
      );
      request.on('error', reject);
      request.on('close', () => {
        if (request.rstCode !== http2.constants.NGHTTP2_NO_ERROR) {
          reject(new Error(`APNs stream closed with code ${request.rstCode}`));
        }
      });
      request.end(body);
    });
  }
}

const STALE_SESSION_CODES = new Set([
  'ERR_HTTP2_GOAWAY_SESSION',
  'ERR_HTTP2_INVALID_SESSION',
  'ERR_HTTP2_STREAM_CANCEL',
]);

function isStaleSessionError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code !== undefined && STALE_SESSION_CODES.has(code);
}
