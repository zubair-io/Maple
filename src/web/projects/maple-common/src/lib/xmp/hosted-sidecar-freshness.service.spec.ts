import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { defaultAdjustmentModel } from '../models/adjustment-model';
import { SidecarSaveStateService } from './sidecar-save-state.service';
import { WorkflowXmpService } from './workflow-xmp.service';
import { XmpStoreService } from './xmp-store.service';

const folder: MapleFolderHandle = {
  name: 'photos',
  read: true,
  write: true,
  native: {} as FileSystemDirectoryHandle,
};
const sidecar = (rating: number) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="${rating}" /></rdf:RDF></x:xmpmeta>`;

describe('Hosted sidecar external-change protection', () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');

  afterEach(() => {
    vi.useRealTimers();
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else Reflect.deleteProperty(navigator, 'locks');
  });

  it('preserves an external edit, reports an unsaved conflict, then saves after reload', async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async (_name: string, write: () => Promise<string>) => write() },
    });
    let disk = sidecar(0);
    const writeFile = vi.fn(
      async (_folder: MapleFolderHandle, _name: string, bytes: Uint8Array) => {
        disk = new TextDecoder().decode(bytes);
      },
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: FolderAccessService,
          useValue: {
            listEntries: async () => [{ name: 'photo.xmp', kind: 'file' }],
            readFile: async () => new TextEncoder().encode(disk),
            writeFile,
          },
        },
        {
          provide: WorkflowXmpService,
          useValue: {
            variantFilename: async (name: string) => name,
            read: async () => null,
            checkpoint: async (xml: string) => xml,
          },
        },
      ],
    });
    const store = TestBed.inject(XmpStoreService);
    const saveState = TestBed.inject(SidecarSaveStateService);
    store.replaceLoadedDocuments(folder, new Map([['photo.xmp', disk]]));

    disk = sidecar(4);
    store.scheduleWrite('asset', folder, 'photo.dng', defaultAdjustmentModel(), {
      rating: 2,
      flag: 'unflagged',
      colorLabel: null,
      keywords: [],
    });
    await expect(store.flushAll()).rejects.toThrow('changed outside Maple');
    expect(disk).toBe(sidecar(4));
    expect(writeFile).not.toHaveBeenCalled();
    expect(saveState.phase()).toBe('error');

    store.replaceLoadedDocuments(folder, new Map([['photo.xmp', disk]]));
    store.scheduleWrite('asset', folder, 'photo.dng', defaultAdjustmentModel(), {
      rating: 3,
      flag: 'unflagged',
      colorLabel: null,
      keywords: [],
    });
    await store.flushAll();
    expect(disk).toContain('xmp:Rating="3"');
    expect(saveState.phase()).toBe('saved');
  });
});
