/** Real portable variant files follow Self Hosted originals (#4044 / #2437). */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from './mirrored';
import * as os from 'node:os';
import * as path from 'node:path';
import { callNative } from 'maple';
import { canonicalBaseFromSidecarFilename } from './browse';
import { commitWorkflowVariant } from './workflow-variants';
import { writeXmpAtomic } from './xmp';
import { listPairedSidecarsStrict } from './xmp-conflict';
import { relocateFile, sidecarRenameTarget } from './relocate';
import { moveToTrash, moveOutOfTrash } from './trash';
import { moveToDuplicates } from './duplicates';
import { clearMirrorRoots, setMirrorRoots } from './mirror-registry';
import { registerRoot, unregisterRoot } from './root';

const ID = '00000000-0000-0000-0000-000000000064';
const OTHER = '00000000-0000-0000-0000-000000000065';
const XML =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Temperature="5200"><crs:MaskGroup><rdf:Seq><rdf:li>foreign mask &amp; history</rdf:li></rdf:Seq></crs:MaskGroup></rdf:Description></rdf:RDF></x:xmpmeta>';
let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maple-workflow-lifecycle-')));
  registerRoot(root);
});
afterEach(async () => {
  await fs.flushPendingMirrorOps();
  clearMirrorRoots();
  unregisterRoot(root);
  await fs.rm(root, { recursive: true, force: true });
});

async function stage(dir: string, name: string, id = ID) {
  const location = path.join(root, dir);
  await fs.mkdir(location, { recursive: true });
  const primary = path.join(location, name);
  const base = name.endsWith('.MOV') ? name : path.parse(name).name;
  const sidecar = path.join(location, base + '.xmp');
  const variant = path.join(location, base + '.v' + id + '.xmp');
  const result = await callNative('workflowEmbedXmp', [
    JSON.stringify({
      schemaVersion: 1,
      variantId: id,
      variantName: 'Alternate',
      snapshots: [],
      history: [],
    }),
    XML,
  ]);
  if (!result.ok) throw Error(result.error);
  const original = 'original bytes: ' + dir + '/' + name;
  await fs.writeFile(primary, original);
  await fs.writeFile(sidecar, XML);
  await fs.writeFile(variant, result.value);
  return { primary, sidecar, variant, xml: result.value, original };
}
async function expectVariant(file: string, xml: string, id = ID) {
  expect(await fs.readFile(file, 'utf8')).toBe(xml);
  const record = await callNative('workflowReadXmp', [xml]);
  if (!record.ok) throw Error(record.error);
  expect(JSON.parse(record.value).variantId).toBe(id);
}

