// Local-folder publication and recovery (#3940 / #1472). Prepared metadata is
// returned only after all immutable bytes were closed and read back. XMP still
// needs a separate confirmed commit. Durable companions never enter cache I/O.
import init, {
  removal_asset_names,
  removal_asset_verify,
  removal_content_digest,
  removal_prepare,
  removal_source_verify,
} from '../raw-pipeline/pkg/raw_wasm';
import { FolderAccessService } from '../folder-access/folder-access.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { withRemovalWriteLock } from './removal-write-lock';

export class LocalRemovalAssets {
  constructor(
    private readonly files: FolderAccessService,
    private readonly folder: MapleFolderHandle,
    private readonly rawFilename: string,
  ) {
    if (!folder.native || !folder.write) {
      throw new Error(
        'A folder with filesystem write access is required to save removal companions.',
      );
    }
    if (!rawFilename || /[/\\\0]/.test(rawFilename) || rawFilename === '..') {
      throw new Error('Removal requires a photo basename in its containing folder.');
    }
  }

  async publish(
    request: string,
    prior: string,
    mask: Uint8Array,
    patch: Uint8Array,
  ): Promise<string> {
    await init();
    return withRemovalWriteLock(this.folder, this.rawFilename, async () => {
      const records = removal_prepare(request, prior, mask, patch);
      await this.verifySource(records);
      const names = this.names(records);
      await this.publishOne(mask, names);
      await this.publishOne(patch, names);
      await this.read(records);
      return records;
    });
  }

  async read(records: string): Promise<ReadonlyMap<string, Uint8Array>> {
    await init();
    const entries = await Promise.all(
      this.names(records).map(async (name) => {
        const bytes = await this.files.readFile(this.folder, `.maple/inpaint/${name}`);
        removal_asset_verify(name, bytes);
        return [name, bytes] as const;
      }),
    );
    return new Map(entries);
  }

  async verifySource(records: string): Promise<void> {
    await init();
    const original = await this.files.readFile(this.folder, this.rawFilename);
    removal_source_verify(records, removal_content_digest(original));
  }

  private names(records: string): string[] {
    return JSON.parse(removal_asset_names(records)) as string[];
  }

  private async publishOne(bytes: Uint8Array, names: string[]): Promise<void> {
    const hex = removal_content_digest(bytes).slice('blake3:'.length);
    const name = names.find((value) => value.startsWith(hex + '.'));
    if (!name) throw new Error('Prepared removal does not reference this companion.');
    removal_asset_verify(name, bytes);
    const path = `.maple/inpaint/${name}`;
    const existing = await this.readIfPresent(path);
    if (existing) {
      removal_asset_verify(name, existing);
      return;
    }
    await this.files.writeFile(this.folder, path, bytes);
    removal_asset_verify(name, await this.files.readFile(this.folder, path));
  }

  private async readIfPresent(path: string): Promise<Uint8Array | undefined> {
    try {
      return await this.files.readFile(this.folder, path);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
      throw error;
    }
  }
}
