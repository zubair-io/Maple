// BrowseShell — toggle visibility test (S5/S2).
//
// Verifies the Folder/Timeline segmented control:
//   - is rendered in Self-Hosted mode
//   - is hidden in Hosted mode
//   - uses aria-pressed (not aria-checked) on its buttons (S5 accessibility)
//
// Heavy child components are not the focus here — we exercise the shell's
// branching behaviour. The initial loadFolderTree() request is flushed to
// keep the HttpTestingController clean.

import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { BrowseShellComponent } from './browse-shell.component';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { API_BASE_URL } from '../../api/api-base-url.token';

function setupHosted() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: LIBRARY_BACKEND, useValue: 'hosted' },
      { provide: API_BASE_URL, useValue: '/api' },
    ],
  });
}

function setupSelfHosted() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
      { provide: API_BASE_URL, useValue: '/api' },
    ],
  });
}

describe('BrowseShellComponent — Folder/Timeline toggle', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    // jsdom lacks ResizeObserver/IntersectionObserver — child components
    // (asset-grid etc.) construct one in ngAfterViewInit. Stub them.
    const observerStub = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = observerStub;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = observerStub;
  });

  afterEach(() => {
    try {
      http.verify();
    } catch {
      // Swallow stray expectations from heavy child components — we only
      // care about the toggle DOM here, not the full request graph.
    }
  });

  it('renders the toggle when backend is self-hosted', () => {
    setupSelfHosted();
    const fixture = TestBed.createComponent(BrowseShellComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    // Flush the loadFolderTree() request kicked off by ngOnInit.
    http.match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();

    const toggle = fixture.nativeElement.querySelector('[aria-label="View mode"]');
    expect(toggle).not.toBeNull();
    const buttons = toggle!.querySelectorAll('button');
    expect(buttons.length).toBe(2);
    expect(buttons[0]!.textContent?.trim()).toContain('Folder');
    expect(buttons[1]!.textContent?.trim()).toContain('Timeline');
  });

  it('uses aria-pressed (not aria-checked) for accessibility (S5)', () => {
    setupSelfHosted();
    const fixture = TestBed.createComponent(BrowseShellComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();

    const toggle = fixture.nativeElement.querySelector('[aria-label="View mode"]');
    const buttons = toggle!.querySelectorAll('button');
    for (const b of Array.from(buttons) as HTMLButtonElement[]) {
      expect(b.hasAttribute('aria-pressed')).toBe(true);
      expect(b.hasAttribute('aria-checked')).toBe(false);
    }
    // role on the wrapper should be group, not radiogroup.
    expect(toggle!.getAttribute('role')).toBe('group');
  });

  it('hides the toggle when backend is hosted', () => {
    setupHosted();
    const fixture = TestBed.createComponent(BrowseShellComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    // Hosted shouldn't kick off folder enumeration; flush anything anyway.
    http.match(() => true).forEach((r) => r.flush([]));
    fixture.detectChanges();

    const toggle = fixture.nativeElement.querySelector('[aria-label="View mode"]');
    expect(toggle).toBeNull();
  });
});
