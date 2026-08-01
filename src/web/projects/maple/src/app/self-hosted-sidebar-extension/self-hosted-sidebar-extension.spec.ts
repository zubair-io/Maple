import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LibraryStateService } from '@maple-common';
import { describe, expect, it, vi } from 'vitest';
import { SelfHostedSidebarBodyComponent } from './self-hosted-sidebar-body.component';
import { SelfHostedSidebarHeaderComponent } from './self-hosted-sidebar-header.component';

describe('Self Hosted sidebar extensions', () => {
  it('keeps folder registration in the header action', () => {
    const openLibraryPicker = vi.fn();
    TestBed.configureTestingModule({
      imports: [SelfHostedSidebarHeaderComponent],
      providers: [{ provide: LibraryStateService, useValue: { openLibraryPicker } }],
    });

    const fixture = TestBed.createComponent(SelfHostedSidebarHeaderComponent);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[aria-label="Add folder"]').click();

    expect(openLibraryPicker).toHaveBeenCalledOnce();
  });

  it('keeps Timeline navigation in the body action', () => {
    const viewMode = signal<'folder' | 'timeline'>('folder');
    const setViewMode = vi.fn((mode: 'folder' | 'timeline') => viewMode.set(mode));
    TestBed.configureTestingModule({
      imports: [SelfHostedSidebarBodyComponent],
      providers: [{ provide: LibraryStateService, useValue: { viewMode, setViewMode } }],
    });

    const fixture = TestBed.createComponent(SelfHostedSidebarBodyComponent);
    fixture.detectChanges();
    const timeline = fixture.nativeElement.querySelector('.tree-row');
    timeline.click();
    fixture.detectChanges();

    expect(setViewMode).toHaveBeenCalledWith('timeline');
    expect(timeline.classList).toContain('selected');
  });
});
