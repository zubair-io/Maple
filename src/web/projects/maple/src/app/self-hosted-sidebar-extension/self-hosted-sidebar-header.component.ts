import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AuthService, LibraryStateService, MuiButtonComponent } from '@maple-common';

@Component({
  selector: 'app-self-hosted-sidebar-header',
  standalone: true,
  imports: [MuiButtonComponent],
  templateUrl: './self-hosted-sidebar-header.component.html',
  styleUrl: './self-hosted-sidebar-header.component.scss',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelfHostedSidebarHeaderComponent {
  protected readonly state = inject(LibraryStateService);
  private readonly auth = inject(AuthService);
  protected readonly isOwner = computed(() => this.auth.user()?.role === 'owner');
}
