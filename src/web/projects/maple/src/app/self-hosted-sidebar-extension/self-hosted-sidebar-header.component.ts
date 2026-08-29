import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LibraryStateService } from '@maple-common';

@Component({
  selector: 'app-self-hosted-sidebar-header',
  standalone: true,
  templateUrl: './self-hosted-sidebar-header.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelfHostedSidebarHeaderComponent {
  protected readonly state = inject(LibraryStateService);
}
