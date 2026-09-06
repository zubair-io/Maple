import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, readFile, rm } from '../fs/mirrored.ts';
import { closeDb } from '../db/client.ts';
import { withTestDb, tryConnectTestMongo } from '../db/test-db.test-helpers.ts';
import { nativeLibAvailable } from '../ffi/raw_ffi.ts';
import { ffiPool, _resetFfiPoolForTests } from '../ffi/ffi-pool.ts';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { lensProfileRoutes } from '../routes/lens-profiles.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import {
  lensExportFixture,
  lensExportProfile,
} from '../../../web/scripts/lib/cold-export-fixture.ts';

withTestDb(`maple_test_lcp_export_${process.pid}`);
let mongoAvailable = false;
beforeAll(async () => {
  const client = await tryConnectTestMongo();
  mongoAvailable = client !== null;
  await client?.close();
});
afterAll(async () => {
  restartChild();
  await closeDb();
});

function restartChild(): void {
  ffiPool().shutdown();
  _resetFfiPoolForTests();
}

function snapshot(reference: string, enabled = 1, strength = 100): string {
  return `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:papp="http://ns.justmaple.app/photo/1.0/"
    crs:LensProfileEnable="${enabled}" papp:LensProfile="${reference}"
    crs:LensProfileDistortionScale="${strength}" crs:LensProfileChromaticAberrationScale="${strength}"
    crs:LensProfileVignettingScale="${strength}"/></rdf:RDF>`;
}

test.skipIf(!nativeLibAvailable())(
  'cold recipe child restores the captured profile and ignores a different current sidecar',
  async () => {
    if (!mongoAvailable) return;
    const dir = await mkdtemp(join(tmpdir(), 'maple-lcp-export-'));
    const fixture = resolve(
      import.meta.dir,
      '../../../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng',
    );
    const original = lensExportFixture(fixture);
    const raw = join(dir, 'capture.dng');
    const recipe = JSON.stringify({ ...DEFAULT_EXPORT_RECIPE, maxLongEdge: 64 });
    const render = (xml: string, name: string) =>
      ffiPool().exportRecipeToFile(raw, xml, recipe, null, join(dir, name));
    try {
      await writeFile(raw, original);
      const app = new Elysia().use(fakeAuth()).use(lensProfileRoutes);
      const form = new FormData();
      form.set('file', new File([lensExportProfile(-0.4)], 'authored.lcp'));
      const imported = await app.handle(
        new Request('http://localhost/api/lens-profiles', { method: 'POST', body: form }),
      );
      expect(imported.status).toBe(200);
      const { reference } = (await imported.json()) as { reference: string };
      const captured = snapshot(reference.replace('lcp1:', 'lcp1-ack:'));
      const missing = `lcp1:${'0'.repeat(64)}`;
      // The current sidecar is deliberately unusable. Only the queued XML is authoritative.
      await writeFile(join(dir, 'capture.xmp'), snapshot(missing));
      restartChild();
      await render('', 'base.jpg');
      restartChild();
      await render(captured, 'corrected.jpg');
      const baseline = await readFile(join(dir, 'base.jpg'));
      const corrected = await readFile(join(dir, 'corrected.jpg'));
      expect(corrected).not.toEqual(baseline);
      expect(corrected.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(corrected.includes(Buffer.from('ICC_PROFILE'))).toBe(true);
      // A second cold child must restore the same exact bytes deterministically.
      restartChild();
      await render(captured, 'resumed.jpg');
      expect(await readFile(join(dir, 'resumed.jpg'))).toEqual(corrected);
      await expect(render(snapshot(missing), 'missing.jpg')).rejects.toThrow(
        'not in the local cache',
      );
      await render(snapshot(missing, 0), 'off.jpg');
      expect(await readFile(join(dir, 'off.jpg'))).toEqual(baseline);
      await render(snapshot(missing, 1, 0), 'zero.jpg');
      expect(await readFile(join(dir, 'zero.jpg'))).toEqual(baseline);
      expect(await readFile(raw)).toEqual(Buffer.from(original));
    } finally {
      restartChild();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
