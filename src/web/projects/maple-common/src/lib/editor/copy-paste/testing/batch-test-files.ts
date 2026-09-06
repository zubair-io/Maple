// Real filesystem adapters for sidecar integration tests. The production FS
// Access backend calls these handles; writes close through an atomic rename.
import { promises as fs } from 'node:fs';
import { File } from 'node:buffer';
import { basename, join } from 'node:path';
import type { BatchAssetRecord, BatchLedger, BatchOperation } from '../batch-ledger';

function missing(error: unknown): never {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT')
    throw new DOMException('No such file', 'NotFoundError');
  throw error;
}
export class DiskDirectory {
  // Structural filesystem/ledger protocol dispatch in the real I/O harness.
  // fallow-ignore-next-line unused-class-member
  readonly kind = 'directory';
  readonly name: string;
  constructor(readonly path: string) {
    this.name = basename(path);
  }
  // Structural filesystem/ledger protocol dispatch in the real I/O harness.
  // fallow-ignore-next-line unused-class-member
  async isSameEntry(other: DiskDirectory): Promise<boolean> {
    return other.path === this.path;
  }
  // Structural filesystem/ledger protocol dispatch in the real I/O harness.
  // fallow-ignore-next-line unused-class-member
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DiskDirectory> {
    const path = join(this.path, name);
    try {
      if (options?.create) await fs.mkdir(path, { recursive: true });
      else await fs.stat(path);
    } catch (error) {
      missing(error);
    }
    return new DiskDirectory(path);
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const path = join(this.path, name);
    if (!options?.create) {
      try {
        await fs.stat(path);
      } catch (error) {
        missing(error);
      }
    }
    return {
      kind: 'file',
      name,
      async getFile() {
        try {
          const stat = await fs.stat(path);
          return new File([await fs.readFile(path)], name, { lastModified: stat.mtimeMs });
        } catch (error) {
          missing(error);
        }
      },
      async createWritable() {
        const temporary = path + '.' + crypto.randomUUID() + '.tmp';
        return {
          write: async (bytes: ArrayBuffer) => {
            await fs.writeFile(temporary, new Uint8Array(bytes));
          },
          close: async () => {
            try {
              await fs.rename(temporary, path);
            } catch (error) {
              await fs.rm(temporary, { force: true });
              throw error;
            }
          },
        };
      },
    };
  }
  // Structural filesystem/ledger protocol dispatch in the real I/O harness.
  // fallow-ignore-next-line unused-class-member
  async *entries() {
    for (const entry of await fs.readdir(this.path, { withFileTypes: true })) {
      yield [
        entry.name,
        entry.isDirectory()
          ? new DiskDirectory(join(this.path, entry.name))
          : await this.getFileHandle(entry.name),
      ] as const;
    }
  }
  // Structural filesystem/ledger protocol dispatch in the real I/O harness.
  // fallow-ignore-next-line unused-class-member
  queryPermission() {
    return Promise.resolve('granted');
  }
}

/** A real per-asset disk ledger exercises crash/reopen independently of a
 * tab's IndexedDB implementation. Browser E2E covers the production ledger. */
export class DiskBatchLedger implements BatchLedger {
  constructor(readonly root: string) {}
  async create(operation: BatchOperation) {
    await fs.mkdir(join(this.root, 'assets'), { recursive: true });
    await this.saveOperation(operation);
    for (const id of operation.assetIds)
      await this.saveAsset({ id, operationId: operation.id, status: 'pending' });
  }
  async operation(_id: string): Promise<BatchOperation> {
    return JSON.parse(await fs.readFile(join(this.root, 'operation.json'), 'utf8'));
  }
  // Structural filesystem/ledger protocol dispatch in the real I/O harness.
  // fallow-ignore-next-line unused-class-member
  async latest() {
    try {
      return await this.operation('');
    } catch {
      return undefined;
    }
  }
  async saveOperation(operation: BatchOperation) {
    await this.atomic(join(this.root, 'operation.json'), operation);
  }
  async assets(_id: string): Promise<BatchAssetRecord[]> {
    const names = await fs.readdir(join(this.root, 'assets'));
    return Promise.all(
      names
        .filter((n) => n.endsWith('.json'))
        .map(async (n) => JSON.parse(await fs.readFile(join(this.root, 'assets', n), 'utf8'))),
    );
  }
  async saveAsset(asset: BatchAssetRecord) {
    await this.atomic(join(this.root, 'assets', encodeURIComponent(asset.id) + '.json'), asset);
  }
  async delete(_id: string) {
    await fs.rm(this.root, { recursive: true, force: true });
  }
  private async atomic(path: string, record: unknown) {
    const temporary = path + '.' + crypto.randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(record));
    await fs.rename(temporary, path);
  }
}
