// TimelineMonth — renders one month section (header, folder groups, photo
// grid) or its collapsed placeholder. Extracted from TimelineViewComponent
// so the parent template doesn't own the full photo-grid branching itself;
// this component owns its own (session-local, not persisted) folder-group
// collapse state since collapsing one month's "vacation" group has no
// bearing on any other month's groups.

import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { PhotoVm } from './timeline-view.utils';
import { TimelineRegisterSectionDirective } from './timeline-register-section.directive';

export interface RenderedMonth {
  year: number;
  month: number;
  count: number;
  groups: Array<{ folderName: string; photos: PhotoVm[] }>;
  isVisible: boolean;
  placeholderHeight: number;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

@Component({
  selector: 'app-timeline-month',
  standalone: true,
  imports: [TimelineRegisterSectionDirective],
  templateUrl: './timeline-month.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimelineMonthComponent {
  readonly state = inject(LibraryStateService);

  readonly month = input.required<RenderedMonth>();
  readonly registerSection = input.required<(el: HTMLElement) => void>();

  readonly photoClick = output<{ photo: PhotoVm; event: MouseEvent }>();
  readonly photoDblClick = output<PhotoVm>();

  // ── Folder-group collapse (session-local; not persisted) ────────────────
  // A missing entry means expanded — the default is "show photos" so the
  // user sees content first.
  private readonly _collapsed = new Set<string>();

  isCollapsed(folderName: string): boolean {
    return this._collapsed.has(folderName);
  }

  toggleGroup(folderName: string): void {
    if (this._collapsed.has(folderName)) this._collapsed.delete(folderName);
    else this._collapsed.add(folderName);
  }

  monthLabel(m: number): string {
    return MONTH_NAMES[m - 1] ?? String(m);
  }

  folderGroupLabel(name: string): string {
    return name === '.' ? '(this folder)' : name;
  }

  trackGroup = (_: number, g: { folderName: string; photos: PhotoVm[] }): string => g.folderName;
  trackPhoto = (_: number, p: PhotoVm): string => p.id;
}
