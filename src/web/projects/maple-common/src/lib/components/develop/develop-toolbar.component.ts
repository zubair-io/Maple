// Develop toolbar — global AUTO / RESET actions for the develop tab (#1372).
//
// Hosts the editor-wide actions that affect ALL sliders at once. RESET lands
// here in M1; the AUTO button is added in M2 once the raw-core analysis is
// wired through the worker.
//
// The desktop develop tab is rendered by EditorShellComponent, which never
// binds EditorStateService (its sections mutate LibraryStateService directly
// and key off `focusedAssetId`). We bind the editor state to the focused
// asset here so RESET's commit/undo snapshot attaches to the right image and
// survives filmstrip switches — without it, `EditorStateService.imageId`
// would be null on the shell and RESET would no-op.

import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';

@Component({
  selector: 'editor-develop-toolbar',
  standalone: true,
  templateUrl: './develop-toolbar.component.html',
  styleUrl: './develop-toolbar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DevelopToolbarComponent {
  private readonly library = inject(LibraryStateService);
  private readonly editor = inject(EditorStateService);

  protected readonly assetId = computed(() => this.library.focusedAssetId());
  protected readonly hasImage = computed(() => this.assetId() != null);

  constructor() {
    effect(() => {
      const id = this.assetId();
      if (id != null) this.editor.bind(id);
    });
  }

  protected onReset(): void {
    if (this.hasImage()) this.editor.resetAll();
  }
}
