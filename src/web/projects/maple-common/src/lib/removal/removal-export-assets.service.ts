// Durable companion reads for both single-image and captured recipe export.
// Export has no focused-photo dependency; Rust binds bytes to the recipe (#3955).
import { Injectable, inject } from '@angular/core';
import { LibraryStateService } from '../state/library-state.service';
import { LibrarySlugRegistry } from '../addressing/library-slug-registry';
import { parseAddress } from '../addressing/maple-address';
import { FolderAccessService } from '../folder-access/folder-access.service';
import type { RemovalCompanionBundle } from './removal-companion-bundle';
import { LocalRemovalAssets } from './local-removal-assets';
import { savedRemovalRecords } from './saved-removal-records';

@Injectable({ providedIn: 'root' })
export class RemovalExportAssetsService {
  private readonly library = inject(LibraryStateService);
  private readonly registry = inject(LibrarySlugRegistry);
  private readonly files = inject(FolderAccessService);

  async load(
    id: string,
    filename: string,
    xml: string,
    captured?: FileSystemDirectoryHandle,
  ): Promise<RemovalCompanionBundle | undefined> {
    const records = savedRemovalRecords(xml);
    if (!records) return undefined;
    const focused = this.library.focusedAsset();
    const folder = this.library.currentFolder();
    if (!captured && focused?.id === id && focused.filename === filename && folder)
      return new LocalRemovalAssets(this.files, folder, filename).readBundle(records);
    const native = captured ?? (await this.directory(id, filename));
    return new LocalRemovalAssets(
      this.files,
      {
        name: native.name,
        native,
        read: true,
        write: false,
      },
      filename,
    ).readBundle(records);
  }

  private async directory(id: string, filename: string): Promise<FileSystemDirectoryHandle> {
    const { slug, relPath } = parseAddress(id);
    const parts = relPath.split('/');
    if (
      parts.some((part) => !part || part === '.' || part === '..' || /[\\\0]/.test(part)) ||
      parts.pop() !== filename
    )
      throw new Error('Reopen the original folder to export its saved removal assets.');
    const root = await this.registry.getHandle(slug);
    if (!root) throw new Error('Reopen the original folder to export its saved removal assets.');
    let directory = root;
    for (const part of parts) directory = await directory.getDirectoryHandle(part);
    return directory;
  }
}
