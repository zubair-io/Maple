// Right panel — TabBar + Info tab (Browse view).
// Ported from _design-reference/lib/detail.jsx (TabBar / InfoTab).

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { InfoTabComponent } from '../../detail-panel/info-tab.component';
import { MapleIconComponent } from '../../icons/maple-icon.component';

@Component({
  selector: 'app-detail-panel',
  standalone: true,
  imports: [MapleIconComponent, InfoTabComponent],
  styleUrl: './browse-detail-panel.component.scss',
  host: {
    class:
      'flex flex-col h-full w-[280px] min-w-[280px] bg-surface overflow-hidden',
  },
  templateUrl: './browse-detail-panel.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowseDetailPanelComponent {
  state = inject(LibraryStateService);
}
