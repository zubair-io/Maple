// LibraryPickerComponent — first-run library folder picker for Maple Self Hosted.
// Walks the server filesystem via /api/fs/list starting at '/', lets the
// user navigate into mounted volumes, and emits the chosen absolute path.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnDestroy,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { BunApiBackendService, type ApiDirListing } from '../../api/bun-api-backend.service';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';
import { MuiCheckboxComponent } from '../../ui/checkbox/mui-checkbox.component';

@Component({
  selector: 'app-library-picker',
  standalone: true,
  imports: [MuiButtonComponent, MuiCheckboxComponent],
  templateUrl: './library-picker.component.html',
  styleUrl: './library-picker.component.scss',
  host: {
    class: 'flex w-full h-full items-center justify-center box-border p-8 bg-bg text-text-main',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryPickerComponent implements OnInit, OnDestroy {
  private readonly api = inject(BunApiBackendService);
  private request: Subscription | null = null;

  readonly listing = signal<ApiDirListing | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly showAll = signal(false);
  readonly currentPath = signal('/');
  readonly canChoose = computed(() => !this.loading() && !this.error() && !!this.listing()?.path);

  readonly pick = output<string>();
  readonly cancel = output<void>();
  readonly showCancel = input(true);

  ngOnInit(): void {
    this.navigate('/');
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
  }

  navigate(absPath: string): void {
    this.request?.unsubscribe();
    this.currentPath.set(absPath);
    this.listing.set(null);
    this.loading.set(true);
    this.error.set(null);
    this.request = this.api.listDir(absPath, this.showAll()).subscribe({
      next: (data) => {
        this.currentPath.set(data.path);
        this.listing.set(data);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err?.error?.error ?? err?.message ?? 'Failed to list directory.');
      },
    });
  }

  onUp(): void {
    const parent = this.listing()?.parent;
    if (parent) this.navigate(parent);
  }

  onUseHere(): void {
    if (!this.canChoose()) return;
    const p = this.listing()?.path;
    if (p) this.pick.emit(p);
  }

  onToggleShowAll(): void {
    this.showAll.update((v) => !v);
    this.navigate(this.currentPath());
  }
}
