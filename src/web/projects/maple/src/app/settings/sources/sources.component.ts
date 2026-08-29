// SourcesComponent — `/settings/sources` (owner-gated) (#2892).
//
// Every registered library root with its live connection status. This is
// the recovery surface for the sidebar's hiding rule: a disconnected source
// (unmounted SMB share, unplugged drive) disappears from the browse side
// nav, so this page is where the operator sees it still exists, learns why
// it's hidden, and re-checks after re-mounting. "Add source" reuses the
// shared library-picker modal (same flow as the sidebar ＋ button).

import { ChangeDetectionStrategy, Component, OnInit, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  type ApiFolder,
  BunApiBackendService,
  LibraryStateService,
  LibraryPickerModalComponent,
  errorMessage,
  MuiButtonComponent,
} from '@maple-common';
import { SettingsShellComponent } from '../settings-shell.component';
import { SettingsIconComponent } from '../settings-icon.component';

type LoadState = { kind: 'loading' } | { kind: 'loaded' } | { kind: 'error'; message: string };

@Component({
  selector: 'maple-sources-settings',
  standalone: true,
  imports: [
    SettingsShellComponent,
    SettingsIconComponent,
    LibraryPickerModalComponent,
    MuiButtonComponent,
  ],
  templateUrl: './sources.component.html',
  styleUrl: './sources.component.scss',
  host: { class: 'set-vars set-page-host' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SourcesComponent implements OnInit {
  private readonly api = inject(BunApiBackendService);
  protected readonly state = inject(LibraryStateService);

  protected readonly folders = signal<ApiFolder[]>([]);
  protected readonly loadState = signal<LoadState>({ kind: 'loading' });
  /** True while a `fresh=1` re-check is in flight (the "Check again" button). */
  protected readonly checking = signal(false);

  /** Reload after the add-source picker closes — a successful registration
   * happens inside the shared modal flow, so the list on this page is stale
   * the moment the modal goes away. */
  private pickerWasOpen = false;

  constructor() {
    effect(() => {
      const open = this.state.pickerVisible();
      if (this.pickerWasOpen && !open) void this.load();
      this.pickerWasOpen = open;
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  protected async load(fresh = false): Promise<void> {
    if (fresh) this.checking.set(true);
    else this.loadState.set({ kind: 'loading' });
    try {
      const folders = await firstValueFrom(this.api.listFolders({ fresh }));
      this.folders.set(folders);
      this.loadState.set({ kind: 'loaded' });
    } catch (err) {
      this.loadState.set({ kind: 'error', message: errorMessage(err) });
    } finally {
      this.checking.set(false);
    }
  }

  protected isConnected(folder: ApiFolder): boolean {
    return folder.connected !== false;
  }

  protected disconnectedCount(): number {
    return this.folders().filter((f) => !this.isConnected(f)).length;
  }

  protected lastScanLabel(folder: ApiFolder): string {
    if (!folder.last_scan) return 'never scanned';
    const scanned = new Date(folder.last_scan);
    return Number.isNaN(scanned.getTime()) ? folder.last_scan : scanned.toLocaleString();
  }

  /** Pre-upgrade servers can omit `file_count` — never break a row over it. */
  protected fileCountLabel(folder: ApiFolder): string {
    return `${(folder.file_count ?? 0).toLocaleString()} files`;
  }
}
