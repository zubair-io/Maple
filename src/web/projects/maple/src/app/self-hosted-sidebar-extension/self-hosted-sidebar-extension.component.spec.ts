import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LibraryStateService } from '@maple-common';
import { describe, expect, it, vi } from 'vitest';
import { SelfHostedSidebarExtensionComponent } from './self-hosted-sidebar-extension.component';

describe('SelfHostedSidebarExtensionComponent', () => {
  it('owns the server-backed sidebar actions', () => {
    const viewMode = signal<'folder' | 'timeline'>('folder');
    const openLibraryPicker = vi.fn();
    const setViewMode = vi.fn((mode: 'folder' | 'timeline') => viewMode.set(mode));
    TestBed.configureTestingModule({
      imports: [SelfHostedSidebarExtensionComponent],
      providers: [
        { provide: LibraryStateService, useValue: { viewMode, openLibraryPicker, setViewMode } },
      ],
    });

    const fixture = TestBed.createComponent(SelfHostedSidebarExtensionComponent);
    fixture.detectChanges();
    const add = fixture.nativeElement.querySelector('[aria-label="Add folder"]');
    const timeline = fixture.nativeElement.querySelector('.tree-row');

    add.click();
    timeline.click();
    fixture.detectChanges();

    expect(openLibraryPicker).toHaveBeenCalledOnce();
    expect(setViewMode).toHaveBeenCalledWith('timeline');
    expect(timeline.classList).toContain('selected');
  });
});
