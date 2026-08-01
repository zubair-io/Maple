import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LibraryStateService } from '@maple-common';
import { describe, expect, it, vi } from 'vitest';
import { SelfHostedBrowseControlsComponent } from './self-hosted-browse-controls.component';

describe('SelfHostedBrowseControlsComponent', () => {
  it('owns an accessible Folder/Timeline mode toggle', () => {
    const viewMode = signal<'folder' | 'timeline'>('folder');
    const setViewMode = vi.fn((mode: 'folder' | 'timeline') => viewMode.set(mode));
    TestBed.configureTestingModule({
      imports: [SelfHostedBrowseControlsComponent],
      providers: [
        provideRouter([]),
        {
          provide: LibraryStateService,
          useValue: { viewMode, setViewMode, searchQuery: signal('') },
        },
      ],
    });

    const fixture = TestBed.createComponent(SelfHostedBrowseControlsComponent);
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('[role="group"] button');

    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false');

    buttons[1].click();
    fixture.detectChanges();
    expect(setViewMode).toHaveBeenCalledWith('timeline');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  });
});
