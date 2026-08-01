import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import {
  AssetGridComponent,
  BatchMetadataPanelComponent,
  ErrorBannerComponent,
  LibraryPickerComponent,
  LibraryStateService,
  LoadingBannerComponent,
  PanoDialogComponent,
  TimelineViewComponent,
} from '@maple-common';
import { SelfHostedBrowseController } from '../self-hosted-browse/self-hosted-browse.controller';

@Component({
  selector: 'app-self-hosted-browse-content',
  standalone: true,
  imports: [
    AssetGridComponent,
    BatchMetadataPanelComponent,
    ErrorBannerComponent,
    LibraryPickerComponent,
    LoadingBannerComponent,
    PanoDialogComponent,
    TimelineViewComponent,
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
