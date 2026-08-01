import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { BrowseShellComponent, LibraryPickerModalComponent } from '@maple-common';
import { SelfHostedBrowseActionsComponent } from '../self-hosted-browse-actions/self-hosted-browse-actions.component';
import { SelfHostedBrowseContentComponent } from '../self-hosted-browse-content/self-hosted-browse-content.component';
import { SelfHostedBrowseControlsComponent } from '../self-hosted-browse-controls/self-hosted-browse-controls.component';
import { SelfHostedBrowseController } from './self-hosted-browse.controller';

@Component({
  selector: 'app-self-hosted-browse',
  standalone: true,
  imports: [
    BrowseShellComponent,
    LibraryPickerModalComponent,
    SelfHostedBrowseActionsComponent,
    SelfHostedBrowseContentComponent,
    SelfHostedBrowseControlsComponent,
  ],
  providers: [SelfHostedBrowseController],
  templateUrl: './self-hosted-browse.component.html',
  styleUrl: './self-hosted-browse.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelfHostedBrowseComponent {
  private readonly router = inject(Router);

  openSearch(): void {
    void this.router.navigate(['/search']);
  }
}
