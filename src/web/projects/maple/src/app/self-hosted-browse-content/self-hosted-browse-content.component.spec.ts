import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LibraryStateService } from '@maple-common';
import { describe, expect, it, vi } from 'vitest';
import { SelfHostedBrowseController } from '../self-hosted-browse/self-hosted-browse.controller';
import { SelfHostedBrowseContentComponent } from './self-hosted-browse-content.component';

describe('SelfHostedBrowseContentComponent', () => {
  it('starts server folder enumeration only when the extension mounts', () => {
    const loadFolderTree = vi.fn();
    TestBed.configureTestingModule({
      imports: [SelfHostedBrowseContentComponent],
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            loadFolderTree,
            backendLoading: signal(false),
            backendError: signal(null),
            backendEmpty: signal(false),
            viewMode: signal('folder'),
          },
        },
        {
          provide: SelfHostedBrowseController,
          useValue: {
            panoVisible: signal(false),
            panoAssetIds: signal([]),
            metadataVisible: signal(false),
            metadataSnapshots: signal([]),
          },
        },
      ],
    });
    TestBed.overrideComponent(SelfHostedBrowseContentComponent, {
      set: { template: '', imports: [] },
    });

    const fixture = TestBed.createComponent(SelfHostedBrowseContentComponent);
    fixture.detectChanges();

    expect(loadFolderTree).toHaveBeenCalledOnce();
  });
});
