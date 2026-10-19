/**
 * Shared-sidecar ownership rule (#4692) against real temp directories. The
 * relocate cases shared with Apple and Windows live in the parity corpus
 * (`test-fixtures/file-operations/cases.json`); this file covers the API-only
 * surfaces — trash, restore, the duplicates mover, and saves that land while
 * a move is in flight.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from './mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { relocateFile } from './relocate.ts';
import { moveToTrash, moveOutOfTrash } from './trash.ts';
import { moveToDuplicates } from './duplicates.ts';
import { serializeSidecarWrite } from './sidecar-write-order.ts';
import {
  sidecarStemClaimedBySibling,
  assetDestinationOccupied,
  sameSidecarFile,
  joinCarriedSidecar,
  SidecarCollisionError,
} from './sidecar-ownership.ts';

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-ownership-')));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const abs = (rel: string) => path.join(root, ...rel.split('/'));

async function settledWithin<T>(
  pending: Promise<T>[],
  ms = 2000,
): Promise<PromiseSettledResult<T>[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('sidecar barriers deadlocked')), ms);
  });
  try {
    return await Promise.race([Promise.allSettled(pending), deadlock]);
  } finally {
    clearTimeout(timer);
  }
}

async function write(rel: string, content: string): Promise<string> {
  await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
  await fs.writeFile(abs(rel), content);
  return abs(rel);
}

async function tree(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else
        out[path.relative(root, full).split(path.sep).join('/')] = await fs.readFile(full, 'utf8');
    }
  }
  await walk(root);
  return out;
}

/** The same barrier `writeXmpAtomic` / `updateXmpAtomic` publish under. */
function save(sidecar: string, xml: string): Promise<void> {
  return serializeSidecarWrite(sidecar, (destination) => fs.writeFile(destination, xml));
}

describe('sidecarStemClaimedBySibling', () => {
  test('a same-stem photo claims the stem; sidecars, temps, dotfiles and departing files do not', async () => {
    const raw = await write('a/IMG_1.CR3', 'raw');
    await write('a/IMG_1.xmp', '<x/>');
    await write('a/IMG_1.xmp.tmp.1-ab', 'tmp');
    await write('a/.IMG_1.CR3', 'apple-double');
    expect(await sidecarStemClaimedBySibling(raw)).toBe(false);
    const jpg = await write('a/img_1.JPG', 'jpg');
    expect(await sidecarStemClaimedBySibling(raw)).toBe(true);
    expect(await sidecarStemClaimedBySibling(raw, [jpg])).toBe(false);
  });

  test('a real photo whose name contains .tmp. still claims the stem', async () => {
    const raw = await write('a/IMG.tmp.CR3', 'raw');
    await write('a/IMG.tmp.CR3.tmp.123-ab12', 'staging');
    expect(await sidecarStemClaimedBySibling(raw)).toBe(false);
    await write('a/IMG.tmp.JPG', 'jpg');
    expect(await sidecarStemClaimedBySibling(raw)).toBe(true);
  });

  test('videos keep their full name, so a same-stem photo is not a sibling', async () => {
    const mov = await write('a/IMG_1.MOV', 'mov');
    await write('a/IMG_1.HEIC', 'heic');
    expect(await sidecarStemClaimedBySibling(mov)).toBe(false);
  });
});

describe('sameSidecarFile', () => {
  test('a case-only difference is one file only where the filesystem folds case', async () => {
    const lower = await write('a/photo.xmp', '<x/>');
    const upper = abs('a/PHOTO.xmp');
    const foldsCase = await fs.exists(upper);
    expect(await sameSidecarFile(lower, lower)).toBe(true);
    expect(await sameSidecarFile(lower, upper)).toBe(foldsCase);
    expect(await sameSidecarFile(lower, abs('a/other.xmp'))).toBe(false);
  });
});

describe('assetDestinationOccupied', () => {
  test("an orphan sidecar occupies the name, the moving asset's own sidecar does not", async () => {
    const own = await write('a/X.xmp', '<own/>');
    expect(await assetDestinationOccupied(abs('a/X.DNG'), [own])).toBe(false);
    expect(await assetDestinationOccupied(abs('a/X.DNG'), [])).toBe(true);
  });
});

