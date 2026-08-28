// presets-panel.component.ts — presets list + save/apply/delete (#1115).
//
// Shared content mounted by both editors: the retired S5 editor's presets
// pill (bottom sheet on phone/tablet, popover card on desktop) and the
// canvas-first editor's Presets dock panel (`EditorShellComponent`, #1815).
// Lists built-ins (read-only) and user presets; applying routes through
// `EditorStateService.applyPreset` (sparse merge → ONE undo entry →
// existing debounced sidecar save).
//
// Chrome now delegates to `mui-presets-panel` (#3046), mounted TWICE — once
// per section, matching the Built-in/Saved split the design-system
// organism doesn't have a native notion of:
//  - Built-in: `showDeleteAction="false"` (bundled presets can't be
//    deleted), `loading="false"` (the bundled list is always ready).
//  - Saved: the user's own presets, `confirmMode="inline"` — the row-flip
//    delete-confirm behavior-preservation decision (#3046: extend
//    `mui-presets-panel` with an inline mode rather than switching this
//    workflow to its modal default).
// Both mounts set `showSaveTrigger="false"`: Save itself stays this
// wrapper's own always-visible name input + button (never a prompt
// dialog — that was never the legacy interaction to begin with).

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';

import { EditorStateService } from '../editor-state.service';
import { capturePresetFields, type Preset } from './preset-model';
import { PresetsService } from './presets.service';
import { MuiPresetsPanelComponent } from '../../ui/presets-panel/mui-presets-panel.component';
import type { MuiPresetItem } from '../../ui/presets-panel/mui-presets-panel.component';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';

@Component({
  selector: 'app-presets-panel',
  standalone: true,
  imports: [MuiPresetsPanelComponent, MuiButtonComponent],
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

  /** Sparse capture of the current edit state — what "Save" would store. */
  protected readonly capturedFields = computed(() => {
    const adj = this.state.currentAdjustment();
    return adj ? capturePresetFields(adj) : {};
  });
  protected readonly capturedCount = computed(() => Object.keys(this.capturedFields()).length);
  protected readonly canSave = computed(
    () => this.capturedCount() > 0 && this.draftName().trim().length > 0 && !this.presets.busy(),
  );

  /** Built-in presets as `mui-presets-panel` items — no timestamp of their
   *  own, so the field-count summary fills the subtitle line instead. */
  protected readonly builtinItems = computed<readonly MuiPresetItem[]>(() =>
    this.presets.builtins.map((p) => ({ id: p.id, name: p.name, subtitle: this.fieldSummary(p) })),
  );
  protected readonly userItems = computed<readonly MuiPresetItem[]>(() =>
    this.presets.userPresets().map((p) => ({
      id: p.id,
      name: p.name,
      subtitle: this.fieldSummary(p),
    })),
  );

  ngOnInit(): void {
    if (!this.presets.loaded()) {
      void this.presets.load();
    }
  }

  private findPreset(id: string): Preset | null {
    return (
      this.presets.builtins.find((p) => p.id === id) ??
      this.presets.userPresets().find((p) => p.id === id) ??
      null
    );
  }

  protected onApplied(id: string): void {
    const preset = this.findPreset(id);
    if (preset && this.state.applyPreset(preset)) {
      this.applied.emit();
    }
  }

  protected async onDeleted(id: string): Promise<void> {
    // Only user presets are deletable — never resolve a built-in here even
    // if an id slipped through.
    const preset = this.presets.userPresets().find((p) => p.id === id) ?? null;
    if (preset) await this.presets.delete(preset);
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

  /** One-line summary of a preset's sparse fields, e.g. "2 settings". */
  private fieldSummary(preset: Preset): string {
    const n = Object.keys(preset.fields).length;
    return n === 1 ? '1 setting' : `${n} settings`;
  }
}
