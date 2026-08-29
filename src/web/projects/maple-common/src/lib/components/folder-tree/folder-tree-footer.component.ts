// FolderTreeFooterComponent — the folder-tree's crud dialog (`@defer`red)
// plus the trash-partial-failure toast (#2749 review: extracted out of
// `folder-tree.component.html` to help clear a fallow-audit-web
// template-complexity finding on that file). `FolderTreeComponent` still
// owns the actual `crudRequest`/`trashPartialWarning` state and the
// mutation-handling logic (`onCrudMutated` etc.) — this component only
// hosts the markup and relays events, so the `@defer` boundary and
// `FolderTreeCrudComponent` import stay exactly where the Hosted-capability
// boundary check (`check-hosted-capability-boundary.mjs`) already expects
// a deferred-only reference.

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import {
  FolderTreeCrudComponent,
  type FolderCrudMutation,
  type FolderCrudRequest,
} from './folder-tree-crud.component';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';

@Component({
  selector: 'app-folder-tree-footer',
  standalone: true,
  imports: [FolderTreeCrudComponent, MuiButtonComponent],
  templateUrl: './folder-tree-footer.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FolderTreeFooterComponent {
  readonly crudRequest = input<FolderCrudRequest | null>(null);
  readonly trashPartialWarning = input<string | null>(null);

  readonly crudClosed = output<void>();
  readonly crudMutated = output<FolderCrudMutation>();
  readonly dismissTrashPartialWarning = output<void>();
}
