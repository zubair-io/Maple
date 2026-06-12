// PanoSettingsComponent — `/settings/pano` (owner-gated, #1231).
//
// Operator provisioning surface for panorama stitching:
//   - Enable/disable toggle
//   - maple-cli binary path
//   - MAPLE_PANO_MODELS directory
//   - ORT_DYLIB_PATH (libonnxruntime ≥ 1.23)
//
// All fields follow the DB-only settings pattern (no env-var fallback for
// pano — the binary path and models dir are always operator-supplied).
// Config is saved via PUT /api/pano/config and re-resolved from the server
// response, same as the Observability settings page.

import { ChangeDetectionStrategy, Component, OnInit, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { PanoService, type PanoConfig } from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

@Component({
  selector: 'maple-pano-settings',
  standalone: true,
  imports: [FormsModule, SettingsShellComponent],
  templateUrl: './pano-settings.component.html',
  styleUrl: './pano-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PanoSettingsComponent implements OnInit {
  private readonly pano = inject(PanoService);

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saveState = signal<SaveState>({ kind: 'idle' });

  protected readonly config = signal<PanoConfig | null>(null);

  // ── Editable form fields ─────────────────────────────────────────────────
  protected readonly fEnabled = signal(false);
  protected readonly fCliPath = signal('');
  protected readonly fModelsDir = signal('');
  protected readonly fOrtDylibPath = signal('');

  private formSeeded = false;

  constructor() {
    // Seed the form the first time the config loads.
    effect(() => {
      const cfg = this.config();
      if (!cfg || this.formSeeded) return;
      this.formSeeded = true;
      this.seedForm(cfg);
    });
  }

  ngOnInit(): void {
    this.pano.getConfig().subscribe({
      next: (cfg) => {
        this.config.set(cfg);
        this.loading.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.loadError.set(err.error?.message ?? 'Failed to load pano configuration.');
        this.loading.set(false);
      },
    });
  }

  private seedForm(cfg: PanoConfig): void {
    this.fEnabled.set(cfg.enabled);
    this.fCliPath.set(cfg.maple_cli_path ?? '');
    this.fModelsDir.set(cfg.models_dir ?? '');
    this.fOrtDylibPath.set(cfg.ort_dylib_path ?? '');
  }

  protected save(): void {
    const cliPath = this.fCliPath().trim();
    this.saveState.set({ kind: 'saving' });
    this.pano
      .putConfig({
        enabled: this.fEnabled(),
        maple_cli_path: cliPath.length > 0 ? cliPath : null,
        models_dir: this.fModelsDir().trim() || null,
        ort_dylib_path: this.fOrtDylibPath().trim() || null,
      })
      .subscribe({
        next: (cfg) => {
          this.config.set(cfg);
          this.formSeeded = false; // allow re-seed from fresh config
          this.saveState.set({ kind: 'saved' });
          setTimeout(() => {
            this.saveState.update((s) => (s.kind === 'saved' ? { kind: 'idle' } : s));
          }, 2000);
        },
        error: (err: HttpErrorResponse) => {
          this.saveState.set({
            kind: 'error',
            message: err.error?.message ?? 'Save failed.',
          });
        },
      });
  }

  protected sourceLabel(source: string | undefined): string {
    switch (source) {
      case 'db':
        return 'saved';
      case 'unset':
        return 'not set';
      case 'default':
        return 'default';
      default:
        return source ?? '';
    }
  }
}
