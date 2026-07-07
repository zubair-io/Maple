// presets-panel.component.ts — presets list + save/apply/delete (#1115).
//
// Shared content mounted by both editors: the retired S5 editor's presets
// pill (bottom sheet on phone/tablet, popover card on desktop) and the
// canvas-first editor's Presets dock panel (`EditorShellComponent`, #1815).
// Lists built-ins (read-only) and user presets; applying routes through
// `EditorStateService.applyPreset` (sparse merge → ONE undo entry →
// existing debounced sidecar save).
//
// Delete is two-step: the trash affordance flips the row into an inline
// "Delete?" confirm — no native confirm() dialogs.

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';

import { MapleIconComponent } from '../../icons/maple-icon.component';
import { EditorStateService } from '../editor-state.service';
import { capturePresetFields, type Preset } from './preset-model';
import { PresetsService } from './presets.service';

@Component({
  selector: 'app-presets-panel',
  standalone: true,
  imports: [MapleIconComponent],
  templateUrl: './presets-panel.component.html',
  styleUrl: './presets-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PresetsPanelComponent implements OnInit {
  protected readonly presets = inject(PresetsService);
  protected readonly state = inject(EditorStateService);

  /** Fires after a preset was applied so the host can close the sheet. */
  readonly applied = output<void>();

  /** Draft name for the save row. */
  protected readonly draftName = signal('');
  /** Preset id currently in the inline delete-confirm state. */
  protected readonly confirmingDeleteId = signal<string | null>(null);

  /** Sparse capture of the current edit state — what "Save" would store. */
  protected readonly capturedFields = computed(() => {
    const adj = this.state.currentAdjustment();
    return adj ? capturePresetFields(adj) : {};
  });
  protected readonly capturedCount = computed(() => Object.keys(this.capturedFields()).length);
  protected readonly canSave = computed(
    () => this.capturedCount() > 0 && this.draftName().trim().length > 0 && !this.presets.busy(),
  );

  ngOnInit(): void {
    if (!this.presets.loaded()) {
      void this.presets.load();
    }
  }

  protected apply(preset: Preset): void {
    if (this.state.applyPreset(preset)) {
      this.applied.emit();
    }
  }

  protected async save(): Promise<void> {
    const created = await this.presets.save(this.draftName(), this.capturedFields());
    if (created) {
      this.draftName.set('');
    }
  }

  protected onDraftNameInput(event: Event): void {
    this.draftName.set((event.target as HTMLInputElement).value);
  }

  protected requestDelete(preset: Preset): void {
    this.confirmingDeleteId.set(preset.id);
  }

  protected cancelDelete(): void {
    this.confirmingDeleteId.set(null);
  }

  protected async confirmDelete(preset: Preset): Promise<void> {
    if (await this.presets.delete(preset)) {
      this.confirmingDeleteId.set(null);
    }
  }

  /** One-line summary of a preset's sparse fields, e.g. "2 settings". */
  protected fieldSummary(preset: Preset): string {
    const n = Object.keys(preset.fields).length;
    return n === 1 ? '1 setting' : `${n} settings`;
  }
}
