/**
 * Failures of the path to R2 (DNS, connect, timeout, R2-side 429/5xx) say
 * nothing about the object being read or written, so callers treat them as
 * "try again later" and never as a verdict on the asset.
 */

const TRANSIENT_CODES = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const TRANSIENT_MESSAGE =
  /operation timed out|EAI_AGAIN|fetch failed|unable to connect|socket connection was closed|connection (reset|refused|closed)|R2 (head|upload) failed \((429|5\d\d)\)/i;

/** True for failures of the path to R2 (DNS, connect, timeout, R2-side 429/5xx)
 * as opposed to an answer R2 gave about the request (bad credentials, 4xx). */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return (
    err.name === 'TimeoutError' ||
    err.name === 'AbortError' ||
    (typeof code === 'string' && TRANSIENT_CODES.has(code)) ||
    TRANSIENT_MESSAGE.test(err.message)
  );
}
