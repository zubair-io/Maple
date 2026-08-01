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
import { SingleFileXmpService, type SingleFileXmpStatus } from '../xmp/single-file-xmp.service';

const ASSET = { id: 'asset-1', filename: 'IMG_0042.CR3' } as Asset;

describe('SingleFileSaveNoticeComponent', () => {
  const focusedAsset = signal<Asset | null>(ASSET);
  const currentFolder = signal<{ write: boolean } | null>(null);
  const singleFileMemoryOnly = signal(false);
  const xmpStatus = signal<SingleFileXmpStatus>({
    assetId: ASSET.id,
    durability: 'none',
    unsaved: false,
  });
  let downloadSidecar: ReturnType<typeof vi.fn>;
  let markDownloaded: ReturnType<typeof vi.fn>;

  function render(
    policy: WorkspaceCapabilityPolicy,
  ): ComponentFixture<SingleFileSaveNoticeComponent> {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LibraryStateService,
          useValue: { focusedAsset, currentFolder, singleFileMemoryOnly },
        },
        { provide: WORKSPACE_CAPABILITIES, useValue: policy },
        { provide: ImageExportService, useValue: { downloadSidecar } },
        {
          provide: SingleFileXmpService,
          useValue: { status: xmpStatus, markDownloaded },
        },
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
    singleFileMemoryOnly.set(false);
    downloadSidecar = vi.fn();
    markDownloaded = vi.fn();
    xmpStatus.set({ assetId: ASSET.id, durability: 'none', unsaved: false });
  });

  it('warns that reload loses a memory-only single-file session', () => {
    singleFileMemoryOnly.set(true);
    const fixture = render(HOSTED_WORKSPACE_POLICY);

    expect(fixture.nativeElement.textContent).toContain(
      'Browser storage is unavailable. Reloading will discard this photo session.',
    );
  });

  it('shows the persistence warning and action for a hosted single-file workspace', () => {
    const fixture = render(HOSTED_WORKSPACE_POLICY);

    expect(fixture.nativeElement.querySelector('[aria-label="Single-file save"]')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain(
      'can’t write a sibling .xmp or .maple cache',
    );
    expect(fixture.nativeElement.querySelector('button')?.textContent).toContain('Download XMP');
  });

  it('hides for a hosted writable folder', () => {
    currentFolder.set({ write: true });
    const fixture = render(HOSTED_WORKSPACE_POLICY);
    expect(fixture.nativeElement.querySelector('section')).toBeNull();
  });

  it('shows a download warning for a hosted read-only folder', () => {
    currentFolder.set({ write: false });
    const fixture = render(HOSTED_WORKSPACE_POLICY);

    expect(
      fixture.nativeElement.querySelector('[aria-label="Read-only folder save"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('This folder is read-only');
    expect(fixture.nativeElement.querySelector('button')?.textContent).toContain('Download XMP');
  });

  it('hides in Self Hosted even without a folder capability', () => {
    const fixture = render(SELF_HOSTED_WORKSPACE_POLICY);

    expect(fixture.nativeElement.querySelector('section')).toBeNull();
  });

  it('downloads the focused asset through the shared sidecar exporter', () => {
    const fixture = render(HOSTED_WORKSPACE_POLICY);

    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();

    expect(downloadSidecar).toHaveBeenCalledWith(ASSET);
    expect(markDownloaded).toHaveBeenCalledWith(ASSET.id);
  });

  it('makes unsaved single-file edits explicit', () => {
    xmpStatus.set({ assetId: ASSET.id, durability: 'paired', unsaved: true });
    const fixture = render(HOSTED_WORKSPACE_POLICY);

    expect(fixture.nativeElement.textContent).toContain('only in this browser session');
  });

  it('confirms a downloaded XMP is durable until another edit', () => {
    xmpStatus.set({ assetId: ASSET.id, durability: 'downloaded', unsaved: false });
    const fixture = render(HOSTED_WORKSPACE_POLICY);

    expect(fixture.nativeElement.textContent).toContain('XMP downloaded');
  });

  it('hides while there is no focused asset to save', () => {
    focusedAsset.set(null);
    const fixture = render(HOSTED_WORKSPACE_POLICY);

    expect(fixture.nativeElement.querySelector('section')).toBeNull();
  });
});
