// Unit tests for FileHandlerComponent (#2798): the PWA `file_handlers`
// landing route consumes window.launchQueue, imports the delivered RAWs
// through the loose-file path, and routes — editor for one file, Browse for
// several, /library for anything that can't be opened.

import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { FileHandlerComponent } from './file-handler.component';
import { LibraryStateService } from '../state/library-state.service';
import { AssetId } from '../models/asset';

type LaunchConsumer = (params: { files: ReadonlyArray<{ getFile(): Promise<File> }> }) => void;

describe('FileHandlerComponent', () => {
  let fixture: ComponentFixture<FileHandlerComponent>;
  let consumer: LaunchConsumer | undefined;

  const state = {
    selectedSourceId: signal<string>(''),
    selectAsset: vi.fn<(id: AssetId) => void>(),
    addImportedAsset: vi.fn<(bytes: Uint8Array, name: string) => AssetId>(),
  };
  const router = { navigate: vi.fn<() => Promise<boolean>>() };

  function handleFor(name: string): { getFile(): Promise<File> } {
    return { getFile: () => Promise.resolve(new File([new Uint8Array([1, 2, 3])], name)) };
  }

  /** Flush the getFile/arrayBuffer promise chain inside consume(). */
  async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    consumer = undefined;
    state.selectedSourceId.set('');
    router.navigate.mockResolvedValue(true);
    state.addImportedAsset.mockImplementation((_bytes, name) => `imported-${name}` as AssetId);
    (window as unknown as Record<string, unknown>)['launchQueue'] = {
      setConsumer: (c: LaunchConsumer) => {
        consumer = c;
      },
    };

    await TestBed.configureTestingModule({
      imports: [FileHandlerComponent],
      providers: [
        { provide: LibraryStateService, useValue: state },
        { provide: Router, useValue: router },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(FileHandlerComponent);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as Record<string, unknown>)['launchQueue'];
  });

  it('imports a single delivered RAW and navigates to the editor', async () => {
    fixture.detectChanges(); // ngOnInit — registers the consumer
    expect(consumer).toBeDefined();

    consumer!({ files: [handleFor('photo.dng')] });
    await settle();

    expect(state.addImportedAsset).toHaveBeenCalledTimes(1);
    expect(state.addImportedAsset.mock.calls[0][1]).toBe('photo.dng');
    expect(state.selectedSourceId()).toBe('f-imported');
    expect(state.selectAsset).toHaveBeenCalledWith('imported-photo.dng');
    expect(router.navigate).toHaveBeenCalledWith(
      expect.arrayContaining(['/edit']),
      expect.objectContaining({ replaceUrl: true }),
    );
  });

  it('imports several RAWs and lands in Browse', async () => {
    fixture.detectChanges();
    consumer!({ files: [handleFor('a.dng'), handleFor('b.arw')] });
    await settle();

    expect(state.addImportedAsset).toHaveBeenCalledTimes(2);
    expect(state.selectAsset).toHaveBeenCalledWith('imported-a.dng');
    expect(router.navigate).toHaveBeenCalledWith(['/library'], { replaceUrl: true });
  });

  it('skips non-RAW deliveries and bails to /library when nothing is importable', async () => {
    fixture.detectChanges();
    consumer!({ files: [handleFor('notes.txt')] });
    await settle();

    expect(state.addImportedAsset).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/library'], { replaceUrl: true });
  });

  it('leaves for /library when launchQueue is unavailable', () => {
    delete (window as unknown as Record<string, unknown>)['launchQueue'];
    fixture.detectChanges();
    expect(router.navigate).toHaveBeenCalledWith(['/library'], { replaceUrl: true });
  });

  it('leaves for /library after the grace period when no launch ever arrives', () => {
    fixture.detectChanges();
    expect(router.navigate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2100);
    expect(router.navigate).toHaveBeenCalledWith(['/library'], { replaceUrl: true });
  });

  it('a consumed launch cancels the grace-period fallback', async () => {
    fixture.detectChanges();
    consumer!({ files: [handleFor('photo.dng')] });
    await settle();
    router.navigate.mockClear();

    vi.advanceTimersByTime(5000);
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
