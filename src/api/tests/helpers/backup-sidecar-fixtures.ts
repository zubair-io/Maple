/**
 * Shared setup for the backup sidecar route suites: a real temp library, a
 * private SQLite database, real uploads and real XMP documents.
 */
import { afterAll, beforeAll, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { callNative, shutdownMaplePool } from 'maple';
import { ObjectId } from '../../src/db/object-id.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../../src/indexer/libraries.cache.ts';
import { xmpSidecarPath } from '../../src/fs/xmp.ts';
import { authedHandle } from './authed-handle.ts';
import { seedBackupAsset, seedLibrary } from './sqlite-fixtures.ts';

export const deviceId = 'test-device-cas';

interface DivergenceRow {
  asset_id: string;
  sidecar_rel_path: string;
  device_id: string;
  base_sha256: string | null;
  displaced_sha256: string;
  displaced_xmp: string;
  incoming_sha256: string;
}

interface Entry {
  id: string;
  action: string;
  parentId: string;
  writer: string;
  adjustmentXmp: string;
}

interface Upload {
  relPath: string;
  phid: string;
  assetId: ObjectId;
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A real XMP document: `label` and any `extra` properties are unknown `test:` attributes. */
export const xmp = (label: string, extra: Record<string, string> = {}) => {
  const attributes = Object.entries({ label, ...extra })
    .map(([name, value]) => ` test:${name}="${value}"`)
    .join('');
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:test="https://example.test/ns/1.0/"${attributes}/></rdf:RDF></x:xmpmeta>`;
};
export const property = (document: string, name: string) =>
  new RegExp(` test:${name}="([^"]*)"`).exec(document)?.[1];
export const labelOf = (document: string) => property(document, 'label');
export const history = async (document: string): Promise<Entry[]> => {
  const result = await callNative('workflowReadXmp', [document]);
  if (!result.ok) throw Error(result.error);
  return JSON.parse(result.value).history;
};

/** Registers the suite's library and database; the returned handle works inside tests. */
export function useSidecarLibrary() {
  let live!: LiveTestDatabase;
  let libId!: ObjectId;
  let tmpLib!: string;

  beforeAll(async () => {
    tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-sidecar-cas-test-'));
    live = await createLiveTestDatabase();
    libId = seedLibrary(live.db, { path: tmpLib, label: 'sidecar-cas-test' });
    invalidateLibraryRoots();
  });

  afterAll(async () => {
    shutdownMaplePool();
    live.close();
    invalidateLibraryRoots();
    await fs.rm(tmpLib, { recursive: true, force: true });
  });

  /** Seed one previously uploaded original. */
  async function seedUpload(name: string): Promise<Upload> {
    const relPath = `2024/CAS/${name}.HEIC`;
    const phid = `CAS/${name}/L0/001`;
    const abs = path.join(tmpLib, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.alloc(64, 1));
    const assetId = seedBackupAsset(live.db, {
      mapleId: createHash('md5').update(name).digest('hex'),
      size: 64,
      locations: [{ libraryId: libId, relPath }],
      links: [{ deviceId, phassetLocalId: phid }],
    });
    return { relPath, phid, assetId };
  }

  function post(
    target: { relPath: string; phid: string },
    body: string,
    base: string | undefined,
    head?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-Maple-Device-Id': deviceId,
      'X-Maple-Phasset-Id': target.phid,
      'X-Maple-Target-Rel-Path': target.relPath,
    };
    if (base !== undefined) headers['X-Maple-Sidecar-Base'] = base;
    if (head !== undefined) headers['X-Maple-Sidecar-Head'] = head;
    return authedHandle(
      new Request(`http://localhost/api/libraries/${libId.toHexString()}/backup/sidecar`, {
        method: 'POST',
        headers,
        body,
      }),
    );
  }

  const onDisk = (relPath: string) =>
    fs.readFile(path.join(tmpLib, xmpSidecarPath(relPath)), 'utf8');

  function divergences(relPath: string): DivergenceRow[] {
    return live.db
      .query(
        `SELECT asset_id, sidecar_rel_path, device_id, base_sha256, displaced_sha256,
                displaced_xmp, incoming_sha256
           FROM sidecar_divergences WHERE sidecar_rel_path = ? ORDER BY rowid`,
      )
      .all(xmpSidecarPath(relPath)) as DivergenceRow[];
  }

  /** First send from a device: the stored sidecar and the head it was told. */
  async function firstSend(target: Upload, body: string) {
    const res = await post(target, body, 'none');
    expect(res.status).toBe(200);
    const reply = (await res.json()) as { head: string };
    return { head: reply.head, stored: await onDisk(target.relPath) };
  }

  return {
    get live() {
      return live;
    },
    get libId() {
      return libId;
    },
    get tmpLib() {
      return tmpLib;
    },
    seedUpload,
    post,
    onDisk,
    divergences,
    firstSend,
  };
}
