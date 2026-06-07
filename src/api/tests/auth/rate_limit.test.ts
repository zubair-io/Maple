/**
 * Auth rate limiter (#862): bounded store + trusted-proxy client keying.
 * Pure functions — no Mongo.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { rateLimit, clientIp, __resetRateLimitForTests } from '../../src/auth/rate_limit.ts';

beforeEach(() => __resetRateLimitForTests());

const req = (headers: Record<string, string>): Request =>
  new Request('http://localhost/', { headers });

describe('rate limiter (#862)', () => {
  it('enforces the limit within the window', () => {
    for (let i = 0; i < 5; i++) expect(rateLimit('k', 5, 60_000)).toBe(true);
    expect(rateLimit('k', 5, 60_000)).toBe(false);
  });

  it('keeps distinct keys independent', () => {
    expect(rateLimit('a', 1, 60_000)).toBe(true);
    expect(rateLimit('a', 1, 60_000)).toBe(false);
    expect(rateLimit('b', 1, 60_000)).toBe(true);
  });

  it('bounds the store — the LRU key is evicted beyond the cap', () => {
    expect(rateLimit('first', 1, 60_000)).toBe(true); // 'first' now blocked on reuse...
    expect(rateLimit('first', 1, 60_000)).toBe(false);
    // ...until it's evicted by flooding well past the 5000-key cap.
    for (let i = 0; i < 6000; i++) rateLimit(`flood-${i}`, 1, 60_000);
    // 'first' was the LRU → evicted → its history is gone → allowed fresh again.
    expect(rateLimit('first', 1, 60_000)).toBe(true);
  });
});

describe('clientIp trusted-proxy keying (#862)', () => {
  it('takes the trusted-hop entry, ignoring a spoofed leftmost XFF (default 1 hop)', () => {
    expect(clientIp(req({ 'x-forwarded-for': 'evil-spoof, 203.0.113.5' }))).toBe('203.0.113.5');
  });

  it('returns a single XFF value as-is (keeps existing single-IP keying stable)', () => {
    expect(clientIp(req({ 'x-forwarded-for': '198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('falls back to x-real-ip, then anon, when there is no XFF', () => {
    expect(clientIp(req({ 'x-real-ip': '192.0.2.1' }))).toBe('192.0.2.1');
    expect(clientIp(req({}))).toBe('anon');
  });
});
