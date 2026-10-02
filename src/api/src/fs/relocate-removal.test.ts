/** #1472: real XMP/companions, real native child, no sidecar mocks. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from './mirrored.ts';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { maple } from 'maple';
import { ffiPool } from '../ffi/ffi-pool.ts';
import { nativeLibAvailable } from '../ffi/raw_ffi.ts';
import { DEFAULT_EXPORT_RECIPE } from '../generated/export-recipe.generated.ts';
import { relocateFile } from './relocate.ts';
import { removalRecords } from './removal-records.ts';
import { moveToTrash, moveOutOfTrash } from './trash.ts';
import { removalJournalPath, recoverRemovalRelocation } from './removal-relocation-journal.ts';

const fixture = resolve(import.meta.dir, '../../../../test-fixtures/removal/calibration');
describe.skipIf(!nativeLibAvailable())('RAW relocation preserves durable removals (#1472)', () => {
  let root: string;
  let raw: string;
  let xmp: string;
  let target: string;
  let mask: string;
  let patch: string;
  let xml: string;
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'maple-removal-relocate-')));
    raw = join(root, 'source/photo.dng');
    xmp = join(root, 'source/photo.xmp');
    target = join(root, 'destination/renamed.dng');
    await fs.mkdir(join(dirname(raw), '.maple/inpaint'), { recursive: true });
    await fs.copyFile(join(fixture, 'source.dng'), raw);
    await fs.copyFile(join(fixture, 'saved.xmp'), xmp);
    xml = await fs.readFile(xmp, 'utf8');
    const [record] = JSON.parse(await fs.readFile(join(fixture, 'records.txt'), 'utf8'));
    mask = join(dirname(raw), '.maple/inpaint', `${record.accepted.mask.slice(7)}.mask`);
    patch = join(dirname(raw), '.maple/inpaint', `${record.patch.slice(7)}.f16`);
    await fs.copyFile(join(fixture, 'mask.mimf'), mask);
    await fs.copyFile(join(fixture, 'patch.f16'), patch);
  });
  afterEach(async () => fs.rm(root, { recursive: true, force: true }));
  afterAll(() => ffiPool().shutdown());

  async function assertDestinationPixels(path: string) {
    const sidecar = path.replace(/\.[^.]+$/, '.xmp');
    expect(await fs.readFile(path)).toEqual(await fs.readFile(join(fixture, 'source.dng')));
    expect(await fs.readFile(sidecar, 'utf8')).toBe(xml);
    const output = join(root, `oracle-${randomUUID()}.png`);
    expect(
      await ffiPool().exportRecipeToFile(
        path,
        xml,
        JSON.stringify({ ...DEFAULT_EXPORT_RECIPE, format: 'png', quality: null }),
        null,
        output,
      ),
    ).toBe(true);
    expect(Buffer.from((await maple(output).toRaw()).data)).toEqual(
      await fs.readFile(join(fixture, 'preview-64.rgb')),
    );
    for (const asset of [mask, patch]) {
      const destination = join(dirname(sidecar), '.maple/inpaint', asset.split('/').at(-1)!);
      expect(await fs.readFile(destination)).toEqual(await fs.readFile(asset));
    }
  }

  for (const mode of ['move', 'copy'] as const) {
    it(`${mode} copies verified assets before identity repoint and reproduces saved pixels`, async () => {
      let repoints = 0;
      const result = await relocateFile({
        sourceAbsPath: raw,
        destAbsPath: target,
        mode,
        collision: 'skip',
        onVerified: async (info) => {
          repoints++;
          expect(info.newAbsPath).toBe(target);
          expect(info.companionPaths).toEqual([]);
          await assertDestinationPixels(target);
          expect(await fs.readFile(raw)).toEqual(await fs.readFile(join(fixture, 'source.dng')));
        },
      });
      expect(result.kind).toBe('relocated');
      expect(repoints).toBe(1);
      if (mode === 'move') {
        await expect(fs.stat(raw)).rejects.toThrow();
        await expect(fs.stat(xmp)).rejects.toThrow();
      } else {
        expect(await fs.readFile(xmp, 'utf8')).toBe(xml);
      }
      // Assets are shared by digest. Relocating one photo never prunes them.
      expect(await fs.readFile(mask)).toEqual(await fs.readFile(join(fixture, 'mask.mimf')));
      expect(await fs.readFile(patch)).toEqual(await fs.readFile(join(fixture, 'patch.f16')));
    }, 30_000);
  }

  it('copies conflict-sidecar assets and retains every foreign XML byte', async () => {
    const conflict = join(dirname(raw), 'photo (conflict from iPad).xmp');
    await fs.writeFile(
      conflict,
      xml.replace('rdf:Description', 'rdf:Description foreign="preserved"'),
    );
    const result = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: target,
      mode: 'copy',
      collision: 'skip',
    });
    expect(result.kind).toBe('relocated');
    expect(await fs.readFile(join(dirname(target), 'renamed (conflict from iPad).xmp'))).toEqual(
      await fs.readFile(conflict),
    );
    await assertDestinationPixels(target);
  }, 30_000);

  for (const mode of ['copy', 'move'] as const)
    it(`${mode} from a read-only source folder preserves the intact accepted edit`, async () => {
      await fs.chmod(dirname(raw), 0o555);
      try {
        const result = await relocateFile({
          sourceAbsPath: raw,
          destAbsPath: target,
          mode,
          collision: 'skip',
        });
        expect(result.kind).toBe('relocated');
        await assertDestinationPixels(target);
        expect(await fs.readFile(raw)).toEqual(await fs.readFile(join(fixture, 'source.dng')));
        expect(await fs.readFile(xmp, 'utf8')).toBe(xml);
      } finally {
        await fs.chmod(dirname(raw), 0o755);
      }
    }, 30_000);

  it('retains disabled schema-5 assets so the moved edit can be re-enabled', async () => {
    const [record] = JSON.parse(await fs.readFile(join(fixture, 'records.txt'), 'utf8'));
    const active = { ...record, schema: 5, id: record.patch, active: true };
    const wire = JSON.stringify([{ ...active, active: false }]).replaceAll('"', '&quot;');
    xml = xml.replace(/papp:InpaintRemovals="[^"]*"/, `papp:InpaintRemovals="${wire}"`);
    await fs.writeFile(xmp, xml);
    const result = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: target,
      mode: 'move',
      collision: 'skip',
    });
    expect(result.kind).toBe('relocated');
    expect(await fs.readFile(target.replace('.dng', '.xmp'), 'utf8')).toBe(xml);
    for (const asset of [mask, patch])
      expect(
        await fs.readFile(join(dirname(target), '.maple/inpaint', asset.split('/').at(-1)!)),
      ).toEqual(await fs.readFile(asset));
    xml = xml.replace('&quot;active&quot;:false', '&quot;active&quot;:true');
    await fs.writeFile(target.replace('.dng', '.xmp'), xml);
    await assertDestinationPixels(target);
  }, 30_000);

  it('refuses a companion-directory symlink without writing outside the destination', async () => {
    const outside = join(root, 'outside');
    await fs.mkdir(outside);
    await fs.mkdir(dirname(target));
    await fs.symlink(outside, join(dirname(target), '.maple'));
    const result = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: target,
      mode: 'move',
      collision: 'skip',
    });
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.error).toContain('must not be a link');
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await fs.readFile(raw)).toEqual(await fs.readFile(join(fixture, 'source.dng')));
    expect(await fs.readFile(xmp, 'utf8')).toBe(xml);
    await expect(fs.stat(target)).rejects.toThrow();
  }, 30_000);

  it('late destination edits after repoint preserve both originals and the later edit', async () => {
    const later = xml.replace('rdf:Description', 'rdf:Description Later="destination-edit"');
    const result = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: target,
      mode: 'move',
      collision: 'skip',
      onVerified: async () => {
        await fs.writeFile(target.replace('.dng', '.xmp'), later);
      },
    });
    expect(result.kind).toBe('error');
    expect(await fs.readFile(target.replace('.dng', '.xmp'), 'utf8')).toBe(later);
    expect(await fs.readFile(raw)).toEqual(await fs.readFile(join(fixture, 'source.dng')));
    expect(await fs.readFile(xmp, 'utf8')).toBe(xml);
    expect(await fs.readFile(target)).toEqual(await fs.readFile(raw));
  }, 30_000);

  for (const failure of [
    'missing-mask',
    'corrupt-patch',
    'changed-original',
    'future-schema',
    'corrupt-destination-asset',
  ] as const) {
    it(`${failure} leaves source and previous destination intact without repointing`, async () => {
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, 'previous occupant');
      const targetSidecar = target.replace('.dng', '.xmp');
      await fs.writeFile(targetSidecar, 'previous edits');
      if (failure === 'missing-mask') await fs.rm(mask);
      if (failure === 'corrupt-patch') await fs.writeFile(patch, 'corrupt');
      if (failure === 'changed-original') await fs.appendFile(raw, Buffer.from([0]));
      if (failure === 'future-schema') {
        xml = xml.replace('&quot;schema&quot;:4', '&quot;schema&quot;:99');
        await fs.writeFile(xmp, xml);
      }
      if (failure === 'corrupt-destination-asset') {
        const assets = join(dirname(target), '.maple/inpaint');
        await fs.mkdir(assets, { recursive: true });
        await fs.writeFile(join(assets, patch.split('/').at(-1)!), 'corrupt');
      }
      const source = await fs.readFile(raw);
      let repoints = 0;
      const result = await relocateFile({
        sourceAbsPath: raw,
        destAbsPath: target,
        mode: 'move',
        collision: 'replace',
        onVerified: async () => {
          repoints++;
        },
      });
      expect(result.kind).toBe('error');
      expect(repoints).toBe(0);
      expect(await fs.readFile(raw)).toEqual(source);
      expect(await fs.readFile(xmp, 'utf8')).toBe(xml);
      expect(await fs.readFile(target, 'utf8')).toBe('previous occupant');
      expect(await fs.readFile(targetSidecar, 'utf8')).toBe('previous edits');
      expect((await fs.readdir(dirname(target))).filter((name) => name.includes('.tmp.'))).toEqual(
        [],
      );
    }, 30_000);
  }

  it('unconfirmed identity repoint retains both complete edits and recovery evidence', async () => {
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, 'previous occupant');
    await fs.writeFile(target.replace('.dng', '.xmp'), 'previous edits');
    const result = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: target,
      mode: 'move',
      collision: 'replace',
      onVerified: async () => {
        throw new Error('repoint refused');
      },
    });
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.error).toContain('repoint refused');
    await assertDestinationPixels(target);
    expect(await fs.readFile(raw)).toEqual(await fs.readFile(join(fixture, 'source.dng')));
    expect(await fs.readFile(xmp, 'utf8')).toBe(xml);
    expect(await fs.stat(removalJournalPath(target))).toBeDefined();
    expect(
      (await fs.readdir(dirname(target))).filter((name) => name.endsWith('.rollback')),
    ).toHaveLength(2);
    await recoverRemovalRelocation(target);
    await assertDestinationPixels(target);
    await expect(fs.stat(removalJournalPath(target))).rejects.toThrow();
  }, 30_000);

  it('later source edits after identity repoint retain both complete copies', async () => {
    const later = xml.replace('rdf:Description', 'rdf:Description Later="new-edit"');
    const result = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: target,
      mode: 'move',
      collision: 'skip',
      onVerified: async () => {
        await fs.writeFile(xmp, later);
      },
    });
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.error).toContain('sidecars changed');
    expect(await fs.readFile(xmp, 'utf8')).toBe(later);
    expect(await fs.readFile(raw)).toEqual(await fs.readFile(join(fixture, 'source.dng')));
    await assertDestinationPixels(target);
  }, 30_000);

  it('same-folder extension rename retains its shared sidecar and assets', async () => {
    target = raw.replace('.dng', '.DNG');
    // On case-insensitive hosts this takes the established case-only path;
    // on case-sensitive hosts this is a different primary with one sidecar.
    const result = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: target,
      mode: 'move',
      collision: 'skip',
    });
    expect(result.kind).toBe('relocated');
    expect(await fs.readFile(xmp, 'utf8')).toBe(xml);
    expect(await fs.readFile(mask)).toEqual(await fs.readFile(join(fixture, 'mask.mimf')));
  }, 30_000);

  it('trash and restore carry the accepted assets through the established primitives', async () => {
    const trashed = await moveToTrash(raw, root);
    expect(trashed.kind).toBe('ok');
    if (trashed.kind !== 'ok') throw new Error('Trash did not publish a path');
    await assertDestinationPixels(trashed.newAbsPath);
    const restored = await moveOutOfTrash(trashed.newAbsPath, raw);
    expect(restored.kind).toBe('ok');
    if (restored.kind !== 'ok') throw new Error('Restore did not publish a path');
    expect(restored.newAbsPath).toBe(raw);
    await assertDestinationPixels(raw);
    expect(await fs.readFile(xmp, 'utf8')).toBe(xml);
  }, 30_000);
});

describe('removal XMP discovery uses namespace identity', () => {
  const value = '[{"kind":"removal"}]';
  const escaped = value.replaceAll('"', '&quot;');
  const ns =
    'xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:m="http://ns.justmaple.app/photo/1.0/"';
  it('reads canonical attributes and scalar elements with arbitrary prefixes', () => {
    expect(removalRecords(`<r:Description ${ns} m:InpaintRemovals="${escaped}"/>`)).toBe(value);
    expect(
      removalRecords(
        `<r:Description ${ns}><m:InpaintRemovals><![CDATA[${value}]]></m:InpaintRemovals></r:Description>`,
      ),
    ).toBe(value);
    expect(
      removalRecords(
        '<r:Description xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:m="urn:foreign" m:InpaintRemovals="opaque"/>',
      ),
    ).toBeNull();
  });
  it('rejects ambiguous, nested or malformed removal sidecars', () => {
    expect(() =>
      removalRecords(
        `<r:Description ${ns} m:InpaintRemovals="${escaped}"><m:InpaintRemovals>${escaped}</m:InpaintRemovals></r:Description>`,
      ),
    ).toThrow('Conflicting');
    expect(() =>
      removalRecords(
        `<r:Description ${ns}><m:InpaintRemovals><r:Bag/></m:InpaintRemovals></r:Description>`,
      ),
    ).toThrow('scalar');
    expect(() => removalRecords(`<r:Description ${ns}><m:InpaintRemovals>`)).toThrow();
  });
});
