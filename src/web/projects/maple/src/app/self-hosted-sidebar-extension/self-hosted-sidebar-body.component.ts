import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LibraryStateService, MapleIconComponent } from '@maple-common';

@Component({
  selector: 'app-self-hosted-sidebar-body',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './self-hosted-sidebar-body.component.html',
  styleUrl: './self-hosted-sidebar-body.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelfHostedSidebarBodyComponent {
  protected readonly state = inject(LibraryStateService);
}
