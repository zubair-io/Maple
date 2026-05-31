import { describe, it, expect, spyOn } from 'bun:test';
import * as configRepo from './enrichment-config.repo.ts';
import { otelLogStream } from '../otel-logs.ts';

/**
 * `startFaceWorker()` is documented "Never throws" (#720). #707 wrapped the
 * model-preload path; this guards the OTHER throwable on the happy path —
 * `loadEnrichmentConfig()` (and the `resolveEnrichmentConfig()` fold) at the top
 * of the function. If the config load rejects (e.g. Mongo unreachable mid-boot),
 * the bootstrap must log a warning and resolve, NOT reject — the `index.ts`
 * caller's defensive try/catch is a safety net, not the contract.
 *
 * Forcing the reject — and NOT leaking it: we `spyOn` the namespace export
 * `loadEnrichmentConfig` and `mockRestore()` it in `finally`. ESM live bindings
 * mean face-bootstrap reads the spied value even though it imported the function
 * earlier, and `mockRestore` cleanly reverts the export — unlike `mock.module`,
 * which has no real un-mock and would leak the throwing stub into the sibling
 * `enrichment-config.repo.test.ts` (whose static imports bind once at file load
 * and never re-resolve).
 *
 * Asserting the log: face-bootstrap captures its `log = child('face')` at
 * module-load time, so swapping `../log.ts` per-test can't retroactively change
 * it. Pino's multistream (configured in `log.ts`) fans EVERY record out to
 * `otelLogStream.write`, so we spy on that single object — it intercepts the
 * already-captured child logger's output regardless of suite import order. The
 * spy's `mockImplementation` fully replaces `write`, so it captures the line
 * before the export-target / flush logic runs (no network, target stays inert).
 */
describe('startFaceWorker — never throws when config load rejects (#720)', () => {
  it('resolves null and logs a warning instead of propagating the rejection', async () => {
    const records: Record<string, unknown>[] = [];
    const writeSpy = spyOn(otelLogStream, 'write').mockImplementation((line: string) => {
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // non-JSON line — ignore
      }
    });

    const loadSpy = spyOn(configRepo, 'loadEnrichmentConfig').mockImplementation(async () => {
      throw new Error('mongo unreachable');
    });

    try {
      const { startFaceWorker } = await import('./face-bootstrap.ts');

      // The contract: resolves (does not throw / reject) even though the config
      // load rejected.
      await expect(startFaceWorker()).resolves.toBeNull();
      expect(loadSpy).toHaveBeenCalled();

      // …and it logged a warning (pino level 40) tagged to the `face` component,
      // rather than swallowing the failure silently.
      const faceWarn = records.find((r) => r.component === 'face' && r.level === 40);
      expect(faceWarn).toBeDefined();
      expect(String(faceWarn?.msg)).toContain('failed to load enrichment config');
    } finally {
      loadSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });
});
