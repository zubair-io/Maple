// SelfHostedConditionalDialogsComponent — the three `@if`-gated, "mount
// fresh per open" dialogs `self-hosted-browse-content.component.ts` hosts
// (Batch Rename #2640, Move to… #2644, Trash panel #2652). Extracted out
// of that file to help clear a fallow-audit-web template-complexity
// finding there (#2749 review) — three `@if` blocks were the majority of
// its cyclomatic/cognitive weight. Lives under `projects/maple`, same as
// the file it was extracted from, so the physical-separation shape that
// keeps `BatchRenameDialogComponent`/`MoveToDialogComponent`/
// `TrashPanelComponent` out of Hosted's build (see `public-api.ts`'s #2640
// note) is unaffected — this is just where the `@if`s that mount them now
// live.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  BatchRenameDialogComponent,
  MoveToDialogComponent,
  TrashPanelComponent,
  TrashService,
} from '@maple-common';
import { SelfHostedBrowseController } from '../self-hosted-browse/self-hosted-browse.controller';

@Component({
  selector: 'app-self-hosted-conditional-dialogs',
  standalone: true,
  imports: [BatchRenameDialogComponent, MoveToDialogComponent, TrashPanelComponent],
  templateUrl: './self-hosted-conditional-dialogs.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelfHostedConditionalDialogsComponent {
  protected readonly controller = inject(SelfHostedBrowseController);
  protected readonly trash = inject(TrashService);
}
