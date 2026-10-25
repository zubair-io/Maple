import { Injectable, inject } from '@angular/core';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { FolderAccessService } from '../folder-access/folder-access.service';

export class HostedSidecarConflictError extends Error {
  override name = 'HostedSidecarConflictError';
}

/** Tracks the exact sidecar document a Hosted editor loaded before it writes. */
@Injectable({ providedIn: 'root' })
export class HostedSidecarFreshnessService {
  private readonly access = inject(FolderAccessService);
  private readonly loaded = new WeakMap<MapleFolderHandle, Map<string, string | null>>();

  replaceFolder(folder: MapleFolderHandle, documents: ReadonlyMap<string, string | null>): void {
    this.loaded.set(folder, new Map(documents));
  }

  remember(folder: MapleFolderHandle, filename: string, xml: string | null): void {
    const documents = this.loaded.get(folder) ?? new Map<string, string | null>();
    documents.set(filename, xml);
    this.loaded.set(folder, documents);
  }

  async readCurrent(folder: MapleFolderHandle, filename: string): Promise<string | null> {
    const entry = (await this.access.listEntries(folder)).find((item) => item.name === filename);
    if (entry && entry.kind !== 'file') throw Error(`Sidecar path is not a file: ${filename}`);
    return entry
      ? new TextDecoder('utf-8', { fatal: true }).decode(
          await this.access.readFile(folder, filename),
        )
      : null;
  }

  assertUnchanged(
    folder: MapleFolderHandle,
    filename: string,
    current: string | null,
    explicitSource?: string | null,
  ): void {
    const documents = this.loaded.get(folder);
    if (explicitSource === undefined && !documents?.has(filename))
      throw Error(
        `Reload ${filename} before editing; its sidecar has not been read in this session.`,
      );
    const loaded = explicitSource === undefined ? documents!.get(filename) : explicitSource;
    if (current !== loaded)
      throw new HostedSidecarConflictError(
        `The XMP sidecar for ${filename} changed outside Maple. Reload the folder before editing; the external change was preserved.`,
      );
  }
}
