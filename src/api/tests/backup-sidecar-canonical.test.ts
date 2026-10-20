/**
 * A backed-up photo's sidecar lands under the canonical name the server reads
 * (`IMG_1234.HEIC` → `IMG_1234.xmp`; videos keep `IMG_1234.MOV.xmp`), and a
 * `<stem>.xmp` shared by a same-stem pair is never overwritten by the other
 * photo's send (#5021, #4692). Real temp library files and a private SQLite
 * database.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ObjectId } from '../src/db/object-id.ts';
import { authedHandle } from './helpers/authed-handle.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { seedBackupAsset, seedLibrary } from './helpers/sqlite-fixtures.ts';
import { invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';

const deviceId = 'test-device-canonical';

let live: LiveTestDatabase;
let libId: ObjectId;
let tmpLib: string;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const xmp = (label: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/">${label}</x:xmpmeta>`;

beforeAll(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-sidecar-canonical-test-'));
  live = await createLiveTestDatabase();
  libId = seedLibrary(live.db, {
    path: tmpLib,
    label: 'sidecar-canonical-test',
  });
  invalidateLibraryRoots();
});

afterAll(async () => {
  live.close();
  invalidateLibraryRoots();
  await fs.rm(tmpLib, { recursive: true, force: true });
});

interface Upload {
  relPath: string;
  phid: string;
  assetId: ObjectId;
}

async function seedUpload(relPath: string): Promise<Upload> {
  const phid = `CANON/${relPath}/L0/001`;
  const abs = path.join(tmpLib, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.alloc(64, 1));
  const assetId = seedBackupAsset(live.db, {
    mapleId: createHash('md5').update(relPath).digest('hex'),
    size: 64,
    locations: [{ libraryId: libId, relPath }],
    links: [{ deviceId, phassetLocalId: phid }],
  });
  return { relPath, phid, assetId };
}

function post(target: Upload, body: string, base: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-Maple-Device-Id': deviceId,
    'X-Maple-Phasset-Id': target.phid,
    'X-Maple-Target-Rel-Path': target.relPath,
    ...(base === undefined ? {} : { 'X-Maple-Sidecar-Base': base }),
  };
  return authedHandle(
    new Request(`http://localhost/api/libraries/${libId.toHexString()}/backup/sidecar`, {
      method: 'POST',
      headers,
      body,
    }),
  );
}

const read = (relPath: string) => fs.readFile(path.join(tmpLib, relPath), 'utf8').catch(() => null);

function keptAside(sidecarRelPath: string) {
  return live.db
    .query(
      `SELECT displaced_xmp, displaced_sha256, incoming_sha256 FROM sidecar_divergences
        WHERE sidecar_rel_path = ? ORDER BY rowid`,
    )
    .all(sidecarRelPath);
}

describe('backup sidecar canonical name (#5021)', () => {
  test('an uploaded photo edit is what the server reads back for that photo', async () => {
    const photo = await seedUpload('2024/03/15/IMG_1234.HEIC');

    const res = await post(photo, xmp('device edit'), 'none');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      target_rel_path: '2024/03/15/IMG_1234.xmp',
    });
    const served = await authedHandle(
      new Request(`http://localhost/api/assets/${photo.assetId.toHexString()}/xmp`),
    );
    expect(served.status).toBe(200);
    expect(await served.text()).toContain('device edit');
    expect(await read('2024/03/15/IMG_1234.HEIC.xmp')).toBeNull();
  });

  test('a first send without a base also uses the canonical name', async () => {
    const photo = await seedUpload('2024/03/16/IMG_2000.JPG');

    const res = await post(photo, xmp('legacy client'), undefined);

    expect(await res.json()).toEqual({
      target_rel_path: '2024/03/16/IMG_2000.xmp',
    });
    expect(await read('2024/03/16/IMG_2000.xmp')).toBe(xmp('legacy client'));
  });

  test('a video keeps its full-name sidecar', async () => {
    const clip = await seedUpload('2024/03/17/IMG_3000.MOV');

    const res = await post(clip, xmp('clip edit'), 'none');

    expect(await res.json()).toEqual({
      target_rel_path: '2024/03/17/IMG_3000.MOV.xmp',
    });
    expect(await read('2024/03/17/IMG_3000.MOV.xmp')).toBe(xmp('clip edit'));
  });
});

describe('a same-stem pair shares one sidecar (#4692)', () => {
  test("one photo's send never overwrites the sidecar the other photo wrote", async () => {
    const jpeg = await seedUpload('2024/04/01/IMG_9.jpg');
    const raw = await seedUpload('2024/04/01/IMG_9.cr2');
    expect((await post(jpeg, xmp('jpeg edit'), 'none')).status).toBe(200);

    const res = await post(raw, xmp('raw edit'), 'none');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      target_rel_path: '2024/04/01/IMG_9.xmp',
      shared: true,
    });
    expect(await read('2024/04/01/IMG_9.xmp')).toBe(xmp('jpeg edit'));
    expect(keptAside('2024/04/01/IMG_9.xmp')).toEqual([
      {
        displaced_xmp: xmp('raw edit'),
        displaced_sha256: sha256(xmp('raw edit')),
        incoming_sha256: sha256(xmp('raw edit')),
      },
    ]);
  });

  test('the other photo sending the same edit joins the shared sidecar', async () => {
    const jpeg = await seedUpload('2024/04/02/IMG_8.jpg');
    const raw = await seedUpload('2024/04/02/IMG_8.cr2');
    await post(jpeg, xmp('pair edit'), 'none');

    const res = await post(raw, xmp('pair edit'), 'none');

    expect(await res.json()).toEqual({
      target_rel_path: '2024/04/02/IMG_8.xmp',
      unchanged: true,
    });
    expect(keptAside('2024/04/02/IMG_8.xmp')).toEqual([]);
  });

  test('the photo that wrote the shared sidecar can still update it', async () => {
    const jpeg = await seedUpload('2024/04/03/IMG_7.jpg');
    await seedUpload('2024/04/03/IMG_7.cr2');
    await post(jpeg, xmp('v1'), 'none');

    const res = await post(jpeg, xmp('v2'), sha256(xmp('v1')));

    expect(await res.json()).toEqual({
      target_rel_path: '2024/04/03/IMG_7.xmp',
    });
    expect(await read('2024/04/03/IMG_7.xmp')).toBe(xmp('v2'));
  });

  test('without a base the other photo cannot replace the shared sidecar either', async () => {
    const jpeg = await seedUpload('2024/04/04/IMG_6.jpg');
    const raw = await seedUpload('2024/04/04/IMG_6.cr2');
    await post(jpeg, xmp('jpeg edit'), 'none');

    const res = await post(raw, xmp('raw edit'), undefined);

    expect(await res.json()).toEqual({
      target_rel_path: '2024/04/04/IMG_6.xmp',
      skipped: true,
    });
    expect(await read('2024/04/04/IMG_6.xmp')).toBe(xmp('jpeg edit'));
  });
});

const mapleXmp = (label: string) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:papp="http://ns.justmaple.app/photo/1.0/">${label}</x:xmpmeta>`;

describe('a canonical send is a server-visible edit (#5021)', () => {
  test('it marks the asset edited and announces the change', async () => {
    const photo = await seedUpload('2024/05/01/IMG_10.HEIC');
    const before = live.db
      .query(`SELECT sidecar_ver FROM assets WHERE id = ?`)
      .get(photo.assetId.toHexString()) as { sidecar_ver: number };

    await post(photo, xmp('device edit'), 'none');

    expect(
      live.db
        .query(`SELECT has_xmp, sidecar_ver FROM assets WHERE id = ?`)
        .get(photo.assetId.toHexString()),
    ).toEqual({ has_xmp: 1, sidecar_ver: before.sidecar_ver + 2 });
    expect(
      live.db
        .query(`SELECT kind FROM asset_changes WHERE asset_id = ?`)
        .all(photo.assetId.toHexString()),
    ).toEqual([{ kind: 'update' }, { kind: 'update' }]);
  });

  test("it retires the photo's old-name sidecar, keeping a different version aside", async () => {
    const photo = await seedUpload('2024/05/02/IMG_11.HEIC');
    await fs.writeFile(path.join(tmpLib, '2024/05/02/IMG_11.HEIC.xmp'), mapleXmp('older send'));

    await post(photo, mapleXmp('newer edit'), 'none');

    expect(await read('2024/05/02/IMG_11.xmp')).toBe(mapleXmp('newer edit'));
    expect(await read('2024/05/02/IMG_11.HEIC.xmp')).toBeNull();
    expect(keptAside('2024/05/02/IMG_11.xmp')).toEqual([
      {
        displaced_xmp: mapleXmp('older send'),
        displaced_sha256: sha256(mapleXmp('older send')),
        incoming_sha256: sha256(mapleXmp('newer edit')),
      },
    ]);
  });

  test('an old-name file another tool wrote is left alone', async () => {
    const photo = await seedUpload('2024/05/03/IMG_12.JPG');
    const foreign = '<x:xmpmeta xmlns:darktable="http://darktable.sf.net/">dt</x:xmpmeta>';
    await fs.writeFile(path.join(tmpLib, '2024/05/03/IMG_12.JPG.xmp'), foreign);

    await post(photo, mapleXmp('device edit'), 'none');

    expect(await read('2024/05/03/IMG_12.JPG.xmp')).toBe(foreign);
  });
});

describe('a send without a base never buries an old-name edit (#698, #5021)', () => {
  test("it skips when the photo's edit still sits under the old name", async () => {
    const photo = await seedUpload('2024/06/01/IMG_20.HEIC');
    await fs.writeFile(path.join(tmpLib, '2024/06/01/IMG_20.HEIC.xmp'), mapleXmp('device A edit'));

    const res = await post(photo, mapleXmp('device B default'), undefined);

    expect(await res.json()).toEqual({ target_rel_path: '2024/06/01/IMG_20.xmp', skipped: true });
    expect(await read('2024/06/01/IMG_20.xmp')).toBeNull();
    expect(await read('2024/06/01/IMG_20.HEIC.xmp')).toBe(mapleXmp('device A edit'));
  });
});

describe("the device's one-time re-send never loses a later web edit (#5021)", () => {
  test('a web edit the re-send lands over is kept in sidecar_divergences', async () => {
    const photo = await seedUpload('2024/07/01/IMG_30.HEIC');
    expect((await post(photo, mapleXmp('first backup'), 'none')).status).toBe(200);
    const webEdit = mapleXmp('web edit');
    const saved = await authedHandle(
      new Request(`http://localhost/api/assets/${photo.assetId.toHexString()}/xmp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: webEdit,
      }),
    );
    expect(saved.status).toBe(204);
    const onDiskWebEdit = (await read('2024/07/01/IMG_30.xmp'))!;
    expect(onDiskWebEdit).toContain('web edit');

    const res = await post(photo, mapleXmp('re-sent device edit'), 'none');

    expect(await res.json()).toEqual({ target_rel_path: '2024/07/01/IMG_30.xmp', diverged: true });
    expect(await read('2024/07/01/IMG_30.xmp')).toBe(mapleXmp('re-sent device edit'));
    expect(
      live.db
        .query(`SELECT asset_id, base_sha256 FROM sidecar_divergences WHERE sidecar_rel_path = ?`)
        .all('2024/07/01/IMG_30.xmp'),
    ).toEqual([{ asset_id: photo.assetId.toHexString(), base_sha256: null }]);
    expect(keptAside('2024/07/01/IMG_30.xmp')).toEqual([
      {
        displaced_xmp: onDiskWebEdit,
        displaced_sha256: sha256(onDiskWebEdit),
        incoming_sha256: sha256(mapleXmp('re-sent device edit')),
      },
    ]);
  });
});

describe('a target with no file extension (#5021)', () => {
  test('is refused rather than written to a folder-wide .xmp', async () => {
    const photo = await seedUpload('2024/08/01/IMG_40');

    const res = await post(photo, mapleXmp('edit'), 'none');

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'X-Maple-Target-Rel-Path has no file extension',
    });
    expect(await read('.xmp')).toBeNull();
    expect(await read('2024/08/01/.xmp')).toBeNull();
  });
});

describe('a send without a base is bound to the photo it names (#5021)', () => {
  test("a target that is another photo's file is refused and that photo's sidecar untouched", async () => {
    const photo = await seedUpload('2024/09/01/IMG_50.HEIC');
    const other = await seedUpload('2024/09/01/IMG_51.HEIC');

    const res = await post({ ...photo, relPath: other.relPath }, mapleXmp('stray'), undefined);

    expect(res.status).toBe(404);
    expect(await read('2024/09/01/IMG_51.xmp')).toBeNull();
  });
});

describe('a failed old-name retirement is retried, never left to replay (#5021)', () => {
  test('the send fails until the old-name edit is kept aside, and a retry finishes it', async () => {
    const photo = await seedUpload('2024/10/01/IMG_60.HEIC');
    await fs.writeFile(path.join(tmpLib, '2024/10/01/IMG_60.HEIC.xmp'), mapleXmp('older send'));
    live.db.exec('ALTER TABLE sidecar_divergences RENAME TO sidecar_divergences_hidden');
    const failed = await post(photo, mapleXmp('newer edit'), 'none').finally(() =>
      live.db.exec('ALTER TABLE sidecar_divergences_hidden RENAME TO sidecar_divergences'),
    );

    expect(failed.status).toBe(500);
    expect(await read('2024/10/01/IMG_60.HEIC.xmp')).toBe(mapleXmp('older send'));
    expect(
      live.db.query(`SELECT has_xmp FROM assets WHERE id = ?`).get(photo.assetId.toHexString()),
    ).toEqual({ has_xmp: 1 });

    const retried = await post(photo, mapleXmp('newer edit'), 'none');

    expect(await retried.json()).toEqual({
      target_rel_path: '2024/10/01/IMG_60.xmp',
      unchanged: true,
    });
    expect(await read('2024/10/01/IMG_60.HEIC.xmp')).toBeNull();
    expect(keptAside('2024/10/01/IMG_60.xmp')).toEqual([
      {
        displaced_xmp: mapleXmp('older send'),
        displaced_sha256: sha256(mapleXmp('older send')),
        incoming_sha256: sha256(mapleXmp('newer edit')),
      },
    ]);
  });
});

describe('a retirement that keeps failing records its kept-aside edit once (#5021)', () => {
  // A read-only folder can't block root's unlink, so the failure can't be forced there.
  test.skipIf(process.getuid?.() === 0)(
    'repeated failing sends do not pile up identical divergence rows',
    async () => {
      const photo = await seedUpload('2024/10/02/IMG_61.HEIC');
      const dir = path.join(tmpLib, '2024/10/02');
      await fs.writeFile(path.join(dir, 'IMG_61.HEIC.xmp'), mapleXmp('older send'));
      await fs.writeFile(path.join(dir, 'IMG_61.xmp'), mapleXmp('newer edit'));
      await fs.chmod(dir, 0o555);
      const statuses = await (async () => {
        try {
          const first = await post(photo, mapleXmp('newer edit'), 'none');
          const second = await post(photo, mapleXmp('newer edit'), 'none');
          return [first.status, second.status];
        } finally {
          await fs.chmod(dir, 0o755);
        }
      })();

      expect(statuses).toEqual([500, 500]);
      expect(keptAside('2024/10/02/IMG_61.xmp')).toHaveLength(1);
    },
  );
});

describe("another photo's sidecar is never taken for an old-name file (#5021)", () => {
  test("a send for IMG.HEIC leaves IMG.HEIC.JPG's sidecar alone", async () => {
    const photo = await seedUpload('2024/11/01/IMG_70.HEIC');
    await fs.writeFile(path.join(tmpLib, '2024/11/01/IMG_70.HEIC.JPG'), Buffer.alloc(8));
    await fs.writeFile(path.join(tmpLib, '2024/11/01/IMG_70.HEIC.xmp'), mapleXmp('jpeg edit'));

    expect((await post(photo, mapleXmp('heic edit'), 'none')).status).toBe(200);
    const noBase = await post(photo, mapleXmp('heic edit again'), undefined);

    expect(await read('2024/11/01/IMG_70.HEIC.xmp')).toBe(mapleXmp('jpeg edit'));
    expect(keptAside('2024/11/01/IMG_70.xmp')).toEqual([]);
    expect((await noBase.json()).skipped).toBe(true);
  });
});

describe('a send only succeeds once the server has recorded the edit (#5021)', () => {
  test('a failed bookkeeping write fails the send before the sidecar lands, and a retry completes it', async () => {
    const photo = await seedUpload('2024/12/01/IMG_80.HEIC');
    live.db.exec('ALTER TABLE asset_changes RENAME TO asset_changes_hidden');
    const failed = await post(photo, mapleXmp('device edit'), 'none').finally(() =>
      live.db.exec('ALTER TABLE asset_changes_hidden RENAME TO asset_changes'),
    );

    expect(failed.status).toBe(500);
    expect(await read('2024/12/01/IMG_80.xmp')).toBeNull();

    const retried = await post(photo, mapleXmp('device edit'), 'none');

    expect(retried.status).toBe(200);
    expect(await read('2024/12/01/IMG_80.xmp')).toBe(mapleXmp('device edit'));
    expect(
      live.db.query(`SELECT has_xmp FROM assets WHERE id = ?`).get(photo.assetId.toHexString()),
    ).toEqual({ has_xmp: 1 });
    expect(
      live.db
        .query(`SELECT kind FROM asset_changes WHERE asset_id = ?`)
        .all(photo.assetId.toHexString()),
    ).toEqual([{ kind: 'update' }, { kind: 'update' }]);
  });
});

describe('a no-base send over something that is not a regular sidecar (#5021)', () => {
  test('a link at the sidecar name is skipped, as before, rather than failing every retry', async () => {
    const photo = await seedUpload('2024/12/02/IMG_81.HEIC');
    const dir = path.join(tmpLib, '2024/12/02');
    await fs.writeFile(path.join(dir, 'elsewhere.xmp'), mapleXmp('linked'));
    await fs.symlink(path.join(dir, 'elsewhere.xmp'), path.join(dir, 'IMG_81.xmp'));

    const res = await post(photo, mapleXmp('device edit'), undefined);

    expect(res.status).not.toBe(500);
    expect(await fs.readFile(path.join(dir, 'elsewhere.xmp'), 'utf8')).toBe(mapleXmp('linked'));
  });
});
