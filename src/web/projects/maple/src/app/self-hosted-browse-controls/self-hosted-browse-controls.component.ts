import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LibraryStateService, MapleIconComponent } from '@maple-common';

@Component({
  selector: 'app-self-hosted-browse-controls',
  standalone: true,
  imports: [MapleIconComponent, RouterLink],
  templateUrl: './self-hosted-browse-controls.component.html',
  styleUrl: './self-hosted-browse-controls.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelfHostedBrowseControlsComponent {
  protected readonly state = inject(LibraryStateService);
  private readonly router = inject(Router);

  onSearchInput(event: Event): void {
    this.state.searchQuery.set((event.target as HTMLInputElement).value);
  }

  openSearch(): void {
    const query = this.state.searchQuery().trim();
    void this.router.navigate(['/search'], { queryParams: query ? { q: query } : {} });
  }
}
