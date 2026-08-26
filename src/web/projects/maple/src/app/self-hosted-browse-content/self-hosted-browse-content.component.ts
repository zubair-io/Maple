import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import {
  AssetGridComponent,
  BatchMetadataPanelComponent,
  LibraryPickerComponent,
  LibraryStateService,
  MapViewComponent,
  MuiBannerComponent,
  PanoDialogComponent,
  TimelineViewComponent,
} from '@maple-common';
import { SelfHostedBrowseController } from '../self-hosted-browse/self-hosted-browse.controller';
import { SelfHostedConditionalDialogsComponent } from '../self-hosted-conditional-dialogs/self-hosted-conditional-dialogs.component';

@Component({
  selector: 'app-self-hosted-browse-content',
  standalone: true,
  imports: [
    AssetGridComponent,
    BatchMetadataPanelComponent,
    LibraryPickerComponent,
    MapViewComponent,
    MuiBannerComponent,
    PanoDialogComponent,
    TimelineViewComponent,
    // Batch Rename (#2640) / Move to… (#2644) / Trash panel (#2652) — see
    // `SelfHostedConditionalDialogsComponent`'s module doc: same
    // non-`@defer`red, physical-separation shape (this file lives only
    // under `projects/maple`, so plain tree-shaking keeps those dialogs —
    // and `BatchRenameService`/`TrashApiService`'s server-only routes —
    // out of Hosted's build entirely), just relocated to its own file to
    // keep this template's complexity down (#2749 review).
    SelfHostedConditionalDialogsComponent,
  ],
  templateUrl: './self-hosted-browse-content.component.html',
  styleUrl: './self-hosted-browse-content.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelfHostedBrowseContentComponent implements OnInit {
  protected readonly state = inject(LibraryStateService);
  protected readonly controller = inject(SelfHostedBrowseController);

  ngOnInit(): void {
    this.state.loadFolderTree();
  }
}
