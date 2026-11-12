// A stacked RAW's JPEG that cannot follow its rename must stay visible in the
// Info row (#5846 review). Real LibraryStateService and AssetRenameService:
// the RAW's rename re-keys the focused asset, which is exactly what used to
// unmount the field before the JPEG's error could show.

import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { Subject, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InfoFilenameRowComponent } from './info-filename-row.component';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { API_BASE_URL } from '../api/api-base-url.token';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { provideSelfHostedWorkspace } from '../workspace/self-hosted-workspace.providers';
import { LibraryStateService } from '../state/library-state.service';
import { LibraryStore } from '../state/library-store.service';
import { LibrarySelection } from '../state/library-selection.service';
import { AssetRenameService } from '../rename/asset-rename.service';
import { STORAGE_KEYS } from '../util/typed-storage';
import type { Asset } from '../models/asset';

const RAW: Asset = {
  id: 'library:2026/IMG_0001.CR3',
  filename: 'IMG_0001.CR3',
  folderId: 'library:2026',
  rating: 0,
  flag: 'unflagged',
  colorLabel: null,
  thumbnailGradient: '',
  aspectRatio: 1.5,
  stack: {
    companion: { id: 'library:2026/IMG_0001.JPG', name: 'IMG_0001.JPG', ext: 'jpg', size: 1 },
  },
};

@Component({
  standalone: true,
  imports: [InfoFilenameRowComponent],
  template: `<app-info-filename-row [asset]="state.focusedAsset()" />`,
})
class HostComponent {
  protected readonly state = inject(LibraryStateService);
}

const clearPrefKeys = (): void => {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
};

describe('Info filename row — stacked rename (real state)', () => {
  const renameAsset = vi.fn();

  beforeEach(() => {
    clearPrefKeys();
    renameAsset.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideSelfHostedWorkspace(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
        {
          provide: BunApiBackendService,
          useValue: {
            renameAsset,
            listFolders: () => of([]),
            getThumb: () => new Subject<Blob>().asObservable(),
          },
        },
      ],
    });
  });

  afterEach(clearPrefKeys);

  it('keeps the field, and the JPEG’s error, on the renamed RAW', async () => {
    TestBed.inject(LibraryStore).assets.set([RAW]);
    TestBed.inject(LibrarySelection).focusedAssetId.set(RAW.id);
    renameAsset
      .mockReturnValueOnce(
        of({
          kind: 'renamed',
          newAbsPath: '/lib/2026/Trip_01.CR3',
          newPath: '2026',
          newFilename: 'Trip_01.CR3',
          renamedOnCollision: false,
          extensionChanged: false,
        }),
      )
      .mockReturnValueOnce(throwError(() => new Error('disk full')));
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const rename = TestBed.inject(AssetRenameService);
    rename.startEditing(RAW);
    rename.commit(RAW, 'Trip_01.CR3');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(TestBed.inject(LibraryStateService).focusedAsset()?.id).toBe('library:2026/Trip_01.CR3');
    const alert = (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('IMG_0001.JPG could not be renamed to Trip_01.JPG');
    expect(alert?.textContent).toContain('disk full');
  });
});
