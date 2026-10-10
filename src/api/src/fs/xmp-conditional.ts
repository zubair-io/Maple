/** Exact-content preconditions for path-keyed native cloud saves (#4317).
 * Checks and publication share the existing server-side write barrier. */
import * as fs from 'node:fs/promises';
import { computeBodyETag } from '../runtime/http-etag';
import { primarySidecarDestination, preparePrimarySidecarWrite } from './xmp';
import { serializeSidecarWrite } from './sidecar-write-order';
import { isMissingSidecar, writeSidecarAtomic, writeSidecarCreateOnly } from './sidecar-io';
import { removalRecords } from './removal-records.ts';

export type ConditionalXmpResult =
  | { kind: 'ok'; data: string }
  | { kind: 'conflict' }
  | { kind: 'removal-conflict' }
  | { kind: 'error'; error: string };

export async function writeXmpIfUnchanged(
  rawPath: string,
  xml: string,
  expectedEtag: string | null,
): Promise<ConditionalXmpResult> {
  const allowed = await primarySidecarDestination(rawPath);
  if (!allowed.ok) return { kind: 'error', error: allowed.error };
  const destination = allowed.data;
  return serializeSidecarWrite<ConditionalXmpResult>(destination, async () => {
    try {
      const current = await fs.readFile(destination, 'utf8').catch((error: unknown) => {
        if (isMissingSidecar(error)) return null;
        throw error;
      });
      const actualEtag = current === null ? null : computeBodyETag(current);
      if (actualEtag !== expectedEtag) return { kind: 'conflict' };
      const before = current ? (removalRecords(current) ?? '[]') : '[]';
      const after = removalRecords(xml) ?? '[]';
      if (before !== after) return { kind: 'removal-conflict' };
      const prepared = await preparePrimarySidecarWrite(destination, xml);
      if (!prepared.ok) return { kind: 'error', error: prepared.error };
      if (expectedEtag === null) {
        const created = await writeSidecarCreateOnly(
          destination,
          prepared.data,
          'XMP write failed',
        );
        if ('exists' in created) return { kind: 'conflict' };
        return created.ok
          ? { kind: 'ok', data: prepared.data }
          : { kind: 'error', error: created.error };
      }
      const written = await writeSidecarAtomic(destination, prepared.data, 'XMP write failed');
      return written.ok
        ? { kind: 'ok', data: prepared.data }
        : { kind: 'error', error: written.error };
    } catch (error) {
      return { kind: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  });
}
