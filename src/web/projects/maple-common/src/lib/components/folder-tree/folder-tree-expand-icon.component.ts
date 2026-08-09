// FolderTreeExpandIconComponent — the chevron/spinner/error-glyph/spacer
// corner of a folder row (#2749 review: extracted out of
// `folder-tree-node.component.html` to help clear a fallow-audit-web
// template-complexity finding — the three-way loading/error/chevron
// `@if`/`@else-if`/`@else` nested inside an outer expandable/not-expandable
// `@if` was the single biggest cognitive-complexity contributor in that
// template). Plain presentational component, no service imports.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MapleIconComponent } from '../../icons/maple-icon.component';

@Component({
  selector: 'app-folder-tree-expand-icon',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './folder-tree-expand-icon.component.html',
  styleUrl: './folder-tree-expand-icon.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeExpandIconComponent {
  readonly canExpand = input.required<boolean>();
  readonly isOpen = input(false);
  readonly isLoading = input(false);
  readonly hasError = input(false);
  readonly errorTitle = input<string | undefined>(undefined);

  readonly toggle = output<void>();

  /** Stops the native click from bubbling to the row's own `(click)`
   * (row selection) before emitting — matches the original inline
   * template's `onChevronClick(node, $event)` which called
   * `e.stopPropagation()` for the same reason: expanding/collapsing must
   * not also select the row. */
  onClick(event: MouseEvent): void {
    event.stopPropagation();
    this.toggle.emit();
  }
}
