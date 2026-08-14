import { Component, signal, input, output } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { LibraryStateService } from '@maple-common';
import { describe, expect, it, vi } from 'vitest';
import { SelfHostedBrowseController } from '../self-hosted-browse/self-hosted-browse.controller';
import { SelfHostedBrowseContentComponent } from './self-hosted-browse-content.component';

// Stand-ins for every sibling selector the real template references, so the
// render-branch test below exercises the ACTUAL `.html` file (only `imports`
// is overridden, never `template`) without pulling in each sibling's own
// dependency graph (asset-grid, batch-metadata-panel, etc. are each heavy).
@Component({ selector: 'app-loading-banner', template: '', standalone: true })
class StubLoadingBanner {
  readonly label = input<string>('');
}
@Component({ selector: 'app-error-banner', template: '', standalone: true })
class StubErrorBanner {
  readonly message = input<string>('');
  readonly retry = output<void>();
}
@Component({ selector: 'app-library-picker', template: '', standalone: true })
class StubLibraryPicker {
  readonly pick = output<string>();
}
@Component({ selector: 'app-timeline-view', template: '<p>timeline</p>', standalone: true })
class StubTimelineView {}
@Component({ selector: 'app-map-view', template: '<p>map</p>', standalone: true })
class StubMapView {}
@Component({ selector: 'app-asset-grid', template: '<p>grid</p>', standalone: true })
class StubAssetGrid {}
@Component({ selector: 'app-pano-dialog', template: '', standalone: true })
class StubPanoDialog {
  readonly visible = input<boolean>(false);
  readonly assetIds = input<string[]>([]);
  readonly dismiss = output<void>();
}
@Component({ selector: 'app-batch-metadata-panel', template: '', standalone: true })
class StubBatchMetadataPanel {
  readonly visible = input<boolean>(false);
  readonly assetSnapshots = input<unknown[]>([]);
  readonly dismiss = output<void>();
}
@Component({ selector: 'app-self-hosted-conditional-dialogs', template: '', standalone: true })
class StubConditionalDialogs {}

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

  function configureRenderBranchTest(viewMode: 'folder' | 'timeline' | 'map') {
    TestBed.configureTestingModule({
      imports: [SelfHostedBrowseContentComponent],
      providers: [
        {
          provide: LibraryStateService,
          useValue: {
            loadFolderTree: vi.fn(),
            backendLoading: signal(false),
            backendError: signal(null),
            backendEmpty: signal(false),
            viewMode: signal(viewMode),
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
      set: {
        imports: [
          StubLoadingBanner,
          StubErrorBanner,
          StubLibraryPicker,
          StubTimelineView,
          StubMapView,
          StubAssetGrid,
          StubPanoDialog,
          StubBatchMetadataPanel,
          StubConditionalDialogs,
        ],
      },
    });
    const fixture = TestBed.createComponent(SelfHostedBrowseContentComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('renders the map view when viewMode is "map"', () => {
    const fixture = configureRenderBranchTest('map');

    expect(fixture.nativeElement.querySelector('app-map-view')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-timeline-view')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-asset-grid')).toBeNull();
  });

  it('still renders the asset grid by default when viewMode is "folder"', () => {
    const fixture = configureRenderBranchTest('folder');

    expect(fixture.nativeElement.querySelector('app-asset-grid')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-map-view')).toBeNull();
  });
});