describe('batch moves', () => {
  test('moving both halves of a RAW+JPEG pair keeps them on one stem with one sidecar', async () => {
    const raw = await write('a/IMG_1.CR3', 'raw');
    const jpg = await write('a/IMG_1.JPG', 'jpg');
    await write('a/IMG_1.xmp', '<shared/>');
    for (const source of [raw, jpg]) {
      const outcome = await relocateFile({
        sourceAbsPath: source,
        destAbsPath: abs(`b/${path.basename(source)}`),
        mode: 'move',
        collision: 'auto-suffix',
      });
      expect(outcome.kind).toBe('relocated');
    }
    expect(await tree()).toEqual({
      'b/IMG_1.CR3': 'raw',
      'b/IMG_1.JPG': 'jpg',
      'b/IMG_1.xmp': '<shared/>',
    });
  });

  test('joins through two symlinked aliases of one folder do not deadlock', async () => {
    const source = await write('a/IMG_1.xmp', '<shared/>');
    const dest = await write('b/IMG_1.xmp', '<shared/>');
    await fs.symlink(abs('b'), abs('0-alias'));
    const results = await Promise.all([
      joinCarriedSidecar(source, dest),
      joinCarriedSidecar(abs('0-alias/IMG_1.xmp'), source),
    ]);
    expect(results.map((r) => r.toString())).toEqual(['<shared/>', '<shared/>']);
  });

  test('a join of a sidecar with itself takes one barrier instead of waiting on itself', async () => {
    const sidecar = await write('a/IMG_1.xmp', '<shared/>');
    expect((await joinCarriedSidecar(sidecar, sidecar)).toString()).toBe('<shared/>');
  });

  test('a join through a file symlink to the same sidecar settles instead of waiting on itself', async () => {
    const sidecar = await write('a/IMG_1.xmp', '<shared/>');
    await fs.symlink(sidecar, abs('a/IMG_2.xmp'));
    const [outcome] = await settledWithin([joinCarriedSidecar(sidecar, abs('a/IMG_2.xmp'))]);
    expect(outcome?.status).toBe('rejected');
  });

  test('crossed joins through file symlinks to two sidecars do not deadlock', async () => {
    const a = await write('d/a.xmp', '<shared/>');
    const b = await write('d/b.xmp', '<shared/>');
    await fs.symlink(a, abs('d/y.xmp'));
    await fs.symlink(b, abs('d/z.xmp'));
    const outcomes = await settledWithin([
      joinCarriedSidecar(a, abs('d/z.xmp')),
      joinCarriedSidecar(b, abs('d/y.xmp')),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
  });

  // A real bind mount needs root; a symlinked parent is the unprivileged stand-in
  // for two directory paths that reach one folder.
  test('crossed joins through two paths to one folder do not deadlock', async () => {
    const a = await write('real/a.xmp', '<shared/>');
    const b = await write('real/b.xmp', '<shared/>');
    await fs.symlink(abs('real'), abs('mount'));
    const outcomes = await settledWithin([
      joinCarriedSidecar(a, abs('mount/b.xmp')),
      joinCarriedSidecar(b, abs('mount/a.xmp')),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  test('a join whose destination changed under its barrier becomes a collision', async () => {
    const source = await write('a/IMG_1.xmp', '<shared/>');
    const dest = await write('b/IMG_1.xmp', '<edited-since/>');
    await expect(joinCarriedSidecar(source, dest)).rejects.toBeInstanceOf(SidecarCollisionError);
    await write('b/IMG_1.xmp', '<shared/>');
    expect((await joinCarriedSidecar(source, dest)).toString()).toBe('<shared/>');
  });

  test('on a case-sensitive volume a/ and A/ are different folders', async () => {
    await write('probe', 'x');
    if (await fs.exists(abs('PROBE'))) return;
    await fs.rm(abs('probe'));
    const raw = await write('a/X.CR3', 'raw');
    await write('a/X.xmp', '<mine/>');
    await write('A/X.xmp', '<theirs/>');
    const outcome = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: abs('A/X.CR3'),
      mode: 'move',
      collision: 'auto-suffix',
    });
    expect(outcome).toMatchObject({ kind: 'relocated', newAbsPath: abs('A/X.1.CR3') });
    expect(await tree()).toEqual({
      'A/X.xmp': '<theirs/>',
      'A/X.1.CR3': 'raw',
      'A/X.1.xmp': '<mine/>',
    });
  });

  test('a destination sidecar with different bytes still collides', async () => {
    const jpg = await write('a/IMG_1.JPG', 'jpg');
    await write('a/IMG_1.xmp', '<mine/>');
    await write('b/IMG_1.CR3', 'raw');
    await write('b/IMG_1.xmp', '<theirs/>');
    const outcome = await relocateFile({
      sourceAbsPath: jpg,
      destAbsPath: abs('b/IMG_1.JPG'),
      mode: 'move',
      collision: 'auto-suffix',
    });
    expect(outcome).toMatchObject({ kind: 'relocated', newAbsPath: abs('b/IMG_1.1.JPG') });
    expect(await fs.readFile(abs('b/IMG_1.xmp'), 'utf8')).toBe('<theirs/>');
  });
});

describe('trash', () => {
  test('trashing the RAW of a RAW+JPEG pair copies the shared sidecar and leaves it for the JPG', async () => {
    const raw = await write('lib/IMG_1.CR3', 'raw');
    await write('lib/IMG_1.JPG', 'jpg');
    await write('lib/IMG_1.xmp', '<shared/>');
    const result = await moveToTrash(raw, abs('lib'));
    expect(result).toEqual({ kind: 'ok', newAbsPath: abs('lib/.maple/trash/IMG_1.CR3') });
    expect(await tree()).toEqual({
      'lib/IMG_1.JPG': 'jpg',
      'lib/IMG_1.xmp': '<shared/>',
      'lib/.maple/trash/IMG_1.CR3': 'raw',
      'lib/.maple/trash/IMG_1.xmp': '<shared/>',
    });
  });

  test('a sidecar already in the trash for that stem suffixes the whole asset instead of overwriting it', async () => {
    await write('lib/.maple/trash/IMG_1.xmp', '<earlier-trash/>');
    const raw = await write('lib/IMG_1.CR3', 'raw');
    await write('lib/IMG_1.xmp', '<mine/>');
    const result = await moveToTrash(raw, abs('lib'));
    expect(result).toEqual({ kind: 'ok', newAbsPath: abs('lib/.maple/trash/IMG_1.1.CR3') });
    expect(await tree()).toEqual({
      'lib/.maple/trash/IMG_1.xmp': '<earlier-trash/>',
      'lib/.maple/trash/IMG_1.1.CR3': 'raw',
      'lib/.maple/trash/IMG_1.1.xmp': '<mine/>',
    });
  });

  test('restoring one of two trashed same-stem photos leaves the shared sidecar for the other', async () => {
    const trashedRaw = await write('lib/.maple/trash/IMG_1.CR3', 'raw');
    await write('lib/.maple/trash/IMG_1.JPG', 'jpg');
    await write('lib/.maple/trash/IMG_1.xmp', '<shared/>');
    const result = await moveOutOfTrash(trashedRaw, abs('lib/IMG_1.CR3'));
    expect(result).toEqual({ kind: 'ok', newAbsPath: abs('lib/IMG_1.CR3') });
    expect(await tree()).toEqual({
      'lib/IMG_1.CR3': 'raw',
      'lib/IMG_1.xmp': '<shared/>',
      'lib/.maple/trash/IMG_1.JPG': 'jpg',
      'lib/.maple/trash/IMG_1.xmp': '<shared/>',
    });
  });
});

describe('symlinked sidecars', () => {
  test('a sidecar that is a symlink to the original is never copied into the destination', async () => {
    const raw = await write('a/IMG_1.CR3', 'raw-bytes');
    await fs.symlink(raw, abs('a/IMG_1.xmp'));
    const outcome = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: abs('b/IMG_1.CR3'),
      mode: 'move',
      collision: 'auto-suffix',
    });
    expect(outcome.kind).toBe('relocated');
    expect(await fs.exists(abs('b/IMG_1.xmp'))).toBe(false);
    expect((await fs.lstat(abs('a/IMG_1.xmp'))).isSymbolicLink()).toBe(true);
  });
});

describe('companions', () => {
  test('a same-stem companion that fails to copy keeps its claim on the source sidecar', async () => {
    const raw = await write('src/IMG_1.dng', 'pixels');
    const companion = await write('src/IMG_1.jpg', 'rendered');
    await write('src/IMG_1.xmp', '<edits/>');
    await fs.chmod(companion, 0o000);
    try {
      const outcome = await relocateFile({
        sourceAbsPath: raw,
        destAbsPath: abs('dst/IMG_1.dng'),
        mode: 'move',
        collision: 'auto-suffix',
        extraCompanionAbsPaths: [companion],
      });
      expect(outcome.kind).toBe('relocated');
    } finally {
      await fs.chmod(companion, 0o644);
    }
    expect(await tree()).toEqual({
      'src/IMG_1.jpg': 'rendered',
      'src/IMG_1.xmp': '<edits/>',
      'dst/IMG_1.dng': 'pixels',
      'dst/IMG_1.xmp': '<edits/>',
    });
  });

  test('a same-stem companion that moves with the photo takes the sidecar with it', async () => {
    const raw = await write('src/IMG_1.dng', 'pixels');
    const companion = await write('src/IMG_1.jpg', 'rendered');
    await write('src/IMG_1.xmp', '<edits/>');
    const outcome = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: abs('dst/IMG_1.dng'),
      mode: 'move',
      collision: 'auto-suffix',
      extraCompanionAbsPaths: [companion],
    });
    expect(outcome.kind).toBe('relocated');
    expect(await tree()).toEqual({
      'dst/IMG_1.dng': 'pixels',
      'dst/IMG_1.jpg': 'rendered',
      'dst/IMG_1.xmp': '<edits/>',
    });
  });
});

