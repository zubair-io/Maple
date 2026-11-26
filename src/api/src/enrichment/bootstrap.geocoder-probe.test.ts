import { describe, expect, it } from 'bun:test';
import { checkGeocoderStatus, type GeocoderProbeLogger } from './bootstrap.ts';
import { resolveEnrichmentConfig } from './enrichment-config.resolve.ts';

type Line = { level: 'info' | 'warn'; fields: Record<string, unknown>; message: string };

function recordingLogger(): { logger: GeocoderProbeLogger; lines: Line[] } {
  const lines: Line[] = [];
  return {
    lines,
    logger: {
      info: (fields, message) => lines.push({ level: 'info', fields, message }),
      warn: (fields, message) => lines.push({ level: 'warn', fields, message }),
    },
  };
}

const configured = (url: string) =>
  resolveEnrichmentConfig({
    geocode_worker_enabled: true,
    nominatim_url: url,
  } as Parameters<typeof resolveEnrichmentConfig>[0]);

describe('checkGeocoderStatus', () => {
  it('logs a warning naming the URL and the HTTP status, and does not throw', async () => {
    const { logger, lines } = recordingLogger();
    const result = await checkGeocoderStatus(configured('http://nominatim.lan:8080'), {
      logger,
      fetchImpl: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
    });
    expect(result).toBe('unreachable');
    const warn = lines.find((l) => l.level === 'warn')!;
    expect(warn.message).toContain('Nominatim status check failed');
    expect(warn.message).toContain('returned 500');
    expect(warn.message).toContain('http://nominatim.lan:8080');
    expect(warn.message).toContain('retried with backoff and then set aside');
    expect(warn.message).not.toContain('failed to start');
    expect(lines.some((l) => l.message === 'Nominatim healthy')).toBe(false);
  });

  it('reports a timeout as a timeout', async () => {
    const { logger, lines } = recordingLogger();
    const result = await checkGeocoderStatus(configured('http://nominatim.lan:8080'), {
      logger,
      fetchImpl: (async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }) as unknown as typeof fetch,
    });
    expect(result).toBe('unreachable');
    const warn = lines.find((l) => l.level === 'warn')!;
    expect(warn.message).toContain('timed out after 5000ms');
    expect(warn.message).toContain('http://nominatim.lan:8080');
  });

  it.each([
    ['plain credentials', 'http://alice:secret@nominatim.lan:8080', 'secret'],
    ['a password containing @', 'http://alice:p@ss@nominatim.lan:8080', 'p@ss'],
    ['a percent-encoded slash in the password', 'http://alice:p%2Fss@nominatim.lan:8080', 'p%2Fss'],
  ])('never logs credentials: %s', async (_label, rawUrl, password) => {
    const { logger, lines } = recordingLogger();
    const result = await checkGeocoderStatus(configured(rawUrl), {
      logger,
      fetchImpl: (async () => {
        throw new Error(`connect ECONNREFUSED ${rawUrl}/status`);
      }) as unknown as typeof fetch,
    });
    expect(result).toBe('unreachable');
    const serialized = JSON.stringify(lines);
    expect(serialized).toContain('ECONNREFUSED');
    expect(serialized).toContain('nominatim.lan:8080');
    for (const secret of [password, decodeURIComponent(password), 'alice', 'p%40ss', 'ss@']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('logs a URL without credentials unchanged', async () => {
    const { logger, lines } = recordingLogger();
    await checkGeocoderStatus(configured('http://nominatim.lan:8080'), {
      logger,
      fetchImpl: (async () => new Response('OK')) as unknown as typeof fetch,
    });
    expect(lines[0]!.fields).toEqual({ url: 'http://nominatim.lan:8080' });
  });

  it('logs a placeholder, never the raw string, for an unparseable URL', async () => {
    const { logger, lines } = recordingLogger();
    const rawUrl = 'http://u:p/ss@wd@host/x';
    await checkGeocoderStatus(configured(rawUrl), {
      logger,
      fetchImpl: (async () => {
        throw new Error(`Invalid URL ${rawUrl}/status`);
      }) as unknown as typeof fetch,
    });
    const serialized = JSON.stringify(lines);
    expect(serialized).toContain('<unparseable url>');
    expect(serialized).not.toContain('ss@wd');
    expect(serialized).not.toContain('u:p');
  });

  it('keeps the success line when the status check answers', async () => {
    const { logger, lines } = recordingLogger();
    const result = await checkGeocoderStatus(configured('http://nominatim.lan:8080'), {
      logger,
      fetchImpl: (async () => new Response('OK', { status: 200 })) as unknown as typeof fetch,
    });
    expect(result).toBe('healthy');
    expect(lines.map((l) => l.level)).toEqual(['info', 'info']);
    expect(lines[1]!.message).toBe('Nominatim healthy');
  });

  it('does nothing when geocoding is off', async () => {
    const { logger, lines } = recordingLogger();
    const never = (async () => {
      throw new Error('must not fetch');
    }) as unknown as typeof fetch;
    const off = resolveEnrichmentConfig({
      geocode_worker_enabled: false,
      nominatim_url: 'http://x',
    } as Parameters<typeof resolveEnrichmentConfig>[0]);
    expect(await checkGeocoderStatus(off, { logger, fetchImpl: never })).toBe('skipped');
    expect(lines).toEqual([]);
  });

  it('does nothing when no URL is set', async () => {
    const { logger, lines } = recordingLogger();
    const unset = resolveEnrichmentConfig({
      geocode_worker_enabled: true,
      nominatim_url: '',
    } as Parameters<typeof resolveEnrichmentConfig>[0]);
    expect(
      await checkGeocoderStatus(unset, {
        logger,
        fetchImpl: (async () => new Response('OK')) as unknown as typeof fetch,
      }),
    ).toBe('skipped');
    expect(lines).toEqual([]);
  });
});
