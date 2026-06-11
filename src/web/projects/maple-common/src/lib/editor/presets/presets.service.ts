// presets.service.ts — develop-preset CRUD + built-ins (#1115, spec §10.7).
//
// One service, two storage backends behind the same surface:
//
//   - LIBRARY_BACKEND 'self-hosted' (maple): HTTP CRUD against the API's
//     /api/presets routes (Mongo `presets` collection).
//   - LIBRARY_BACKEND 'hosted' (maple-syrup): IndexedDB via
//     `createHostedUserPresetStore` — there is no API server to call.
//
// Built-ins come from the bundled `BUILTIN_PRESETS` list (read-only — no
// delete, no overwrite; saving under a built-in name is refused here).
//
// Presets are user DATA, not configuration — nothing here touches the
// settings system, and applying a preset only ever flows through the
// existing adjustment → debounced-XMP-sidecar path (EditorStateService).
// Original image files are never involved.

import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { API_BASE_URL } from '../../api/api-base-url.token';
import { LIBRARY_BACKEND } from '../../api/library-backend.token';
import { BUILTIN_PRESETS, collidesWithBuiltinName } from './builtin-presets';
import {
  PRESET_SCHEMA_VERSION,
  normalizePresetName,
  type Preset,
  type PresetFields,
} from './preset-model';
import { createHostedUserPresetStore, type UserPresetStore } from './user-preset-store';

/** Wire row from GET/POST /api/presets (self-hosted backend). */
interface ApiPresetRow {
  id: string;
  schemaVersion: number;
  name: string;
  fields: PresetFields;
  [key: string]: unknown;
}

@Injectable({ providedIn: 'root' })
export class PresetsService {
  private readonly http = inject(HttpClient);
  private readonly apiBaseUrl = inject(API_BASE_URL);
  private readonly backend = inject(LIBRARY_BACKEND);

  /** Hosted-backend store; created lazily so the self-hosted app never
   *  opens the IndexedDB database at all. */
  private _hostedStore: UserPresetStore | null = null;

  /** Bundled, read-only utility presets. */
  readonly builtins: readonly Preset[] = BUILTIN_PRESETS;

  private readonly _userPresets = signal<readonly Preset[]>([]);
  private readonly _loaded = signal(false);
  private readonly _busy = signal(false);
  private readonly _error = signal<string | null>(null);

  /** User presets, name-sorted (case-insensitive). */
  readonly userPresets = computed(() =>
    [...this._userPresets()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    ),
  );
  /** True once the first load has completed (success or failure). */
  readonly loaded = computed(() => this._loaded());
  /** True while a load / save / delete is in flight. */
  readonly busy = computed(() => this._busy());
  /** Last operation error, cleared by the next successful operation. */
  readonly error = computed(() => this._error());

  /** (Re)load user presets from the active backend. */
  async load(): Promise<void> {
    this._busy.set(true);
    try {
      if (this.backend === 'self-hosted') {
        const res = await firstValueFrom(
          this.http.get<{ presets: ApiPresetRow[] }>(`${this.apiBaseUrl}/presets`),
        );
        this._userPresets.set(res.presets.map((row) => this._fromApiRow(row)));
      } else {
        const rows = await this.hostedStore().list();
        this._userPresets.set(
          rows.map((row) => ({
            id: row.id,
            schemaVersion: row.schemaVersion,
            name: row.name,
            fields: row.fields,
            builtIn: false,
          })),
        );
      }
      this._error.set(null);
    } catch (err) {
      this._error.set(errorMessage(err, 'Could not load presets'));
    } finally {
      this._loaded.set(true);
      this._busy.set(false);
    }
  }

  /**
   * Save a new user preset from already-captured sparse fields. Returns
   * the created preset, or null on failure (`error()` carries the reason
   * — invalid name, built-in collision, duplicate, backend failure).
   */
  async save(rawName: string, fields: PresetFields): Promise<Preset | null> {
    const name = normalizePresetName(rawName);
    if (!name) {
      this._error.set('Preset names must be 1–120 printable characters.');
      return null;
    }
    if (collidesWithBuiltinName(name)) {
      this._error.set(`"${name}" is a built-in preset name.`);
      return null;
    }
    if (Object.keys(fields).length === 0) {
      this._error.set('No edited settings to save — adjust something first.');
      return null;
    }
    this._busy.set(true);
    try {
      let preset: Preset;
      if (this.backend === 'self-hosted') {
        const row = await firstValueFrom(
          this.http.post<ApiPresetRow>(`${this.apiBaseUrl}/presets`, {
            schemaVersion: PRESET_SCHEMA_VERSION,
            name,
            fields,
          }),
        );
        preset = this._fromApiRow(row);
      } else {
        const duplicate = this._userPresets().some(
          (p) => p.name.toLowerCase() === name.toLowerCase(),
        );
        if (duplicate) {
          this._error.set(`A preset named "${name}" already exists.`);
          return null;
        }
        preset = {
          id: crypto.randomUUID(),
          schemaVersion: PRESET_SCHEMA_VERSION,
          name,
          fields,
          builtIn: false,
        };
        await this.hostedStore().put({
          id: preset.id,
          schemaVersion: preset.schemaVersion,
          name: preset.name,
          fields: preset.fields,
        });
      }
      this._userPresets.update((list) => [...list, preset]);
      this._error.set(null);
      return preset;
    } catch (err) {
      this._error.set(errorMessage(err, 'Could not save the preset'));
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  /** Delete a user preset. Built-ins are read-only and refuse to delete. */
  async delete(preset: Preset): Promise<boolean> {
    if (preset.builtIn) {
      this._error.set('Built-in presets cannot be deleted.');
      return false;
    }
    this._busy.set(true);
    try {
      if (this.backend === 'self-hosted') {
        await firstValueFrom(
          this.http.delete<{ ok: boolean }>(`${this.apiBaseUrl}/presets/${preset.id}`),
        );
      } else {
        await this.hostedStore().delete(preset.id);
      }
      this._userPresets.update((list) => list.filter((p) => p.id !== preset.id));
      this._error.set(null);
      return true;
    } catch (err) {
      this._error.set(errorMessage(err, 'Could not delete the preset'));
      return false;
    } finally {
      this._busy.set(false);
    }
  }

  private hostedStore(): UserPresetStore {
    this._hostedStore ??= createHostedUserPresetStore();
    return this._hostedStore;
  }

  private _fromApiRow(row: ApiPresetRow): Preset {
    return {
      id: row.id,
      schemaVersion: row.schemaVersion,
      name: row.name,
      fields: row.fields,
      builtIn: false,
    };
  }
}

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'error' in err) {
    const inner = (err as { error: unknown }).error;
    if (inner && typeof inner === 'object' && 'error' in inner) {
      const msg = (inner as { error: unknown }).error;
      if (typeof msg === 'string') return msg;
    }
  }
  return fallback;
}
