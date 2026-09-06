import { inject, Injectable } from '@angular/core';
import { LibrarySlugRegistry } from '../addressing/library-slug-registry';
import { parseAddress } from '../addressing/maple-address';
import { readRecipeDirectory, saveRecipeDirectory, type RecipeTarget } from './export-recipe-store';

interface DirectoryPermission extends FileSystemDirectoryHandle {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
}
interface DirectoryPicker {
  showDirectoryPicker(options: {
    id: string;
    mode: 'readwrite';
  }): Promise<FileSystemDirectoryHandle>;
}

@Injectable({ providedIn: 'root' })
export class RecipeDirectoryAccessService {
  private readonly registry = inject(LibrarySlugRegistry);

  async choose(): Promise<{ key: string; name: string }> {
    if (!('showDirectoryPicker' in window))
      throw new Error(
        'This browser cannot choose writable folders. Use Browser downloads or a Chromium browser.',
      );
    // Called directly from the user's button gesture; selecting grants this directory only.
    const handle = await (window as unknown as DirectoryPicker).showDirectoryPicker({
      id: 'maple-export',
      mode: 'readwrite',
    });
    return { key: await saveRecipeDirectory(handle), name: handle.name };
  }

  async resolve(key: string): Promise<FileSystemDirectoryHandle> {
    const handle = await readRecipeDirectory(key);
    if (!handle)
      throw new Error('Choose an export folder on this device before running this recipe.');
    await this.permit(handle);
    return handle;
  }

  async permit(handle: FileSystemDirectoryHandle): Promise<void> {
    const access = handle as DirectoryPermission;
    if (typeof access.queryPermission !== 'function') return;
    if ((await access.queryPermission({ mode: 'readwrite' })) === 'granted') return;
    if ((await access.requestPermission({ mode: 'readwrite' })) !== 'granted')
      throw new Error('Export folder permission was denied. Grant access and resume the queue.');
  }

  async captureSources(targets: RecipeTarget[]): Promise<void> {
    for (const target of targets) {
      const address = parseAddress(target.id);
      const parts = address.relPath.split('/');
      if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\')))
        throw new Error(
          `Cannot resolve original identity for ${target.filename}. Reopen its source folder.`,
        );
      let directory = await this.registry.getHandle(address.slug);
      if (!directory)
        throw new Error(
          `Reopen the source folder for ${target.filename} before exporting to a folder.`,
        );
      const name = parts.pop()!;
      for (const part of parts) directory = await directory.getDirectoryHandle(part);
      target.sourceHandle = await directory.getFileHandle(name);
    }
  }
}
