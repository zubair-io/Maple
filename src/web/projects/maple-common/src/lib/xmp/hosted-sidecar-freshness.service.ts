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
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        await this.access.readFile(folder, filename),
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  }

  /** The document the editor last read or published; the base of a reconciling write. */
  baseline(
    folder: MapleFolderHandle,
    filename: string,
    explicitSource?: string | null,
  ): string | null {
    const documents = this.loaded.get(folder);
    if (explicitSource === undefined && !documents?.has(filename))
      throw Error(
        `Reload ${filename} before editing; its sidecar has not been read in this session.`,
      );
    return explicitSource === undefined ? (documents?.get(filename) ?? null) : explicitSource;
  }

  assertUnchanged(
    folder: MapleFolderHandle,
    filename: string,
    current: string | null,
    explicitSource?: string | null,
  ): void {
    if (current !== this.baseline(folder, filename, explicitSource))
      throw new HostedSidecarConflictError(
        `The XMP sidecar for ${filename} changed outside Maple. Reload the folder before editing; the external change was preserved.`,
      );
  }
}
