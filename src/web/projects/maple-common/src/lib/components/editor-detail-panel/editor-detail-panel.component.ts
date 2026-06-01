// Editor detail panel — Info + Develop tabs.
// Info tab renders the responsive S6 `<app-info-panel>` (#634 consolidated
// the older `<maple-info-tab>` enrichment surface into it); Develop tab
// owns sliders + scopes.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { InfoPanelComponent } from '../../info/info-panel.component';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { DevelopTabComponent } from './develop-tab.component';

@Component({
  selector: 'editor-detail-panel',
  standalone: true,
  imports: [MapleIconComponent, InfoPanelComponent, DevelopTabComponent],
  styleUrl: './editor-detail-panel.component.scss',
  host: {
    class: 'flex flex-col h-full w-[280px] min-w-[280px] bg-surface overflow-hidden',
  },
  templateUrl: './editor-detail-panel.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorDetailPanelComponent {
  state = inject(LibraryStateService);
}
