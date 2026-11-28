import { describe, it, expect } from 'vitest';
import {
  MAX_CONCURRENT_THUMB_LOADS,
  MULTIPLEXED_THUMB_LOADS,
  thumbLoadBound,
} from './thumb-load-bound';

const ORIGIN = 'https://photos.example';

type Entry = { name: string; nextHopProtocol: string };

/** Resource Timing as the bound reads it: the page load, then resources in arrival order. */
function timing(navigation: Entry[], resources: Entry[] = []) {
  return {
    getEntriesByType: (type: string) =>
      (type === 'navigation' ? navigation : type === 'resource' ? resources : []) as never,
  };
}

const at = (path: string, nextHopProtocol: string, origin = ORIGIN): Entry => ({
  name: `${origin}${path}`,
  nextHopProtocol,
});

describe('thumbLoadBound', () => {
  it('allows sixteen at once when the page arrived over HTTP/2', () => {
    expect(thumbLoadBound(ORIGIN, timing([at('/browse', 'h2')]))()).toBe(MULTIPLEXED_THUMB_LOADS);
  });

  it('allows sixteen at once over HTTP/3', () => {
    expect(thumbLoadBound(ORIGIN, timing([at('/browse', 'h3')]))()).toBe(MULTIPLEXED_THUMB_LOADS);
  });

  it('keeps four over HTTP/1.1', () => {
    expect(thumbLoadBound(ORIGIN, timing([at('/browse', 'http/1.1')]))()).toBe(
      MAX_CONCURRENT_THUMB_LOADS,
    );
  });

  it('reads a request that bypassed the service worker when every other entry is blank', () => {
    const entries = timing(
      [at('/browse', '')],
      [at('/api/thumb/a/1.dng', ''), at('/api/auth/refresh', 'h2'), at('/api/thumb/a/2.dng', '')],
    );
    expect(thumbLoadBound(ORIGIN, entries)()).toBe(MULTIPLEXED_THUMB_LOADS);
  });

  it('ignores protocols reported for other origins', () => {
    const entries = timing([at('/browse', '')], [at('/tile.png', 'h2', 'https://tiles.example')]);
    expect(thumbLoadBound(ORIGIN, entries)()).toBe(MAX_CONCURRENT_THUMB_LOADS);
  });

  it('keeps four while no entry names the protocol, then takes the first one that does', () => {
    const resources: Entry[] = [];
    const bound = thumbLoadBound(ORIGIN, timing([at('/browse', '')], resources));

    expect(bound()).toBe(MAX_CONCURRENT_THUMB_LOADS);
    resources.push(at('/api/auth/refresh', 'h2'));
    expect(bound()).toBe(MULTIPLEXED_THUMB_LOADS);
  });

  it('stays settled once a protocol is known', () => {
    const resources: Entry[] = [];
    const bound = thumbLoadBound(ORIGIN, timing([at('/browse', 'h2')], resources));

    expect(bound()).toBe(MULTIPLEXED_THUMB_LOADS);
    resources.push(at('/api/thumb/a/1.dng', 'http/1.1'));
    expect(bound()).toBe(MULTIPLEXED_THUMB_LOADS);
  });

  it('keeps four where the browser has no Resource Timing', () => {
    expect(thumbLoadBound(ORIGIN, undefined)()).toBe(MAX_CONCURRENT_THUMB_LOADS);
  });
});
