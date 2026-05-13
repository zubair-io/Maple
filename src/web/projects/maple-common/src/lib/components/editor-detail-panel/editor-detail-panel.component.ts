// Editor detail panel — Info + Develop tabs.
// Info tab reused from maple-common; Develop tab owns sliders + scopes.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { InfoTabComponent } from '../../detail-panel/info-tab.component';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { DevelopTabComponent } from './develop-tab.component';

@Component({
  selector: 'editor-detail-panel',
  standalone: true,
  imports: [MapleIconComponent, InfoTabComponent, DevelopTabComponent],
  styleUrl: './editor-detail-panel.component.scss',
  host: {
    class:
      'flex flex-col h-full w-[280px] min-w-[280px] bg-surface overflow-hidden',
  },
  templateUrl: './editor-detail-panel.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorDetailPanelComponent {
  state = inject(LibraryStateService);
}
