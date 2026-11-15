/**
 * `from` and `to` are inclusive at the precision given. Capture times keep whole milliseconds, so
 * a fractional bound reaches its precision's last millisecond at the end, and never lets in an
 * earlier capture at the start.
 */
import { describe, expect, it } from 'bun:test';

import { parseSearchBody } from '../src/routes/service-photos/search-body.ts';

function bounds(from?: string, to?: string) {
  const parsed = parseSearchBody({ from, to });
  if (!parsed.ok) throw new Error(parsed.message);
  return [parsed.request.capturedFrom, parsed.request.capturedTo];
}

describe('service photo search bounds', () => {
  it('widens dates, minutes and seconds to their whole span', () => {
    expect(bounds('2024-07-04', '2024-07-04')).toEqual([
      '2024-07-04T00:00:00.000Z',
      '2024-07-04T23:59:59.999Z',
    ]);
    expect(bounds(undefined, '2024-07-04T10:30')[1]).toBe('2024-07-04T10:30:59.999Z');
    expect(bounds(undefined, '2024-07-04T10:30:00')[1]).toBe('2024-07-04T10:30:00.999Z');
  });

  it('ends a short fraction at its last millisecond', () => {
    expect(bounds(undefined, '2024-07-04T10:30:00.1')[1]).toBe('2024-07-04T10:30:00.199Z');
    expect(bounds(undefined, '2024-07-04T10:30:00.12')[1]).toBe('2024-07-04T10:30:00.129Z');
    expect(bounds(undefined, '2024-07-04T10:30:00.123')[1]).toBe('2024-07-04T10:30:00.123Z');
    expect(bounds(undefined, '2024-07-04T10:30:00.1009')[1]).toBe('2024-07-04T10:30:00.100Z');
  });

  it('starts a fraction without admitting an earlier millisecond', () => {
    expect(bounds('2024-07-04T10:30:00.1')[0]).toBe('2024-07-04T10:30:00.100Z');
    expect(bounds('2024-07-04T10:30:00.1000')[0]).toBe('2024-07-04T10:30:00.100Z');
    expect(bounds('2024-07-04T10:30:00.1001')[0]).toBe('2024-07-04T10:30:00.101Z');
    expect(bounds('2024-07-04T23:59:59.9991')[0]).toBe('2024-07-05T00:00:00.000Z');
  });
});
