// MapSettingsComponent — `/settings/map` (Map T2, #2826).
//
// Operator control for the web Map view's tile source: the MapLibre GL
// style/tile URL, defaulting to a public OpenStreetMap raster source.
// Self-hosters who want their own tile server or a commercial provider point
// this at their own URL — no redeploy, no shell access.
//
// Privacy note (surfaced in the template too): this URL is used ONLY to
// fetch base-map tile imagery. Photo coordinates are never sent to it — pins
// and heatmap come from Maple's own `/api/map/clusters` endpoint.
//
// Config is saved via PUT /api/map/config and re-resolved from the server
// response, same pattern as the Pano / Observability settings pages.

import { ChangeDetectionStrategy, Component, OnInit, effect, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { MapConfigService, MuiButtonComponent, MuiInputComponent, type MapConfig } from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

@Component({
  selector: 'maple-map-settings',
  standalone: true,
  imports: [SettingsShellComponent, MuiButtonComponent, MuiInputComponent],
  templateUrl: './map-settings.component.html',
  styleUrl: './map-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapSettingsComponent implements OnInit {
  private readonly mapConfig = inject(MapConfigService);

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saveState = signal<SaveState>({ kind: 'idle' });

  protected readonly config = signal<MapConfig | null>(null);

  // ── Editable form field ──────────────────────────────────────────────────
  protected readonly fTileUrl = signal('');

  private formSeeded = false;

  constructor() {
    // Seed the form the first time the config loads.
    effect(() => {
      const cfg = this.config();
      if (!cfg || this.formSeeded) return;
      this.formSeeded = true;
      this.fTileUrl.set(cfg.tile_url);
    });
  }

  ngOnInit(): void {
    this.mapConfig.getConfig().subscribe({
      next: (cfg) => {
        this.config.set(cfg);
        this.loading.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.loadError.set(err.error?.message ?? 'Failed to load map configuration.');
        this.loading.set(false);
      },
    });
  }

  protected save(): void {
    const tileUrl = this.fTileUrl().trim();
    this.saveState.set({ kind: 'saving' });
    this.mapConfig.putConfig({ tile_url: tileUrl.length > 0 ? tileUrl : null }).subscribe({
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
          message: err.error?.error ?? err.error?.message ?? 'Save failed.',
        });
      },
    });
  }

  protected sourceLabel(source: string | undefined): string {
    switch (source) {
      case 'db':
        return 'saved';
      case 'default':
        return 'default (OpenStreetMap)';
      default:
        return source ?? '';
    }
  }
}
