// MoveToDialogComponent — keyboard-reachable equivalent of drag-move
// (#2644). The design doc requires drag-and-drop to have a
// keyboard-reachable equivalent (a drag-only affordance is unusable
// without a pointer); this is that equivalent — a folder-tree picker that
// reaches the exact same `DragMoveCapability.beginMove(..., 'move')` call a
// drop on a folder-tree row makes, so the collision dialog / summary
// banner / partial-failure handling (all owned by `DragMoveService`,
// rendered from `browse-shell.component.html`) all work identically
// whichever path started the move.
//
// Copy has no keyboard entry point here — the design doc's copy-modifier
// only makes sense as a drag gesture (a keyboard flow has no "held key
// during the drop" moment to read), so "Move to…" is move-only, same
// simplification the ticket's own wording anticipates ("probably
// simplest").
//
// Mounted directly (no `@defer`) by Self Hosted's `SelfHostedBrowseContent
// Component`, the same way `BatchRenameDialogComponent` (#2640) is — see
// that component's export note in `public-api.ts` for why plain
// non-deferred mounting is the correct, verified-safe shape when the
// trigger site is Self-Hosted-app-only (the "Move to…" toolbar button
// lives in `self-hosted-browse-actions.component.ts`, under
// `projects/maple`, not the shared shell).
//
// The recursive folder-tree row rendering lives in
// `MoveToTreePickerComponent` (#2644 review — fallow-audit-web flagged the
// combined dialog+tree template as HIGH complexity); this file is now just
// the dialog chrome (header/body/footer) plus the selection + confirm
// state the picker reports up to.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { LibraryStateService } from '../state/library-state.service';
import type { AssetId } from '../models/asset';
import type { SidebarEntry } from '../models/folder';
import { DRAG_MOVE_CAPABILITY } from './drag-move-capability';
import { MoveToTreePickerComponent } from './move-to-tree-picker.component';

@Component({
  selector: 'app-move-to-dialog',
  standalone: true,
  imports: [MoveToTreePickerComponent],
  templateUrl: './move-to-dialog.component.html',
  styleUrl: './move-to-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MoveToDialogComponent {
  readonly assetIds = input.required<AssetId[]>();
  /** Grid sub-folders to move alongside the assets (#2976) — `slug:relPath`
   * addresses under `sourceFolderId`. Same queue, same summary banner. */
  readonly folderIds = input<string[]>([]);
  readonly sourceFolderId = input.required<string>();

  readonly dismiss = output<void>();

  private readonly state = inject(LibraryStateService);
  private readonly dragMove = inject(DRAG_MOVE_CAPABILITY);

  protected readonly rootFolders = computed(() =>
    this.state.sidebarTree().filter((entry) => entry.kind === 'folder'),
  );

  protected readonly selectedNode = signal<SidebarEntry | null>(null);
  protected readonly selectedNodeId = computed(() => this.selectedNode()?.id ?? null);
  protected readonly canConfirm = computed(() => this.selectedNode() !== null);

  /** The tree picker (`move-to-tree-picker.component.ts`) already runs
   * `dropDisabledReason` before emitting `select`, so a disabled row never
   * reaches here — this just records the choice. */
  protected onNodeSelected(node: SidebarEntry): void {
    this.selectedNode.set(node);
  }

  onConfirm(): void {
    const target = this.selectedNode();
    if (!target) return;
    this.dragMove.beginMove(
      this.assetIds(),
      this.sourceFolderId(),
      target,
      'move',
      this.folderIds(),
    );
    this.dismiss.emit();
  }

  onCancel(): void {
    this.dismiss.emit();
  }

  onBackdropClick(): void {
    this.onCancel();
  }
}
