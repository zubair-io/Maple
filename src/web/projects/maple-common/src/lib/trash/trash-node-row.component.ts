// TrashNodeRowComponent — the Trash pseudo-node row rendered per library
// root in the folder tree (#2652). Split out of
// `folder-tree.component.html` purely to keep that already-complex
// recursive template from growing further (a fallow-audit-web template-
// complexity finding on `folder-tree.component.html` came directly from
// inlining this markup there) — a plain presentational component with no
// capability/service imports of its own, so it's eager-safe for both apps
// exactly like the rest of `folder-tree.component.ts`.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MuiTreeRowComponent } from '../ui/tree-row/mui-tree-row.component';

@Component({
  selector: 'app-trash-node-row',
  standalone: true,
  imports: [MuiTreeRowComponent],
  templateUrl: './trash-node-row.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrashNodeRowComponent {
  readonly libraryLabel = input.required<string>();
  readonly badge = input<string | null>(null);

  readonly activate = output<void>();
}
