// LibraryPickerComponent — first-run library folder picker for Maple Self Hosted.
// Walks the server filesystem via /api/fs/list starting at '/', lets the
// user navigate into mounted volumes, and emits the chosen absolute path.

import {
  ChangeDetectionStrategy,
  Component,
  inject,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { BunApiBackendService, type ApiDirListing } from '../../api/bun-api-backend.service';

@Component({
  selector: 'app-library-picker',
  standalone: true,
  imports: [],
  templateUrl: './library-picker.component.html',
  styleUrl: './library-picker.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryPickerComponent implements OnInit {
  private readonly api = inject(BunApiBackendService);

  readonly listing = signal<ApiDirListing | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly showAll = signal(false);

  readonly pick = output<string>();
  readonly cancel = output<void>();

  ngOnInit(): void {
    this.navigate('/');
  }

  navigate(absPath: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.listDir(absPath, this.showAll()).subscribe({
      next: (data) => {
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
    const p = this.listing()?.path;
    if (p) this.pick.emit(p);
  }

  onToggleShowAll(): void {
    this.showAll.update((v) => !v);
    const cur = this.listing()?.path ?? '/';
    this.navigate(cur);
  }
}
