// hosted-editor-route.component.spec.ts — the single-file/read-only-folder
// save notice wiring, ported from the deleted `SingleFileSaveNoticeComponent`
// wrapper's spec (toast sweep, ticket #3043). `single-file-save-notice.vm
// .spec.ts` in maple-common covers every branch of the mode/status →
// message projection in isolation; this file covers the real DOM: the
// notice renders through `<mui-toast>`, has no close button, and its action
// button calls through to the exporter + xmp service.
//
// `<editor-shell>` is stubbed out via `TestBed.overrideComponent` (only
// `imports` is overridden, never `template`, so this still exercises the
// real `.html` file) — the real EditorShellComponent pulls in the canvas/
// WASM pipeline graph, which every other spec that needs it avoids
// instantiating too (see editor-shell.component.spec.ts's header comment).

import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@maple-common';
import {
  HOSTED_WORKSPACE_POLICY,
  ImageExportService,
  LibraryStateService,
  MuiToastComponent,
  SELF_HOSTED_WORKSPACE_POLICY,
  SingleFileXmpService,
  WORKSPACE_CAPABILITIES,
  type SingleFileXmpStatus,
  type WorkspaceCapabilityPolicy,
} from '@maple-common';
import { HostedEditorRouteComponent } from './hosted-editor-route.component';

@Component({ selector: 'editor-shell', template: '', standalone: true })
class StubEditorShell {}

const ASSET = { id: 'asset-1', filename: 'IMG_0042.CR3' } as Asset;

describe('HostedEditorRouteComponent — single-file save notice', () => {
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

  function render(policy: WorkspaceCapabilityPolicy): ComponentFixture<HostedEditorRouteComponent> {
    TestBed.configureTestingModule({
      imports: [HostedEditorRouteComponent],
      providers: [
        {
          provide: LibraryStateService,
          useValue: { focusedAsset, currentFolder, singleFileMemoryOnly },
        },
        { provide: WORKSPACE_CAPABILITIES, useValue: policy },
        { provide: ImageExportService, useValue: { downloadSidecar } },
        { provide: SingleFileXmpService, useValue: { status: xmpStatus, markDownloaded } },
      ],
    });
    TestBed.overrideComponent(HostedEditorRouteComponent, {
      set: { imports: [StubEditorShell, MuiToastComponent] },
    });
    const fixture = TestBed.createComponent(HostedEditorRouteComponent);
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

  it('shows the persistence warning and action for a hosted single-file workspace', () => {
    const fixture = render(HOSTED_WORKSPACE_POLICY);

    expect(fixture.nativeElement.querySelector('[aria-label="Single-file save"]')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain(
      'can’t write a sibling .xmp or .maple cache',
    );
    expect(fixture.nativeElement.querySelector('.action')?.textContent).toContain('Download XMP');
  });

  it('hides for a hosted writable folder', () => {
    currentFolder.set({ write: true });
    const fixture = render(HOSTED_WORKSPACE_POLICY);
    expect(fixture.nativeElement.querySelector('mui-toast')).toBeNull();
  });

  it('shows a download warning for a hosted read-only folder', () => {
    currentFolder.set({ write: false });
    const fixture = render(HOSTED_WORKSPACE_POLICY);

    expect(
      fixture.nativeElement.querySelector('[aria-label="Read-only folder save"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('This folder is read-only');
  });

  it('hides in Self Hosted even without a folder capability', () => {
    const fixture = render(SELF_HOSTED_WORKSPACE_POLICY);
    expect(fixture.nativeElement.querySelector('mui-toast')).toBeNull();
  });

  it('hides while there is no focused asset to save', () => {
    focusedAsset.set(null);
    const fixture = render(HOSTED_WORKSPACE_POLICY);
    expect(fixture.nativeElement.querySelector('mui-toast')).toBeNull();
  });

  it('never renders a close button — this notice is not user-dismissible', () => {
    const fixture = render(HOSTED_WORKSPACE_POLICY);
    expect(fixture.nativeElement.querySelector('.close')).toBeNull();
  });

  it('downloads the focused asset through the shared sidecar exporter', () => {
    const fixture = render(HOSTED_WORKSPACE_POLICY);

    (fixture.nativeElement.querySelector('.action') as HTMLButtonElement).click();

    expect(downloadSidecar).toHaveBeenCalledWith(ASSET);
    expect(markDownloaded).toHaveBeenCalledWith(ASSET.id);
  });
});
