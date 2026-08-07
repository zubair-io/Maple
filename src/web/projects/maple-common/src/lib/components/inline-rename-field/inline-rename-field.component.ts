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
  // Tailwind utility classes in the template, no dedicated stylesheet
  // (#2706 web-build bundle-size fix — matches this app's prevailing
  // convention, e.g. `asset-thumb.component.html`, and keeps this
  // shared-in-both-apps component's Hosted-bundle footprint minimal).
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'inline-rename-field',
  },
})
export class InlineRenameFieldComponent {
  /** Per-instance DOM id prefix (#2706 review) — the grid tile and the Info
   * panel can both host a live field for the same focused asset at once, so
   * a hard-coded `rename-input` id would collide and break the label /
   * aria-describedby wiring for whichever instance rendered second. */
  private static _nextUid = 0;
  protected readonly fieldId = `inline-rename-field-${InlineRenameFieldComponent._nextUid++}`;

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

  /** Filename this field was last (re)seeded for — the dedup guard the
   * constructor effect uses to tell "a genuinely new edit session started"
   * apart from "the `<input>` element merely got destroyed/recreated by an
   * unrelated `@if` toggle" (#2706 review, see below). */
  private _lastSeededFor: string | null = null;

  constructor() {
    // Seed the draft from the incoming filename and, once the field has
    // mounted, select just the stem so the user's first keystroke replaces
    // the name without touching the extension.
    //
    // Gated on `_lastSeededFor !== name`, NOT just "the input exists"
    // (#2706 review): the template's `@if (collision()) {…} @else { <input
    // #nameInput> }` destroys and recreates the `<input>` on every
    // collision-state flip, which flips `inputRef()` too — and this effect
    // reads `inputRef()`, so it re-runs on that flip regardless of whether
    // `filename()` changed. An earlier version reset `draft` unconditionally
    // on every run, which wiped the user's attempted name back to the
    // ORIGINAL filename the instant a collision response arrived — right
    // when the collision message (which reads `draft()`) needs to keep
    // showing it. The dedup guard makes a collision round-trip (input
    // destroyed → collision UI shown → input recreated on retry) a no-op
    // for `draft`, while a genuinely new filename (a fresh field instance,
    // since each edit session mounts a new component) still seeds once.
    effect(() => {
      const name = this.filename();
      // Seed BEFORE checking for the element (deliberately unconditional on
      // `el`, gated only on the dedup check): the `<input>` doesn't exist
      // yet on this effect's first run, and if `draft` weren't already
      // correct by the time Angular creates it, the element would mount
      // with an empty value, then have `.value` overwritten while focused
      // on a later run — which collapses the just-applied selection to the
      // end (a real browser behavior, not a framework bug). Seeding early
      // means the `<input>` is born with the right value, so the
      // focus+select run below never has to fight a value-while-focused
      // reset.
      if (this._lastSeededFor !== name) {
        this._lastSeededFor = name;
        this.draft.set(name);
      }
      const el = this.inputRef()?.nativeElement;
      if (el) {
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
