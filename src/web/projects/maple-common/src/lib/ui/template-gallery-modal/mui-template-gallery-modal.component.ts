// MuiTemplateGalleryModal — Maple UI Organisms (Wave W6 Lane B). Browse and
// apply an edit template — built from Overlay Shell, Search Bar, Card,
// Empty State.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiCardComponent } from '../card/mui-card.component';
import { MuiEmptyStateComponent } from '../empty-state/mui-empty-state.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';
import { MuiSearchBarComponent } from '../search-bar/mui-search-bar.component';

export interface MuiGalleryTemplate {
  readonly id: string;
  readonly name: string;
  readonly thumbnailUrl: string;
  readonly description?: string | null;
  readonly category?: string | null;
}

@Component({
  selector: 'mui-template-gallery-modal',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiCardComponent,
    MuiEmptyStateComponent,
    MuiOverlayShellComponent,
    MuiSearchBarComponent,
  ],
  templateUrl: './mui-template-gallery-modal.component.html',
  styleUrl: './mui-template-gallery-modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiTemplateGalleryModalComponent {
  readonly open = input<boolean>(false);
  readonly templates = input.required<readonly MuiGalleryTemplate[]>();
  readonly search = model<string>('');

  readonly templateApplied = output<MuiGalleryTemplate>();
  readonly dismissed = output<void>();

  readonly filteredTemplates = computed(() => {
    const query = this.search().trim().toLowerCase();
    if (query.length === 0) return this.templates();
    return this.templates().filter((template) => {
      const haystack = `${template.name} ${template.description ?? ''} ${template.category ?? ''}`;
      return haystack.toLowerCase().includes(query);
    });
  });

  apply(template: MuiGalleryTemplate): void {
    this.templateApplied.emit(template);
  }

  onDismiss(): void {
    this.dismissed.emit();
  }
}
