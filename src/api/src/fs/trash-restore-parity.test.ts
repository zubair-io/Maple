import { describe, expect, test } from 'bun:test';
import * as fs from './mirrored';
import * as os from 'node:os';
import * as path from 'node:path';
import { moveOutOfTrash } from './trash';
import { sidecarRenameTarget } from './sidecar-rename';
import corpus from '../../../../test-fixtures/file-operations/restore-collisions.json';

describe('shared restore collision corpus (#4139)', () => {
  for (const item of corpus.cases) {
    test(item.name, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-restore-parity-'));
      try {
        const trash = path.join(root, '.maple', 'trash');
        await fs.mkdir(trash, { recursive: true });
        const source = path.join(trash, item.base);
        const original = Buffer.from(`original ${item.name}`);
        await fs.writeFile(source, original);
        const incoming =
          '<x:xmpmeta xmlns:x="adobe:ns:meta/"><foreign:retained xmlns:foreign="urn:test">case-folded bytes</foreign:retained></x:xmpmeta>';
        const sidecars: string[] = 'incoming' in item ? (item.incoming ?? []) : [];
        for (const name of sidecars) await fs.writeFile(path.join(trash, name), incoming);
        const occupied = '<foreign>occupied</foreign>';
        for (const name of item.occupied) await fs.writeFile(path.join(root, name), occupied);
        const result = await moveOutOfTrash(source, path.join(root, item.base));
        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') throw new Error(result.error);
        expect(path.basename(result.newAbsPath)).toBe(item.expected);
        expect(await fs.readFile(result.newAbsPath)).toEqual(original);
        for (const name of sidecars) {
          const renamed = sidecarRenameTarget(source, result.newAbsPath, path.join(trash, name));
          expect(renamed).not.toBeNull();
          expect(await fs.readFile(renamed!, 'utf8')).toBe(incoming);
          expect(await Bun.file(path.join(trash, name)).exists()).toBe(false);
        }
        for (const name of item.occupied)
          expect(await fs.readFile(path.join(root, name), 'utf8')).toBe(occupied);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});
