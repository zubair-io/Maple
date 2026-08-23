// Shared "click text to edit inline, Enter commits, Escape cancels" logic for
// the Maple UI single-field inline editors (mui-description-field,
// mui-place-row — unified-component-catalog.md §3). Not part of the public
// API surface (see ../public-api.ts).

import { Directive, type WritableSignal, signal } from '@angular/core';

/** Commits a trimmed draft: closes editing, and — unless the trimmed value
 * is unchanged (or, when `allowEmpty` is false, empty) — writes it back
 * through `current` and returns the committed value so the caller can emit
 * its own `committed` output. Returns `null` when nothing should be
 * emitted. */
export function commitEditDraft(
  draft: string,
  currentValue: string,
  current: WritableSignal<string>,
  editing: WritableSignal<boolean>,
  allowEmpty: boolean,
): string | null {
  editing.set(false);
  const next = draft.trim();
  if (next === currentValue) return null;
  if (!allowEmpty && next.length === 0) return null;
  current.set(next);
  return next;
}

/** The `editing`/`draft` state + `startEditing()`/`onKeydown()` wiring
 * shared by every single-field inline editor (mui-description-field,
 * mui-place-row): click text to edit, Enter commits, Escape cancels. An
 * `@Directive()` abstract base (Angular's supported pattern for sharing
 * component behavior without a template — same shape as
 * `DestructiveConfirmDialogBase`), not a third free-function copy each
 * subclass re-wires by hand: the two fields and two methods were already
 * byte-identical. Each subclass supplies `currentValue()` (what to seed the
 * draft from) and its own `commit()` — the one place they genuinely
 * diverge, since `commit()`'s target field and `allowEmpty` policy (a
 * description may commit empty; a place override never does) are
 * per-molecule. */
@Directive()
export abstract class InlineEditBase {
  readonly editing = signal(false);
  readonly draft = signal('');

  protected abstract currentValue(): string;

  abstract commit(): void;

  startEditing(): void {
    this.draft.set(this.currentValue());
    this.editing.set(true);
  }

  onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'Enter':
        event.preventDefault();
        this.commit();
        break;
      case 'Escape':
        event.preventDefault();
        this.editing.set(false);
        break;
    }
  }
}
