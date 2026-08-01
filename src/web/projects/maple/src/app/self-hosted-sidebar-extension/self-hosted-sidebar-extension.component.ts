import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LibraryStateService, MapleIconComponent } from '@maple-common';

@Component({
  selector: 'app-self-hosted-sidebar-extension',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './self-hosted-sidebar-extension.component.html',
  styleUrl: './self-hosted-sidebar-extension.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelfHostedSidebarExtensionComponent {
  protected readonly state = inject(LibraryStateService);
}
