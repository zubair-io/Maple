import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import {
  AssetGridComponent,
  BatchMetadataPanelComponent,
  BatchRenameDialogComponent,
  ErrorBannerComponent,
  LibraryPickerComponent,
  LibraryStateService,
  LoadingBannerComponent,
  MoveToDialogComponent,
  PanoDialogComponent,
  TimelineViewComponent,
  TrashPanelComponent,
  TrashService,
} from '@maple-common';
import { SelfHostedBrowseController } from '../self-hosted-browse/self-hosted-browse.controller';

@Component({
  selector: 'app-self-hosted-browse-content',
  standalone: true,
  imports: [
    AssetGridComponent,
    BatchMetadataPanelComponent,
    // Mounted directly, same shape as `BatchMetadataPanelComponent` right
    // above — see `public-api.ts`'s #2640 note for why this stays
    // non-`@defer`red: this file lives only under `projects/maple`, so
    // plain tree-shaking already keeps it (and `BatchRenameService`'s
    // `/assets/by-address` call) out of Hosted's build entirely.
    BatchRenameDialogComponent,
    ErrorBannerComponent,
    LibraryPickerComponent,
    LoadingBannerComponent,
    // Same non-`@defer`red, physical-separation shape as
    // `BatchRenameDialogComponent` above (#2644) — this file lives only
    // under `projects/maple`.
    MoveToDialogComponent,
    PanoDialogComponent,
    TimelineViewComponent,
    // Trash panel (#2652) — same shape again; the trigger (the folder-tree
    // Trash row) only ever reaches `TrashService` through the
    // `TRASH_CAPABILITY` token, so this is the one place that actually
    // mounts `<app-trash-panel>`.
    TrashPanelComponent,
  ],
  templateUrl: './self-hosted-browse-content.component.html',
  styleUrl: './self-hosted-browse-content.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelfHostedBrowseContentComponent implements OnInit {
  protected readonly state = inject(LibraryStateService);
  protected readonly controller = inject(SelfHostedBrowseController);
  protected readonly trash = inject(TrashService);

  ngOnInit(): void {
    this.state.loadFolderTree();
  }
}