describe('portable variant asset lifecycle', () => {
  // Repeated independent real sidecars expose the intermittent Linux writer race (#4051).
  test.each(Array.from({ length: 100 }, (_, round) => round))(
    'mixed concurrent ordinary and semantic writers retain the admitted action (round %i)',
    async () => {
      const source = await stage('mixed-writers', 'photo.dng');
      const initial = await callNative('workflowEmbedXmp', [
        JSON.stringify({
          schemaVersion: 1,
          variantId: 'primary',
          variantName: 'Primary',
          snapshots: [],
          history: [],
        }),
        XML,
      ]);
      if (!initial.ok) throw Error(initial.error);
      const checkpoint = await callNative('workflowCheckpointXmp', [initial.value]);
      if (!checkpoint.ok) throw Error(checkpoint.error);
      await fs.writeFile(source.sidecar, initial.value);
      const entries = Array.from({ length: 8 }, (_, index) => ({
        id: crypto.randomUUID(),
        createdAtMs: index + 1,
        action: 'preset',
        label: `Preset ${index + 1}`,
        adjustmentXmp: checkpoint.value,
      }));
      const semantic = entries.map((entry) =>
        commitWorkflowVariant(source.primary, 'primary', initial.value, initial.value, entry),
      );
      const ordinary = Array.from({ length: 8 }, () =>
        writeXmpAtomic(source.primary, initial.value),
      );
      const [results, ordinaryResults] = await Promise.all([
        Promise.allSettled(semantic),
        Promise.all(ordinary),
      ]);
      if (
        results.filter((result) => result.status === 'fulfilled').length !== 1 ||
        ordinaryResults.some((result) => !result.ok)
      ) {
        const saved = await fs.readFile(source.sidecar, 'utf8').then(
          (xml) => ({ xml }),
          (error: unknown) => ({ readError: String(error) }),
        );
        const diagnostics = {
          runtime: { bun: Bun.version, platform: process.platform },
          primary: source.primary,
          sidecar: source.sidecar,
          expectedXmp: initial.value,
          savedSidecar: saved,
          semantic: results.map((result, index) => ({
            entry: entries[index],
            status: result.status,
            ...(result.status === 'fulfilled'
              ? { outputXmp: result.value }
              : { error: String(result.reason), stack: result.reason?.stack }),
          })),
          ordinaryResults,
        };
        console.error('Actual mixed-writer failure:', JSON.stringify(diagnostics));
      }
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(ordinaryResults.every((result) => result.ok)).toBe(true);
      const saved = await fs.readFile(source.sidecar, 'utf8');
      const record = await callNative('workflowReadXmp', [saved]);
      if (!record.ok) throw Error(record.error);
      const history = JSON.parse(record.value).history;
      const winner = results.findIndex((result) => result.status === 'fulfilled');
      expect(history).toEqual([entries[winner]]);
      expect(await fs.readFile(source.primary, 'utf8')).toBe(source.original);
    },
  );

  test('an ordinary cached Workflow payload cannot replace newer semantic history', async () => {
    const source = await stage('cached-history', 'photo.dng');
    const embedded = await callNative('workflowEmbedXmp', [
      JSON.stringify({
        schemaVersion: 1,
        variantId: 'primary',
        variantName: 'Primary',
        snapshots: [],
        history: [],
      }),
      XML,
    ]);
    if (!embedded.ok) throw Error(embedded.error);
    const older = embedded.value;
    await fs.writeFile(source.sidecar, older);
    const captured = await callNative('workflowCheckpointXmp', [older]);
    if (!captured.ok) throw Error(captured.error);
    const entry = {
      id: crypto.randomUUID(),
      createdAtMs: 1,
      action: 'adjustment',
      label: 'Exposure',
      adjustmentXmp: captured.value,
    };
    await commitWorkflowVariant(source.primary, 'primary', older, older, entry);
    const ordinary = older.replace(
      'crs:Temperature="5200"',
      'crs:Temperature="5200" crs:Exposure2012="1.25"',
    );
    expect((await writeXmpAtomic(source.primary, ordinary)).ok).toBe(true);
    const saved = await fs.readFile(source.sidecar, 'utf8');
    const record = await callNative('workflowReadXmp', [saved]);
    if (!record.ok) throw Error(record.error);
    expect(JSON.parse(record.value).history).toEqual([entry]);
    expect(saved).toContain('crs:Exposure2012="1.25"');
    expect(saved).toContain('<crs:MaskGroup>');
    expect(await fs.readFile(source.primary, 'utf8')).toBe(source.original);
    await expectVariant(source.variant, source.xml);
  });

  test('pairing and trash preserve a UUID sidecar belonging to a differently cased stem', async () => {
    const source = await stage('case', 'IMG_1.dng');
    const foreign = path.join(path.dirname(source.primary), 'img_1.v' + OTHER + '.xmp');
    const foreignXml = source.xml.replaceAll(ID, OTHER);
    await fs.writeFile(foreign, foreignXml);
    const paired = await listPairedSidecarsStrict(source.primary);
    expect(paired.toSorted()).toEqual([source.sidecar, source.variant].toSorted());
    const trash = await moveToTrash(source.primary, root);
    if (trash.kind !== 'ok') throw Error(trash.error);
    expect(await fs.readFile(trash.newAbsPath, 'utf8')).toBe(source.original);
    await expectVariant(
      sidecarRenameTarget(source.primary, trash.newAbsPath, source.variant)!,
      source.xml,
    );
    expect(await fs.readFile(foreign, 'utf8')).toBe(foreignXml);
    await fs.access(foreign);
    await expect(fs.access(source.variant)).rejects.toThrow();
  });

  test('browse pairing associates canonical photo/video UUID siblings with distinct originals', () => {
    expect(canonicalBaseFromSidecarFilename('photo.v' + ID + '.xmp')).toBe('photo');
    expect(canonicalBaseFromSidecarFilename('photo.MOV.v' + ID + '.xmp')).toBe('photo.MOV');
    expect(canonicalBaseFromSidecarFilename('photo.v2.xmp')).toBe('photo.v2');
    expect(canonicalBaseFromSidecarFilename('photo.v' + ID + '.xmp.bak')).toBeNull();
  });
  for (const mode of ['move', 'copy'] as const) {
    test(
      mode + ' carries primary and independent variant bytes after a renamed photo',
      async () => {
        const photo = await stage('source', 'photo.dng');
        const target = path.join(root, 'target', 'renamed.dng');
        expect(
          (
            await relocateFile({
              sourceAbsPath: photo.primary,
              destAbsPath: target,
              mode,
              collision: 'auto-suffix',
            })
          ).kind,
        ).toBe('relocated');
        expect(await fs.readFile(target, 'utf8')).toBe(photo.original);
        expect(await fs.readFile(path.join(root, 'target', 'renamed.xmp'), 'utf8')).toBe(XML);
        await expectVariant(path.join(root, 'target', 'renamed.v' + ID + '.xmp'), photo.xml);
        expect(await fs.exists(photo.variant)).toBe(mode === 'copy');
        expect(await fs.exists(photo.primary)).toBe(mode === 'copy');
      },
    );
  }
  test('discovery excludes malformed identities, backups and same-stem video variants', async () => {
    const photo = await stage('source', 'photo.dng');
    const video = await stage('source', 'photo.MOV', OTHER);
    const excluded = [
      'photo.v2.xmp',
      'photo.v' + ID + '.xmp.bak',
      'photo.v00000000-0000-0000-0000-00000000006A.xmp',
      'photo.v00000000-0000-0000-0000-00000000006z.xmp',
      'photos.v' + ID + '.xmp',
    ];
    for (const name of excluded) await fs.writeFile(path.join(root, 'source', name), XML);
    expect((await listPairedSidecarsStrict(photo.primary)).sort()).toEqual(
      [photo.sidecar, photo.variant].sort(),
    );
    expect((await listPairedSidecarsStrict(video.primary)).sort()).toEqual(
      [video.sidecar, video.variant].sort(),
    );
    expect(
      (
        await relocateFile({
          sourceAbsPath: photo.primary,
          destAbsPath: path.join(root, 'target', 'photo.dng'),
          mode: 'move',
          collision: 'auto-suffix',
        })
      ).kind,
    ).toBe('relocated');
    for (const name of excluded)
      expect(await fs.readFile(path.join(root, 'source', name), 'utf8')).toBe(XML);
    await expectVariant(video.variant, video.xml, OTHER);
  });
  test('case-only rename retains identity and changes each branch basename', async () => {
    const photo = await stage('source', 'photo.dng');
    const target = path.join(root, 'source', 'PHOTO.DNG');
    expect(
      (
        await relocateFile({
          sourceAbsPath: photo.primary,
          destAbsPath: target,
          mode: 'move',
          collision: 'auto-suffix',
        })
      ).kind,
    ).toBe('relocated');
    const entries = await fs.readdir(path.join(root, 'source'));
    expect(entries).toContain('PHOTO.v' + ID + '.xmp');
    expect(entries).not.toContain(path.basename(photo.variant));
    await expectVariant(path.join(root, 'source', 'PHOTO.v' + ID + '.xmp'), photo.xml);
  });
  test('duplicate quarantine keeps branches with collision-suffixed originals', async () => {
    const first = await stage('source', 'photo.dng');
    const moved = await moveToDuplicates(first.primary, root);
    if (moved.kind !== 'ok') throw Error(moved.error);
    const second = await stage('source', 'photo.dng', OTHER);
    const secondMoved = await moveToDuplicates(second.primary, root);
    if (secondMoved.kind !== 'ok') throw Error(secondMoved.error);
    expect(secondMoved.newAbsPath).not.toBe(moved.newAbsPath);
    await expectVariant(
      sidecarRenameTarget(first.primary, moved.newAbsPath, first.variant)!,
      first.xml,
    );
    await expectVariant(
      sidecarRenameTarget(second.primary, secondMoved.newAbsPath, second.variant)!,
      second.xml,
      OTHER,
    );
    expect(await fs.exists(first.variant)).toBe(false);
    expect(await fs.exists(second.variant)).toBe(false);
  });

  test('video extension changes keep full-name primary and variant convention', async () => {
    const video = await stage('source', 'photo.MOV');
    const target = path.join(root, 'target', 'renamed.mp4');
    expect(sidecarRenameTarget(video.primary, target, video.variant)).toBe(
      path.join(root, 'target', 'renamed.mp4.v' + ID + '.xmp'),
    );
    expect(
      (
        await relocateFile({
          sourceAbsPath: video.primary,
          destAbsPath: target,
          mode: 'move',
          collision: 'auto-suffix',
        })
      ).kind,
    ).toBe('relocated');
    await expectVariant(path.join(root, 'target', 'renamed.mp4.v' + ID + '.xmp'), video.xml);
    expect(await fs.readFile(target + '.xmp', 'utf8')).toBe(XML);
  });
  test('video derived previews retain their separate stem-based rename convention', async () => {
    const video = await stage('source', 'photo.MOV');
    const companion = path.join(root, 'source', 'photo.preview.avif');
    await fs.writeFile(companion, 'derived preview');
    const target = path.join(root, 'target', 'renamed.mp4');
    const outcome = await relocateFile({
      sourceAbsPath: video.primary,
      destAbsPath: target,
      mode: 'move',
      collision: 'auto-suffix',
      extraCompanionAbsPaths: [companion],
    });
    expect(outcome.kind).toBe('relocated');
    expect(await fs.readFile(path.join(root, 'target', 'renamed.preview.avif'), 'utf8')).toBe(
      'derived preview',
    );
    await expectVariant(path.join(root, 'target', 'renamed.mp4.v' + ID + '.xmp'), video.xml);
  });

  test('trash/restore retain branches and an orphan variant occupies a restore stem', async () => {
    const photo = await stage('source', 'photo.dng');
    const trash = await moveToTrash(photo.primary, root);
    if (trash.kind !== 'ok') throw Error(trash.error);
    const trashedVariant = sidecarRenameTarget(photo.primary, trash.newAbsPath, photo.variant)!;
    await expectVariant(trashedVariant, photo.xml);
    expect(await fs.exists(photo.variant)).toBe(false);
    await fs.writeFile(photo.variant, 'unrelated orphan branch');
    expect(await moveOutOfTrash(trash.newAbsPath, photo.primary)).toEqual({
      kind: 'ok',
      newAbsPath: path.join(root, 'source', 'photo.restored.dng'),
    });
    expect(await fs.readFile(photo.variant, 'utf8')).toBe('unrelated orphan branch');
    await expectVariant(path.join(root, 'source', 'photo.restored.v' + ID + '.xmp'), photo.xml);
    expect(await fs.exists(trashedVariant)).toBe(false);
  });
  test('concurrent restores publish distinct original/variant pairs without overwriting', async () => {
    const sources = await Promise.all(
      Array.from({ length: 8 }, (_, n) => stage('trash/' + n, 'photo.dng')),
    );
    const target = path.join(root, 'restore', 'photo.dng');
    const outcomes = await Promise.all(
      sources.map((source) => moveOutOfTrash(source.primary, target)),
    );
    const destinations = new Set<string>();
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.kind !== 'ok') throw Error(outcome.error);
      expect(destinations.has(outcome.newAbsPath)).toBe(false);
      destinations.add(outcome.newAbsPath);
      expect(await fs.readFile(outcome.newAbsPath, 'utf8')).toBe(sources[index].original);
      await expectVariant(
        sidecarRenameTarget(sources[index].primary, outcome.newAbsPath, sources[index].variant)!,
        sources[index].xml,
      );
      expect(await fs.exists(sources[index].variant)).toBe(false);
    }
    expect(destinations.size).toBe(sources.length);
    expect(
      (await fs.readdir(root, { recursive: true })).some((name) => name.includes('.tmp.')),
    ).toBe(false);
  });
  test('verified branch copies and deletion replicate to the configured mirror', async () => {
    const mirror = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-workflow-mirror-'));
    setMirrorRoots({ [root]: [mirror] });
    try {
      const photo = await stage('source', 'photo.dng');
      await fs.flushPendingMirrorOps();
      expect(
        (
          await relocateFile({
            sourceAbsPath: photo.primary,
            destAbsPath: path.join(root, 'target', 'renamed.dng'),
            mode: 'move',
            collision: 'auto-suffix',
          })
        ).kind,
      ).toBe('relocated');
      await fs.flushPendingMirrorOps();
      await expectVariant(path.join(mirror, 'target', 'renamed.v' + ID + '.xmp'), photo.xml);
      expect(await fs.exists(path.join(mirror, 'source', path.basename(photo.variant)))).toBe(
        false,
      );
    } finally {
      await fs.flushPendingMirrorOps();
      clearMirrorRoots();
      await fs.rm(mirror, { recursive: true, force: true });
    }
  });
});