describe('duplicates mover', () => {
  test('quarantining the RAW of a RAW+JPEG pair copies the shared sidecar', async () => {
    const raw = await write('lib/IMG_1.CR3', 'raw');
    await write('lib/IMG_1.JPG', 'jpg');
    await write('lib/IMG_1.xmp', '<shared/>');
    const result = await moveToDuplicates(raw, abs('lib'));
    expect(result.kind).toBe('ok');
    const files = await tree();
    expect(files['lib/IMG_1.xmp']).toBe('<shared/>');
    expect(files['lib/IMG_1.JPG']).toBe('jpg');
    expect(Object.values(files).filter((c) => c === '<shared/>')).toHaveLength(2);
  });

  test('quarantining both halves of a RAW+JPEG pair keeps them on one stem with one sidecar', async () => {
    const raw = await write('lib/IMG_1.CR3', 'raw');
    const jpg = await write('lib/IMG_1.JPG', 'jpg');
    await write('lib/IMG_1.xmp', '<shared/>');
    const first = await moveToDuplicates(raw, abs('lib'));
    const second = await moveToDuplicates(jpg, abs('lib'));
    expect(first.kind).toBe('ok');
    expect(second.kind).toBe('ok');
    const quarantine = path.dirname((first as { newAbsPath: string }).newAbsPath);
    expect(path.basename((second as { newAbsPath: string }).newAbsPath)).toBe('IMG_1.JPG');
    expect((await fs.readdir(quarantine)).sort()).toEqual(['IMG_1.CR3', 'IMG_1.JPG', 'IMG_1.xmp']);
    expect(await fs.exists(abs('lib/IMG_1.xmp'))).toBe(false);
  });

  test('an orphan sidecar in the quarantine folder suffixes the asset rather than being replaced', async () => {
    const raw = await write('lib/IMG_1.CR3', 'raw');
    await write('lib/IMG_1.xmp', '<mine/>');
    const result = await moveToDuplicates(raw, abs('lib'));
    expect(result.kind).toBe('ok');
    const quarantined = (result as { newAbsPath: string }).newAbsPath;
    await write('lib/IMG_2.CR3', 'raw2');
    await write('lib/IMG_2.xmp', '<second/>');
    const occupant = path.join(path.dirname(quarantined), 'IMG_2.xmp');
    await fs.writeFile(occupant, '<orphan/>');
    const second = await moveToDuplicates(abs('lib/IMG_2.CR3'), abs('lib'));
    expect(second.kind).toBe('ok');
    expect(path.basename((second as { newAbsPath: string }).newAbsPath)).toBe('IMG_2.1.CR3');
    expect(await fs.readFile(occupant, 'utf8')).toBe('<orphan/>');
    expect(await fs.readFile(path.join(path.dirname(occupant), 'IMG_2.1.xmp'), 'utf8')).toBe(
      '<second/>',
    );
  });
});

