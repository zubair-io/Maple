/**
 * `describe_servers` validation + normalisation.
 *
 * The two entry points differ deliberately: `validateDescribeServers` is the
 * write path (a bad entry is a 400, so the operator learns about the typo),
 * `normalizeDescribeServers` is the read path (a bad entry is dropped, so a
 * broken row can never stop the worker booting). Both share the ordering,
 * de-duplication and per-server concurrency rules asserted here.
 */

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_DESCRIBE_SERVER_CONCURRENCY,
  MAX_DESCRIBE_SERVERS,
  normalizeDescribeServers,
  totalDescribeCapacity,
  validateDescribeServers,
} from './describe-servers.ts';

describe('validateDescribeServers', () => {
  it('normalises urls and keeps operator order', () => {
    const result = validateDescribeServers([
      { url: 'http://gpu-a:11434/', concurrency: 4 },
      { url: 'https://gpu-b:11434', concurrency: 1 },
    ]);
    expect(result).toEqual([
      { url: 'http://gpu-a:11434', concurrency: 4 },
      { url: 'https://gpu-b:11434', concurrency: 1 },
    ]);
  });

  it('defaults a missing concurrency', () => {
    expect(validateDescribeServers([{ url: 'http://a:11434' }])).toEqual([
      { url: 'http://a:11434', concurrency: DEFAULT_DESCRIBE_SERVER_CONCURRENCY },
    ]);
  });

  it('treats null and [] as "no explicit list"', () => {
    expect(validateDescribeServers(null)).toBeNull();
    expect(validateDescribeServers([])).toBeNull();
  });

  it('rejects a duplicate endpoint', () => {
    const result = validateDescribeServers([
      { url: 'http://a:11434', concurrency: 2 },
      { url: 'http://a:11434/', concurrency: 2 },
    ]);
    expect(result).toEqual({ error: 'server 2: duplicate url http://a:11434' });
  });

  it('rejects a bad url, a bad concurrency, and an over-long list', () => {
    expect(validateDescribeServers([{ url: 'not a url' }])).toHaveProperty('error');
    expect(validateDescribeServers([{ url: 'ftp://a' }])).toHaveProperty('error');
    expect(validateDescribeServers([{ url: '' }])).toHaveProperty('error');
    expect(validateDescribeServers([{ url: 'http://a:11434', concurrency: 0 }])).toHaveProperty(
      'error',
    );
    expect(validateDescribeServers([{ url: 'http://a:11434', concurrency: 2.5 }])).toHaveProperty(
      'error',
    );
    const tooMany = Array.from({ length: MAX_DESCRIBE_SERVERS + 1 }, (_, i) => ({
      url: `http://a${i}:11434`,
    }));
    expect(validateDescribeServers(tooMany)).toHaveProperty('error');
    expect(validateDescribeServers('nope')).toHaveProperty('error');
  });
});

describe('normalizeDescribeServers', () => {
  it('drops unusable entries instead of failing', () => {
    expect(
      normalizeDescribeServers([
        { url: 'http://good:11434', concurrency: 3 },
        { url: 'nonsense' },
        null,
        { url: 'http://good:11434' },
        { url: 'http://other:11434', concurrency: 999 },
      ]),
    ).toEqual([
      { url: 'http://good:11434', concurrency: 3 },
      { url: 'http://other:11434', concurrency: DEFAULT_DESCRIBE_SERVER_CONCURRENCY },
    ]);
  });

  it('returns null when nothing usable survives', () => {
    expect(normalizeDescribeServers([{ url: 'nonsense' }])).toBeNull();
    expect(normalizeDescribeServers(undefined)).toBeNull();
  });
});

describe('totalDescribeCapacity', () => {
  it('sums per-server concurrency', () => {
    expect(
      totalDescribeCapacity([
        { url: 'http://a:11434', concurrency: 4 },
        { url: 'http://b:11434', concurrency: 3 },
      ]),
    ).toBe(7);
  });
});
