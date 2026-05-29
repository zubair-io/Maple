// editor-header.component.ts — responsive-program S5a (#625).
//
// 44pt header with back chevron, filename (mono), undo (long-press = redo),
// share (stub), info. Layout per spec §2.

import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';

import { MapleIconComponent } from '../icons/maple-icon.component';
import { EditorStateService } from './editor-state.service';

@Component({
  selector: 'app-editor-header',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './editor-header.component.html',
  styleUrl: './editor-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorHeaderComponent {
  protected readonly state = inject(EditorStateService);
  readonly filename = input<string>('');
  readonly back = output<void>();
  readonly share = output<void>();
  readonly info = output<void>();

  // ── Long-press → redo on the undo button ─────────────────────────────────
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressed = false;

  protected onUndoPointerDown(): void {
    this.longPressed = false;
    this.longPressTimer = setTimeout(() => {
      this.longPressed = true;
      this.state.redo();
    }, 500);
  }

  protected onUndoPointerUp(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    if (!this.longPressed) this.state.undo();
  }

  protected onUndoPointerCancel(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }
}
