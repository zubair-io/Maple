// MirrorSettingsComponent — the "Mirror / backup" section embedded in the
// Workers settings page. Per-library backup-location config (path + enable +
// Test + Save) plus the mirror reconcile-queue status and a Retry-dead action.
//
// Self-contained (its own signals + API calls) so it drops into the Workers
// page with a single tag and doesn't entangle that component's state. Backed by
// GET/PUT /api/folders/:id/mirror, POST /api/mirror/test, GET /api/mirror/status,
// POST /api/mirror/retry-dead.

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { BunApiBackendService, type ApiFolder } from '@maple-common';
import { SettingsIconComponent } from '../settings-icon.component';

interface MirrorForm {
  path: string;
  enabled: boolean;
}
type SaveState = 'idle' | 'saving' | 'success';
type TestState = 'idle' | 'testing' | 'ok' | 'fail';

@Component({
  selector: 'maple-mirror-settings',
  standalone: true,
  imports: [SettingsIconComponent],
  templateUrl: './mirror-settings.component.html',
  styleUrl: './mirror-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MirrorSettingsComponent implements OnInit {
  private readonly backend = inject(BunApiBackendService);

  /** Collapsed by default — the row expands to reveal per-library config. */
  protected readonly expanded = signal(false);
  protected toggle(): void {
    this.expanded.update((v) => !v);
  }

  protected readonly libraries = signal<ApiFolder[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  /** True once at least one library has an enabled mirror with a path. */
  protected readonly mirrorActive = computed(() =>
    Object.values(this.forms()).some((m) => m.enabled && m.path.trim().length > 0),
  );
  protected statusLabel(): string {
    return this.mirrorActive() ? 'Active' : 'Not configured';
  }
  protected statusColor(): string {
    return this.mirrorActive() ? 'var(--s-ok)' : 'var(--s-text-dim)';
  }

  /** Per-library editable form (one mirror per library in this UI). */
  protected readonly forms = signal<Record<string, MirrorForm>>({});
  protected readonly saveState = signal<Record<string, SaveState>>({});
  protected readonly saveError = signal<Record<string, string | null>>({});
  protected readonly testState = signal<Record<string, TestState>>({});
  protected readonly testMsg = signal<Record<string, string | null>>({});

  protected readonly status = signal<{ pending: number; dead: number } | null>(null);
  protected readonly retrying = signal(false);

  async ngOnInit(): Promise<void> {
    try {
      const libs = await firstValueFrom(this.backend.listFolders());
      this.libraries.set(libs);
      const forms: Record<string, MirrorForm> = {};
      await Promise.all(
        libs.map(async (lib) => {
          try {
            const res = await firstValueFrom(this.backend.getFolderMirrors(lib.id));
            const first = res.mirrors[0];
            forms[lib.id] = { path: first?.path ?? '', enabled: first?.enabled ?? true };
          } catch {
            forms[lib.id] = { path: '', enabled: true };
          }
        }),
      );
      this.forms.set(forms);
      await this.refreshStatus();
    } catch (e) {
      this.error.set(this.msg(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected pathOf(id: string): string {
    return this.forms()[id]?.path ?? '';
  }
  protected enabledOf(id: string): boolean {
    return this.forms()[id]?.enabled ?? true;
  }
  protected saveStateOf(id: string): SaveState {
    return this.saveState()[id] ?? 'idle';
  }
  protected saveErrorOf(id: string): string | null {
    return this.saveError()[id] ?? null;
  }
  protected testStateOf(id: string): TestState {
    return this.testState()[id] ?? 'idle';
  }
  protected testMsgOf(id: string): string | null {
    return this.testMsg()[id] ?? null;
  }

  protected setPath(id: string, value: string): void {
    this.forms.update((m) => ({ ...m, [id]: { ...m[id], path: value } }));
    // Editing invalidates a prior test/save result.
    this.testState.update((m) => ({ ...m, [id]: 'idle' }));
    this.saveState.update((m) => ({ ...m, [id]: 'idle' }));
  }

  protected setEnabled(id: string, value: boolean): void {
    this.forms.update((m) => ({ ...m, [id]: { ...m[id], enabled: value } }));
    this.saveState.update((m) => ({ ...m, [id]: 'idle' }));
  }

  protected async test(id: string): Promise<void> {
    const p = this.pathOf(id).trim();
    if (!p) return;
    this.testState.update((m) => ({ ...m, [id]: 'testing' }));
    this.testMsg.update((m) => ({ ...m, [id]: null }));
    try {
      const res = await firstValueFrom(this.backend.testMirrorPath(p));
      if (res.ok) {
        this.testState.update((m) => ({ ...m, [id]: 'ok' }));
        this.testMsg.update((m) => ({ ...m, [id]: res.path ?? p }));
      } else {
        this.testState.update((m) => ({ ...m, [id]: 'fail' }));
        this.testMsg.update((m) => ({ ...m, [id]: res.error ?? 'Not a usable directory.' }));
      }
    } catch (e) {
      this.testState.update((m) => ({ ...m, [id]: 'fail' }));
      this.testMsg.update((m) => ({ ...m, [id]: this.msg(e) }));
    }
  }

  protected async save(id: string): Promise<void> {
    const form = this.forms()[id];
    if (!form) return;
    const path = form.path.trim();
    const mirrors = path ? [{ path, enabled: form.enabled }] : [];
    this.saveState.update((m) => ({ ...m, [id]: 'saving' }));
    this.saveError.update((m) => ({ ...m, [id]: null }));
    try {
      await firstValueFrom(this.backend.setFolderMirrors(id, mirrors));
      this.saveState.update((m) => ({ ...m, [id]: 'success' }));
      await this.refreshStatus();
    } catch (e) {
      this.saveState.update((m) => ({ ...m, [id]: 'idle' }));
      this.saveError.update((m) => ({ ...m, [id]: this.msg(e) }));
    }
  }

  protected async retryDead(): Promise<void> {
    this.retrying.set(true);
    try {
      await firstValueFrom(this.backend.retryDeadMirrors());
      await this.refreshStatus();
    } catch (e) {
      this.error.set(this.msg(e));
    } finally {
      this.retrying.set(false);
    }
  }

  private async refreshStatus(): Promise<void> {
    try {
      const res = await firstValueFrom(this.backend.getMirrorStatus());
      this.status.set(res.queue);
    } catch {
      // Status is informational — a fetch failure shouldn't surface an error banner.
    }
  }

  private msg(e: unknown): string {
    if (e && typeof e === 'object' && 'error' in e) {
      const inner = (e as { error?: { error?: string } }).error;
      if (inner?.error) return inner.error;
    }
    return e instanceof Error ? e.message : String(e);
  }
}
