import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LibraryStateService } from '@maple-common';
import { describe, expect, it } from 'vitest';
import { SelfHostedBrowseControlsComponent } from './self-hosted-browse-controls.component';

describe('SelfHostedBrowseControlsComponent', () => {
  it('does not render a Folder/Timeline view-mode toggle', () => {
    TestBed.configureTestingModule({
      imports: [SelfHostedBrowseControlsComponent],
      providers: [
        provideRouter([]),
        {
          provide: LibraryStateService,
          useValue: { searchQuery: signal('') },
        },
      ],
    });

    const fixture = TestBed.createComponent(SelfHostedBrowseControlsComponent);
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('[role="group"][aria-label="View mode"]'),
    ).toBeNull();
  });
});