describe('saves landing during a move', () => {
  test('an acknowledged save between the sidecar copy and the source delete reaches the destination', async () => {
    const raw = await write('a/IMG_1.CR3', 'raw');
    const sidecar = await write('a/IMG_1.xmp', '<before/>');
    const outcome = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: abs('b/IMG_1.CR3'),
      mode: 'move',
      collision: 'auto-suffix',
      onVerified: () => save(sidecar, '<saved-mid-move/>'),
    });
    expect(outcome.kind).toBe('relocated');
    expect(await tree()).toEqual({ 'b/IMG_1.CR3': 'raw', 'b/IMG_1.xmp': '<saved-mid-move/>' });
  });

  test('an in-flight save is waited for before the source sidecar is removed', async () => {
    const raw = await write('a/IMG_1.CR3', 'raw');
    const sidecar = await write('a/IMG_1.xmp', '<before/>');
    let inFlight: Promise<void> | undefined;
    const outcome = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: abs('b/IMG_1.CR3'),
      mode: 'move',
      collision: 'auto-suffix',
      onVerified: async () => {
        inFlight = serializeSidecarWrite(sidecar, async (destination) => {
          await Bun.sleep(30);
          await fs.writeFile(destination, '<slow-save/>');
        });
      },
    });
    await inFlight;
    expect(outcome.kind).toBe('relocated');
    expect(await tree()).toEqual({ 'b/IMG_1.CR3': 'raw', 'b/IMG_1.xmp': '<slow-save/>' });
  });

  test('when both ends were saved mid-move, the source is kept so neither save is lost', async () => {
    const raw = await write('a/IMG_1.CR3', 'raw');
    const sidecar = await write('a/IMG_1.xmp', '<before/>');
    const outcome = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: abs('b/IMG_1.CR3'),
      mode: 'move',
      collision: 'auto-suffix',
      onVerified: async (info) => {
        await save(sidecar, '<old-path-save/>');
        await save(info.sidecarPaths[0]!, '<new-path-save/>');
      },
    });
    expect(outcome.kind).toBe('relocated');
    expect(await tree()).toEqual({
      'a/IMG_1.xmp': '<old-path-save/>',
      'b/IMG_1.CR3': 'raw',
      'b/IMG_1.xmp': '<new-path-save/>',
    });
  });

  test('a save to a shared sidecar mid-move reaches the destination and stays for the sibling', async () => {
    const raw = await write('a/IMG_1.CR3', 'raw');
    await write('a/IMG_1.JPG', 'jpg');
    const sidecar = await write('a/IMG_1.xmp', '<before/>');
    const outcome = await relocateFile({
      sourceAbsPath: raw,
      destAbsPath: abs('b/IMG_1.CR3'),
      mode: 'move',
      collision: 'auto-suffix',
      onVerified: () => save(sidecar, '<saved-mid-move/>'),
    });
    expect(outcome.kind).toBe('relocated');
    expect(await tree()).toEqual({
      'a/IMG_1.JPG': 'jpg',
      'a/IMG_1.xmp': '<saved-mid-move/>',
      'b/IMG_1.CR3': 'raw',
      'b/IMG_1.xmp': '<saved-mid-move/>',
    });
  });

  test('a save to a sidecar shared in the trash reaches the restored photo and stays for the sibling', async () => {
    const trashedRaw = await write('lib/.maple/trash/IMG_1.CR3', 'raw');
    await write('lib/.maple/trash/IMG_1.JPG', 'jpg');
    const trashedSidecar = await write('lib/.maple/trash/IMG_1.xmp', '<before/>');
    const result = await moveOutOfTrash(
      trashedRaw,
      abs('lib/IMG_1.CR3'),
      undefined,
      undefined,
      () => save(trashedSidecar, '<saved-mid-restore/>'),
    );
    expect(result.kind).toBe('ok');
    expect(await tree()).toEqual({
      'lib/IMG_1.CR3': 'raw',
      'lib/IMG_1.xmp': '<saved-mid-restore/>',
      'lib/.maple/trash/IMG_1.JPG': 'jpg',
      'lib/.maple/trash/IMG_1.xmp': '<saved-mid-restore/>',
    });
  });

  test('a save during trash restore reaches the restored sidecar', async () => {
    const trashedRaw = await write('lib/.maple/trash/IMG_1.CR3', 'raw');
    const trashedSidecar = await write('lib/.maple/trash/IMG_1.xmp', '<before/>');
    const result = await moveOutOfTrash(
      trashedRaw,
      abs('lib/IMG_1.CR3'),
      undefined,
      undefined,
      () => save(trashedSidecar, '<saved-mid-restore/>'),
    );
    expect(result.kind).toBe('ok');
    expect(await tree()).toEqual({
      'lib/IMG_1.CR3': 'raw',
      'lib/IMG_1.xmp': '<saved-mid-restore/>',
    });
  });
});
