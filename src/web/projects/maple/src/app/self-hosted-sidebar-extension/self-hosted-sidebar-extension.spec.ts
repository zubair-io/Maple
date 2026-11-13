import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService, LibraryStateService } from '@maple-common';
import { describe, expect, it, vi } from 'vitest';
import { SelfHostedSidebarBodyComponent } from './self-hosted-sidebar-body.component';
import { SelfHostedSidebarHeaderComponent } from './self-hosted-sidebar-header.component';

describe('Self Hosted sidebar extensions', () => {
  it('keeps folder registration in the header action', () => {
    const openLibraryPicker = vi.fn();
    TestBed.configureTestingModule({
      imports: [SelfHostedSidebarHeaderComponent],
      providers: [
        { provide: LibraryStateService, useValue: { openLibraryPicker } },
        { provide: AuthService, useValue: { user: signal({ role: 'owner' }) } },
      ],
    });

    const fixture = TestBed.createComponent(SelfHostedSidebarHeaderComponent);
    fixture.detectChanges();
    const native: HTMLButtonElement = fixture.nativeElement.querySelector('mui-button button');
    expect(native.getAttribute('aria-label')).toBe('Add folder');
    expect(native.title).toBe('Add a folder to your library');
    native.click();

    expect(openLibraryPicker).toHaveBeenCalledOnce();
  });

  it('hides folder registration from members', () => {
    TestBed.configureTestingModule({
      imports: [SelfHostedSidebarHeaderComponent],
      providers: [
        { provide: LibraryStateService, useValue: { openLibraryPicker: vi.fn() } },
        { provide: AuthService, useValue: { user: signal({ role: 'member' }) } },
      ],
    });

    const fixture = TestBed.createComponent(SelfHostedSidebarHeaderComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('mui-button')).toBeNull();
  });

  it('keeps Timeline navigation in the body action', () => {
    const viewMode = signal<'folder' | 'timeline' | 'map'>('folder');
    const setViewMode = vi.fn((mode: 'folder' | 'timeline' | 'map') => viewMode.set(mode));
    TestBed.configureTestingModule({
      imports: [SelfHostedSidebarBodyComponent],
      providers: [{ provide: LibraryStateService, useValue: { viewMode, setViewMode } }],
    });

    const fixture = TestBed.createComponent(SelfHostedSidebarBodyComponent);
    fixture.detectChanges();
    const timeline = fixture.nativeElement.querySelectorAll('.tree-row')[0];
    timeline.click();
    fixture.detectChanges();

    expect(setViewMode).toHaveBeenCalledWith('timeline');
    expect(timeline.classList).toContain('selected');
  });

  it('keeps Map navigation, under Timeline, in the body action', () => {
    const viewMode = signal<'folder' | 'timeline' | 'map'>('folder');
    const setViewMode = vi.fn((mode: 'folder' | 'timeline' | 'map') => viewMode.set(mode));
    TestBed.configureTestingModule({
      imports: [SelfHostedSidebarBodyComponent],
      providers: [{ provide: LibraryStateService, useValue: { viewMode, setViewMode } }],
    });

    const fixture = TestBed.createComponent(SelfHostedSidebarBodyComponent);
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('.tree-row');
    expect(rows).toHaveLength(2);
    const map = rows[1];
    expect(map.textContent).toContain('Map');
    map.click();
    fixture.detectChanges();

    expect(setViewMode).toHaveBeenCalledWith('map');
    expect(map.classList).toContain('selected');
  });
});
