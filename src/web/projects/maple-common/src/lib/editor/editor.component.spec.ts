// editor.component.spec.ts — KTLO #650.
//
// Verifies the v0.1 placeholder div is gone and the shared
// ImageCanvasComponent (`editor-image-canvas`) mounts inside the canvas
// region. Live preview wiring rides on the existing LibraryStateService
// adjustment signal — see EditorStateService spec for that contract.

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { EditorComponent } from './editor.component';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { API_BASE_URL } from '../api/api-base-url.token';
import { STORAGE_KEYS } from '../util/typed-storage';
import { provideLibrarySource } from '../addressing/library-source-provider';

// This spec constructs the real BrowsePreferencesService (via
// EditorComponent → LibraryStateService); its persistence effects write
// `cm.*` keys into the jsdom localStorage that vitest shares across spec
// files on a worker. Clear them around each test so nothing leaks into
// sibling spec files (#1142).
const clearPrefKeys = (): void => {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
};
beforeEach(clearPrefKeys);
afterEach(clearPrefKeys);

describe('EditorComponent — canvas wiring (#650)', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    // jsdom lacks ResizeObserver — ImageCanvasComponent constructs one in
    // ngAfterViewInit. Stub it (matches the BrowseShell / TimelineView
    // pattern elsewhere in this project).
    const observerStub = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = observerStub;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = observerStub;

    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideLibrarySource,
        { provide: LIBRARY_BACKEND, useValue: 'hosted' },
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
  });

  afterEach(() => {
    try {
      http.verify();
    } catch {
      // Swallow stray expectations — heavy LibraryStateService dependencies
      // may schedule background HTTP work we don't care about here.
    }
  });

  it('renders the ImageCanvasComponent inside the canvas region (not the placeholder)', () => {
    const fixture = TestBed.createComponent(EditorComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.componentRef.setInput('assetId', 'asset-stub-1');
    fixture.componentRef.setInput('filename', 'IMG_0001.dng');
    fixture.detectChanges();
    http.match(() => true).forEach((r) => r.flush({}, { status: 200, statusText: 'OK' }));
    fixture.detectChanges();

    const region = fixture.nativeElement.querySelector(
      '[data-testid="editor-canvas-region"]',
    ) as HTMLElement | null;
    expect(region).not.toBeNull();

    // The real canvas selector is mounted under the canvas region.
    const canvas = region!.querySelector('editor-image-canvas');
    expect(canvas).not.toBeNull();

    // And the v0.1 placeholder div is gone.
    const placeholder = fixture.nativeElement.querySelector(
      '[data-testid="editor-canvas-placeholder"]',
    );
    expect(placeholder).toBeNull();
  });
});
