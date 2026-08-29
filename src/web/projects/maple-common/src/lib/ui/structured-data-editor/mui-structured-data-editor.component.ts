// MuiStructuredDataEditor — Maple UI Organisms, Wave W6 Lane B "Editing
// surfaces" (unified-component-catalog.md §4.5). A flat key/value object
// (string/number/boolean leaves only — no nesting, per this component's
// v1 scope) editable either as raw JSON or as a generated form. Built
// from: Code Block, Form Field, Tabs.
//
// `mui-code-block` is read-only (a display molecule with a copy button,
// no edit output) — the Code tab uses a plain `<textarea>` styled to match
// its monospace look instead, since there is no editable code-block atom
// to reuse.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  model,
  output,
  signal,
} from '@angular/core';
import { MuiTabsComponent, type MuiTab } from '../tabs/mui-tabs.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';

export type StructuredDataValue = Record<string, string | number | boolean>;

const VIEW_TABS: readonly MuiTab[] = [
  { id: 'code', label: 'Code' },
  { id: 'form', label: 'Form' },
];

const FLAT_OBJECT_ERROR = 'Value must be a flat object of strings, numbers, or booleans';

/** Re-coerces a form field's raw string input back to the type its
 * previous value had — a number stays a number, a boolean stays a
 * boolean, everything else stays a string. */
function coerceLike(original: string | number | boolean, raw: string): string | number | boolean {
  if (typeof original === 'number') return Number(raw);
  if (typeof original === 'boolean') return raw === 'true';
  return raw;
}

function isFlatObject(candidate: unknown): candidate is StructuredDataValue {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  return Object.values(candidate).every(
    (leaf) => typeof leaf === 'string' || typeof leaf === 'number' || typeof leaf === 'boolean',
  );
}

@Component({
  selector: 'mui-structured-data-editor',
  standalone: true,
  imports: [MuiTabsComponent, MuiFormFieldComponent],
  templateUrl: './mui-structured-data-editor.component.html',
  host: { class: 'flex flex-col gap-4' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiStructuredDataEditorComponent {
  /** The flat object as the source of truth. */
  readonly value = model<StructuredDataValue>({});
  /** Mirrors the internal error state on every change — `null` when the
   * current raw text parses to a valid flat object. */
  readonly parseError = output<string | null>();

  readonly viewMode = model<string>('code');
  readonly tabs = VIEW_TABS;

  readonly codeText = signal(JSON.stringify(this.value(), null, 2));
  readonly error = signal<string | null>(null);

  readonly formEntries = computed(() => Object.entries(this.value()));

  // Which direction the last `value()` write came from — set right before
  // (and cleared right after) a write that originated from a *successful*
  // code-tab parse, so the sync effect below can skip re-stringifying the
  // object it just derived the text from, without ever clobbering an
  // unparseable draft the user is mid-typing.
  private syncingFromCode = false;

  constructor() {
    effect(() => {
      const next = this.value();
      if (this.syncingFromCode) return;
      this.codeText.set(JSON.stringify(next, null, 2));
    });
  }

  stringifyValue(value: string | number | boolean): string {
    return String(value);
  }

  onCodeInput(event: Event): void {
    const raw = (event.target as HTMLTextAreaElement).value;
    this.codeText.set(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (caught) {
      this.fail(caught instanceof Error ? caught.message : 'Invalid JSON');
      return;
    }
    if (!isFlatObject(parsed)) {
      this.fail(FLAT_OBJECT_ERROR);
      return;
    }

    this.syncingFromCode = true;
    this.value.set(parsed);
    this.syncingFromCode = false;
    this.error.set(null);
    this.parseError.emit(null);
  }

  onFieldCommit(key: string, raw: string): void {
    const current = this.value();
    const coerced = coerceLike(current[key], raw);
    // Immutable update — spreads into a new object rather than mutating
    // the existing one, and preserves key order since the spread only
    // overwrites `key`'s value in place.
    this.value.set({ ...current, [key]: coerced });
  }

  private fail(message: string): void {
    // A parse failure never touches `value()` (or the form fields it
    // drives) — only the error banner reflects the bad draft.
    this.error.set(message);
    this.parseError.emit(message);
  }
}
