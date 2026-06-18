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
  protected readonly editor = inject(EditorStateService);

  protected readonly assetId = computed(() => this.library.focusedAssetId());
  protected readonly hasImage = computed(() => this.assetId() != null);
  protected readonly autoDisabled = computed(() => !this.hasImage() || this.editor.autoInFlight());

  constructor() {
    effect(() => {
      const id = this.assetId();
      if (id != null) this.editor.bind(id);
    });
  }

  protected onAuto(): void {
    const id = this.assetId();
    if (!id) return;
    void this.editor.applyAuto(id);
  }

  protected onReset(): void {
    if (this.hasImage()) this.editor.resetAll();
  }
}
