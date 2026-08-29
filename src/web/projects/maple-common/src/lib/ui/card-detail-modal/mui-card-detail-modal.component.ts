// MuiCardDetailModal — Maple UI Organisms (Wave W6 Lane B). Expanded
// board-card editor — title, priority, body — built from Overlay Shell,
// Form Field, Chip Row.
//
// The rich-text-editor organism another Wave-W6 agent is building in
// parallel is intentionally NOT used here (it isn't available at build
// time). The body is instead a plain `contenteditable` block owned directly
// by this component: its content is written into the DOM only when the
// modal opens (so a live re-render from the caller never fights the user's
// cursor mid-edit), and every `input` event syncs the text back into the
// `body` model.

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  model,
  output,
  viewChild,
} from '@angular/core';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiChipRowComponent } from '../chip-row/mui-chip-row.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';
import { MuiTextComponent } from '../text/mui-text.component';

export interface MuiCardDetailData {
  readonly title: string;
  readonly priority: string | null;
  readonly body: string;
}

const DEFAULT_PRIORITIES: readonly MuiChip[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

@Component({
  selector: 'mui-card-detail-modal',
  standalone: true,
  imports: [
    MuiButtonComponent,
    MuiChipRowComponent,
    MuiFormFieldComponent,
    MuiOverlayShellComponent,
    MuiTextComponent,
  ],
  templateUrl: './mui-card-detail-modal.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiCardDetailModalComponent {
  readonly open = input<boolean>(false);
  readonly title = model<string>('');
  readonly priorityOptions = input<readonly MuiChip[]>(DEFAULT_PRIORITIES);
  readonly selectedPriority = model<string | null>(null);
  readonly body = model<string>('');

  readonly saved = output<MuiCardDetailData>();
  readonly dismissed = output<void>();

  readonly bodyEl = viewChild<ElementRef<HTMLDivElement>>('bodyEl');

  readonly canSave = computed(() => this.title().trim().length > 0);

  constructor() {
    // Sync the contenteditable body into the DOM only on open — keystrokes
    // flow the other direction via onBodyInput, so this never clobbers an
    // in-progress edit.
    effect(() => {
      if (!this.open()) return;
      const el = this.bodyEl()?.nativeElement;
      if (el && el.textContent !== this.body()) el.textContent = this.body();
    });
  }

  onBodyInput(event: Event): void {
    const el = event.target as HTMLDivElement;
    this.body.set(el.textContent ?? '');
  }

  save(): void {
    if (!this.canSave()) return;
    this.saved.emit({
      title: this.title(),
      priority: this.selectedPriority(),
      body: this.body(),
    });
  }

  onDismiss(): void {
    this.dismissed.emit();
  }
}
