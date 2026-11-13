import { describe, expect, it } from 'bun:test';
import { isTransientNetworkError } from './r2-network-error.ts';

const dnsFailure = () =>
  Object.assign(new Error('getaddrinfo EAI_AGAIN abc.r2.cloudflarestorage.com'), {
    code: 'EAI_AGAIN',
  });
const timeout = () => new DOMException('The operation timed out.', 'TimeoutError');

describe('isTransientNetworkError', () => {
  it.each([
    ['DNS lookup failure', dnsFailure()],
    ['request timeout', timeout()],
    ['aborted request', new DOMException('aborted', 'AbortError')],
    [
      'refused connection',
      Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), {
        code: 'ConnectionRefused',
      }),
    ],
    ['dropped socket', new Error('The socket connection was closed unexpectedly.')],
    ['R2 server error', new Error('R2 head failed (503): unavailable')],
    ['R2 throttling', new Error('R2 head failed (429): slow down')],
    ['R2 upload server error', new Error('R2 upload failed (502): bad gateway')],
    ['R2 upload throttling', new Error('R2 upload failed (429): slow down')],
  ])('treats a %s as transient', (_name, err) => {
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it.each([
    ['rejected credentials', new Error('R2 head failed (403): SignatureDoesNotMatch')],
    ['bad request', new Error('R2 head failed (400): bad')],
    ['rejected upload', new Error('R2 upload failed (403): AccessDenied')],
    ['a programming error', new TypeError('x is not a function')],
    ['a non-error throw', 'EAI_AGAIN'],
  ])('does not treat %s as transient', (_name, err) => {
    expect(isTransientNetworkError(err)).toBe(false);
  });
});
