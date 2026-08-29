// MuiStatusText — the Maple UI design-system Status Text atom
// (unified-component-catalog.md §1.5; contract:
// docs/design/maple-ui/components/status-text.md). A persistence/sync
// state line — icon + short text — for idle/saving/saved/offline/error.
//
// Icon choices are constrained by the existing glyph registry (no wifi/
// cloud/spinner-dedicated icon exists yet — checked
// maple-icon-registry.ts): `history` reads as "in progress" for saving,
// `check`/`clear-circle-fill` are the existing success/error glyphs, and
// `x`/`dot` distinguish the quieter offline and idle states from the
// attention-grabbing filled error glyph.
//
// `error` renders `role="alert"` (MW2, #3029): the migrated
// `SaveStatusComponent` consumer used `role="alert"` (assertive) for a
// failed sidecar write specifically — a save failure needs to interrupt,
// not wait for the screen reader's next idle moment. Every other state
// keeps `role="status"` (polite).

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MuiIconComponent } from '../icon/mui-icon.component';
import type { MapleIconName } from '../icon/mui-icon.component';

export type MuiStatusTextState = 'idle' | 'saving' | 'saved' | 'offline' | 'error';

interface StatusPresentation {
  readonly icon: MapleIconName;
  readonly text: string;
  readonly colorVar: string;
}

const PRESENTATION: Record<MuiStatusTextState, StatusPresentation> = {
  idle: { icon: 'dot', text: 'Idle', colorVar: 'var(--color-text-muted)' },
  saving: { icon: 'history', text: 'Saving…', colorVar: 'var(--color-text-muted)' },
  saved: { icon: 'check', text: 'Saved', colorVar: 'var(--color-success-text)' },
  offline: { icon: 'x', text: 'Offline', colorVar: 'var(--color-text-muted)' },
  error: { icon: 'clear-circle-fill', text: 'Error', colorVar: 'var(--color-error-text)' },
};

@Component({
  selector: 'mui-status-text',
  standalone: true,
  imports: [MuiIconComponent],
  templateUrl: './mui-status-text.component.html',
  host: { class: 'inline-flex' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiStatusTextComponent {
  readonly state = input.required<MuiStatusTextState>();
  /** Overrides the default per-state text (e.g. "Saved 2m ago"). */
  readonly text = input<string | null>(null);

  readonly presentation = computed(() => PRESENTATION[this.state()]);
  readonly displayText = computed(() => this.text() ?? this.presentation().text);
  readonly role = computed(() => (this.state() === 'error' ? 'alert' : 'status'));
}
