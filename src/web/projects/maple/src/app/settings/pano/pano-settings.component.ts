// PanoSettingsComponent — `/settings/pano` (owner-gated, #1231).
//
// Operator provisioning surface for panorama stitching:
//   - Enable/disable toggle
//   - maple-cli binary path
//   - Matcher: classical (default, nothing to download) or ML (opt-in, #4555)
//   - MAPLE_PANO_MODELS directory and ORT_DYLIB_PATH, shown only for ML; the
//     server answers a stitch with 409 pano_ml_not_provisioned until both are set
//     here or in the deprecated environment variables
//   - A rebuild notice when the binary predates --features-engine (ML-only)
//
// Config is saved via PUT /api/pano/config and re-resolved from the server
// response, same as the Observability settings page.

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import {
  PanoService,
  type PanoConfig,
  type PanoMatcher,
  MuiButtonComponent,
  MuiCheckboxComponent,
  MuiInputComponent,
  MuiSegmentedToggleComponent,
  type MuiSegmentedToggleOption,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';

const MATCHER_OPTIONS: readonly MuiSegmentedToggleOption[] = [
  { value: 'classical', label: 'Classical' },
  { value: 'ml', label: 'ML' },
];

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

@Component({
  selector: 'maple-pano-settings',
  standalone: true,
  imports: [
    SettingsShellComponent,
    MuiButtonComponent,
    MuiCheckboxComponent,
    MuiInputComponent,
    MuiSegmentedToggleComponent,
  ],
  templateUrl: './pano-settings.component.html',
  host: { class: 'set-page-host' },
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
  protected readonly fMatcher = signal<PanoMatcher>('classical');
  protected readonly fModelsDir = signal('');
  protected readonly fOrtDylibPath = signal('');

  protected readonly matcherOptions = MATCHER_OPTIONS;
  protected readonly mlSelected = computed(() => this.fMatcher() === 'ml');
  protected readonly mlPathsMissing = computed(
    () =>
      this.mlSelected() &&
      (this.fModelsDir().trim().length === 0 || this.fOrtDylibPath().trim().length === 0),
  );
  protected readonly cliOutdated = computed(() => {
    const cfg = this.config();
    return cfg !== null && cfg.maple_cli_path !== null && !cfg.features_engine_supported;
  });
  protected readonly buildCommand =
    'cargo build --release --bin maple-cli --features pano,pano-classical';

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
    this.fMatcher.set(cfg.matcher);
    this.fModelsDir.set(cfg.models_dir ?? '');
    this.fOrtDylibPath.set(cfg.ort_dylib_path ?? '');
  }

  protected save(): void {
    const cliPath = this.fCliPath().trim();
    this.saveState.set({ kind: 'saving' });
    this.pano
      .putConfig({
        enabled: this.fEnabled(),
        matcher: this.fMatcher(),
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

  protected selectMatcher(value: string): void {
    this.fMatcher.set(value === 'ml' ? 'ml' : 'classical');
  }

  protected sourceLabel(source: string | undefined): string {
    switch (source) {
      case 'db':
        return 'saved';
      case 'env':
        return 'environment variable (deprecated)';
      case 'unset':
        return 'not set';
      case 'default':
        return 'default';
      default:
        return source ?? '';
    }
  }
}
