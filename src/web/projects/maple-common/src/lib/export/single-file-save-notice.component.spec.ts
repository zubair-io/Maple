import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '../models/asset';
import { LibraryStateService } from '../state/library-state.service';
import {
  HOSTED_WORKSPACE_POLICY,
  SELF_HOSTED_WORKSPACE_POLICY,
  WORKSPACE_CAPABILITIES,
  type WorkspaceCapabilityPolicy,
} from '../workspace/workspace-capabilities';
import { ImageExportService } from './image-export.service';
import { SingleFileSaveNoticeComponent } from './single-file-save-notice.component';

const ASSET = { id: 'asset-1', filename: 'IMG_0042.CR3' } as Asset;

describe('SingleFileSaveNoticeComponent', () => {
  const focusedAsset = signal<Asset | null>(ASSET);
  const currentFolder = signal<{ write: boolean } | null>(null);
  let downloadSidecar: ReturnType<typeof vi.fn>;

  function render(
    policy: WorkspaceCapabilityPolicy,
  ): ComponentFixture<SingleFileSaveNoticeComponent> {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStateService,
          useValue: { focusedAsset, currentFolder },
        },
        { provide: WORKSPACE_CAPABILITIES, useValue: policy },
        { provide: ImageExportService, useValue: { downloadSidecar } },
      ],
    });
    const fixture = TestBed.createComponent(SingleFileSaveNoticeComponent);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
    focusedAsset.set(ASSET);
    currentFolder.set(null);
    downloadSidecar = vi.fn();
  });

  it('shows the persistence warning and action for a hosted single-file workspace', () => {
    const fixture = render(HOSTED_WORKSPACE_POLICY);

    expect(fixture.nativeElement.querySelector('[aria-label="Single-file save"]')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain(
      'can’t write a sibling .xmp or .maple cache',
    );
    expect(fixture.nativeElement.querySelector('button')?.textContent).toContain('Download XMP');
  });

  it('hides for a hosted writable folder and for Self Hosted', () => {
    currentFolder.set({ write: true });
    const hostedFolder = render(HOSTED_WORKSPACE_POLICY);
    expect(hostedFolder.nativeElement.querySelector('section')).toBeNull();

    TestBed.resetTestingModule();
    currentFolder.set(null);
    const selfHosted = render(SELF_HOSTED_WORKSPACE_POLICY);
    expect(selfHosted.nativeElement.querySelector('section')).toBeNull();
  });

  it('downloads the focused asset through the shared sidecar exporter', () => {
    const fixture = render(HOSTED_WORKSPACE_POLICY);

    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();

    expect(downloadSidecar).toHaveBeenCalledWith(ASSET);
  });

  it('hides while there is no focused asset to save', () => {
    focusedAsset.set(null);
    const fixture = render(HOSTED_WORKSPACE_POLICY);

    expect(fixture.nativeElement.querySelector('section')).toBeNull();
  });
});
