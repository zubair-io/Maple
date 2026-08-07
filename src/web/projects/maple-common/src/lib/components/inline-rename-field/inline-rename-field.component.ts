// InlineRenameFieldComponent — presentational edit-in-place filename field
// (#2637). Hosted by <app-library-cell> and <app-info-filename-row>, driven
// by AssetRenameService.
//
// The `<input>` carries the FULL filename (extension included, editable) —
// on mount it auto-focuses with the SELECTION scoped to just the stem, so a
// plain type-over replaces the name and leaves the extension untouched
// unless the user deliberately extends the selection over it. Retyping the
// extension is allowed (design doc), just flagged with an inline warning
// rather than blocked.
//
// Enter / the check button commits; Escape / the × button cancels. A
// collision reply (`collision` input true) swaps the input for three
// buttons — Replace / Keep Both / Cancel — instead of a modal dialog, so
// the user resolves it without losing their place in the grid/panel.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { splitFilenameExt } from '../../util/filename-ext';

@Component({
  selector: 'app-inline-rename-field',
  standalone: true,
  templateUrl: './inline-rename-field.component.html',
  styleUrl: './inline-rename-field.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'inline-rename-field',
  },
})
export class InlineRenameFieldComponent {
  /** Filename being renamed (with extension), before any edits. */
  readonly filename = input.required<string>();

  /** Server rejection message for the in-flight/last attempt, or null. */
  readonly error = input<string | null>(null);

  /** True while a commit request is in flight — disables all controls. */
  readonly busy = input<boolean>(false);

  /** True when the last attempt hit a same-name collision — renders the
   * Skip / Replace / Keep Both choice instead of the text input. */
  readonly collision = input<boolean>(false);

  readonly committed = output<string>();
  readonly cancelled = output<void>();
  readonly collisionResolved = output<'replace' | 'keep-both'>();

  private readonly inputRef = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  /** Full editable value — starts as `filename()`, mutated by the user. */
  readonly draft = signal('');

  private readonly originalStemLen = computed(() => splitFilenameExt(this.filename()).stem.length);

  /** True when the draft's extension no longer matches the original —
   * the design doc's "retyping it is allowed but warns" case. */
  readonly extensionChanged = computed(() => {
    const original = splitFilenameExt(this.filename()).ext;
    const current = splitFilenameExt(this.draft()).ext;
    return current !== original;
  });

  constructor() {
    // Seed the draft from the incoming filename and, once the field has
    // mounted, select just the stem so the user's first keystroke replaces
    // the name without touching the extension.
    effect(() => {
      const name = this.filename();
      const isCollision = this.collision();
      this.draft.set(name);
      const el = this.inputRef()?.nativeElement;
      if (el && !isCollision) {
        el.focus();
        el.setSelectionRange(0, this.originalStemLen());
      }
    });
  }

  onInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelled.emit();
    }
  }

  /** Blur commits too (standard inline-rename UX — Finder/Explorer/Lightroom
   * all commit on click-away) unless the collision choice is showing, where
   * a stray blur (e.g. tabbing between the three buttons) must not fire a
   * second request. */
  onBlur(): void {
    if (!this.collision()) this.commit();
  }

  commit(): void {
    this.committed.emit(this.draft());
  }

  cancel(): void {
    this.cancelled.emit();
  }

  resolveReplace(): void {
    this.collisionResolved.emit('replace');
  }

  resolveKeepBoth(): void {
    this.collisionResolved.emit('keep-both');
  }
}
