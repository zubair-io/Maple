// KeywordChipsRowComponent — S6 Info content section 4 (web).
//
// Editable in #632. Reads `asset.keywords` and mutates it via
// `LibraryStateService.setKeywords`, which routes through the same
// 750ms-debounced sidecar-write path the rating/flag/colorLabel
// mutators use — keywords have zero pixel impact, so no develop
// render is kicked.
//
// UI:
//   • Existing keywords render as 11pt rounded chips; the whole chip is
//     a remove button (tap to delete).
//   • A trailing dashed `+ Add` chip. Tapping it replaces the chip with
//     an inline `<input>` that auto-focuses; the field commits on Enter
//     (`(keydown.enter)`) and cancels on Escape (`(keydown.escape)`) or
//     blur. Phones get the OS-default keyboard docked against the field.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import type { Asset } from '../models/asset';
import { LibraryStateService } from '../state/library-state.service';

@Component({
  selector: 'app-keyword-chips-row',
  standalone: true,
  templateUrl: './keyword-chips-row.component.html',
  styleUrl: './keyword-chips-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-keywords',
  },
})
export class KeywordChipsRowComponent {
  private readonly library = inject(LibraryStateService);

  readonly asset = input<Asset | null>(null);

  protected readonly keywords = computed<readonly string[]>(() => this.asset()?.keywords ?? []);

  /** True while the inline `<input>` is mounted (the `+ Add` chip has
   * been tapped). Tracked locally so the parent component doesn't have
   * to know about the edit state. */
  protected readonly isEditing = signal(false);

  /** Bound to the inline input's `[value]` and read on commit / cancel.
   * Cleared after each commit so the next add session starts fresh. */
  protected readonly draft = signal('');

  /**
   * `@ViewChild` reference to the inline `<input>` — used to imperatively
   * focus it after Angular mounts the element. `{ static: false }` (the
   * default) is correct here because the input is gated on `@if isEditing()`
   * and only exists after change-detection has run the new template.
   */
  @ViewChild('addInput') private addInput?: ElementRef<HTMLInputElement>;

  protected openAddDraft(): void {
    this.draft.set('');
    this.isEditing.set(true);
    // Wait one microtask for Angular to render the input element before
    // focusing it; without the queueMicrotask wrapper the `<input>`
    // doesn't exist yet and `focus()` is a no-op.
    queueMicrotask(() => this.addInput?.nativeElement.focus());
  }

  protected onDraftInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.draft.set(target.value);
  }

  protected commitDraft(): void {
    const asset = this.asset();
    if (!asset) {
      this.cancelDraft();
      return;
    }
    const trimmed = this.draft().trim();
    if (trimmed.length > 0) {
      this.library.setKeywords(asset.id, [...(asset.keywords ?? []), trimmed]);
    }
    this.draft.set('');
    this.isEditing.set(false);
  }

  protected cancelDraft(): void {
    this.draft.set('');
    this.isEditing.set(false);
  }

  protected removeKeyword(keyword: string): void {
    const asset = this.asset();
    if (!asset) return;
    this.library.setKeywords(
      asset.id,
      (asset.keywords ?? []).filter((k) => k !== keyword),
    );
  }
}
