// Info tab — file metadata, camera, rating/flags, location, dates, IPTC, history.
// Shared between Browse and Editor apps via maple-common.
// Ported from _design-reference/lib/detail.jsx InfoTab / KV / EditableRow.

import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { LibraryStateService } from '../state/library-state.service';
import { MapleIconComponent } from '../icons/maple-icon.component';
import { MapleCollapsibleComponent } from '../collapsible/maple-collapsible.component';
import { Asset, ColorLabel, Flag } from '../models/asset';

const COLOR_LABELS: { name: ColorLabel; hex: string }[] = [
  { name: 'red', hex: '#e74c3c' },
  { name: 'orange', hex: '#e9873f' },
  { name: 'yellow', hex: '#e9b93f' },
  { name: 'green', hex: '#4ade80' },
  { name: 'blue', hex: '#6aa0d4' },
];

@Component({
  selector: 'maple-info-tab',
  standalone: true,
  imports: [MapleIconComponent, MapleCollapsibleComponent],
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow-y: auto;
      }
      /* Webkit scrollbar tweaks — not Tailwind-expressible. */
      :host::-webkit-scrollbar {
        width: 6px;
      }
      :host::-webkit-scrollbar-track {
        background: transparent;
      }
      :host::-webkit-scrollbar-thumb {
        background: var(--color-border);
        border-radius: 3px;
      }

      /* Color-label dot active state. Tailwind's outline utilities don't
         compose cleanly with the per-dot inline background, so keep this
         small rule. */
      .color-dot.active {
        outline: 1.5px solid var(--color-text-main);
        outline-offset: 2px;
      }
    `,
  ],
  template: `
    @let asset = state.focusedAsset();

    @if (!asset) {
      <div class="flex flex-1 items-center justify-center p-5 text-center text-[11px] text-text-muted">Select an asset to inspect</div>
    } @else {
      <!-- File -->
      <maple-collapsible label="File" storageKey="info-file">
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">Name</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ asset.filename }}</span>
        </div>
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">Format</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">Canon RAW · {{ ext(asset.filename) }}</span>
        </div>
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">Dimensions</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ asset.width && asset.height ? (asset.width + " × " + asset.height) : "—" }}</span>
        </div>
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">Size</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ formatSize(asset.size) }}</span>
        </div>
        @if (asset.edited) {
          <div class="px-3.5 pt-1.5 pb-0.5">
            <div class="inline-flex items-center gap-1 rounded-[3px] bg-success-bg px-[7px] py-[3px] text-[10px] font-medium text-success-text">
              <maple-icon
                name="check"
                [size]="10"
                [strokeWidth]="2.5"
                color="var(--color-success-text)"
              />
              <span>{{ xmpName(asset.filename) }}</span>
            </div>
          </div>
        }
      </maple-collapsible>

      <!-- Camera -->
      <maple-collapsible label="Camera" storageKey="info-camera">
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">Body</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ asset.camera || "—" }}</span>
        </div>
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">Lens</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ asset.lens || "—" }}</span>
        </div>
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">Focal</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ asset.focalLength || "—" }}</span>
        </div>
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">Aperture</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ asset.aperture || "—" }}</span>
        </div>
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">Shutter</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ asset.shutter || "—" }}</span>
        </div>
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">ISO</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ asset.iso || "—" }}</span>
        </div>
      </maple-collapsible>

      <!-- Rating & flags -->
      <maple-collapsible label="Rating & flags" storageKey="info-rating">
        <div class="flex gap-[3px] px-3.5 pt-0.5 pb-2">
          <div
            class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-border bg-transparent text-[11px] font-semibold text-text-muted"
            [class.bg-success-bg]="asset.flag === 'pick'"
            [class.text-success-text]="asset.flag === 'pick'"
            [class.border-success-text]="asset.flag === 'pick'"
            title="Pick"
            (click)="toggleFlag(asset, 'pick')"
          >
            P
          </div>
          <div
            class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-border bg-transparent text-[11px] font-semibold text-text-muted"
            [class.bg-surface-alt]="asset.flag === 'unflagged'"
            [class.text-text-main]="asset.flag === 'unflagged'"
            title="Unflagged"
            (click)="toggleFlag(asset, 'unflagged')"
          >
            —
          </div>
          <div
            class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-border bg-transparent text-[11px] font-semibold text-text-muted"
            [class.bg-error-bg]="asset.flag === 'reject'"
            [class.text-error-text]="asset.flag === 'reject'"
            [class.border-error-text]="asset.flag === 'reject'"
            title="Reject"
            (click)="toggleFlag(asset, 'reject')"
          >
            ✕
          </div>
        </div>

        <div class="flex gap-0.5 px-3.5 pb-2">
          @for (i of STAR_INDICES; track i) {
            <div class="cursor-pointer p-0.5" (click)="toggleStar(asset, i)">
              <maple-icon
                [name]="i <= asset.rating ? 'star-filled' : 'star'"
                [size]="16"
                [color]="i <= asset.rating ? 'var(--color-star)' : 'var(--color-border)'"
              />
            </div>
          }
        </div>

        <div class="px-3.5 pb-1">
          <div class="mb-1.5 text-[10px] uppercase tracking-[0.3px] text-text-muted">Color label</div>
          <div class="flex gap-1.5">
            @for (cl of COLOR_LABELS; track cl.name) {
              <div
                class="color-dot h-5 w-5 cursor-pointer rounded-full"
                [class.active]="asset.colorLabel === cl.name"
                [style.background]="cl.hex"
                [title]="cl.name"
                (click)="toggleColor(asset, cl.name)"
              ></div>
            }
          </div>
        </div>
      </maple-collapsible>

      <!-- Location -->
      <maple-collapsible label="Location" storageKey="info-location">
        @if (asset.gps) {
          <div class="flex justify-between gap-2 px-4 py-[5px]">
            <span class="flex-shrink-0 text-[11px] text-text-muted">Coords</span>
            <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ asset.gps.lat.toFixed(4) }}, {{ asset.gps.lon.toFixed(4) }}</span>
          </div>
        }
        @if (asset.city) {
          <div class="flex justify-between gap-2 px-4 py-[5px]">
            <span class="flex-shrink-0 text-[11px] text-text-muted">City</span>
            <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ asset.city }}, {{ asset.region }}</span>
          </div>
          <div class="flex justify-between gap-2 px-4 py-[5px]">
            <span class="flex-shrink-0 text-[11px] text-text-muted">Country</span>
            <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ asset.country }}</span>
          </div>
        }
        <div class="px-3.5 pt-1.5 pb-0.5">
          <div
            class="relative h-[86px] cursor-pointer overflow-hidden rounded border-[0.5px] border-border"
            style="background: radial-gradient(circle at 42% 62%, rgba(196,73,58,0.8) 0, rgba(196,73,58,0) 6px), linear-gradient(135deg, #22302a 0%, #1a201d 100%)"
          >
            <div
              class="absolute inset-0 opacity-[0.35]"
              style="background-image: linear-gradient(90deg, rgba(168,162,158,0.2) 1px, transparent 1px), linear-gradient(0deg, rgba(168,162,158,0.15) 1px, transparent 1px); background-size: 16px 16px;"
            ></div>
            <div class="absolute left-[42%] top-[62%] h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_0_3px_rgba(196,73,58,0.25)]"></div>
            <div class="absolute bottom-1.5 left-2 font-mono text-[9px] text-text-muted">Open in Maps ›</div>
          </div>
        </div>
      </maple-collapsible>

      <!-- Dates -->
      <maple-collapsible label="Dates" storageKey="info-dates" [defaultOpen]="false">
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">Captured</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ formatDate(asset.capturedAt) }}</span>
        </div>
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">Modified</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ formatDate(asset.mtime) }}</span>
        </div>
      </maple-collapsible>

      <!-- IPTC -->
      <maple-collapsible label="IPTC" storageKey="info-iptc" [defaultOpen]="false">
        <div class="px-4 py-[5px]">
          <div class="mb-0.5 text-[10px] text-text-muted">Title</div>
          <input class="box-border h-6 w-full rounded-[3px] border-[0.5px] border-border bg-input-bg px-1.5 text-[11px] text-text-main outline-none focus:border-primary" [value]="asset.title ?? ''" placeholder="—" />
        </div>
        <div class="px-4 py-[5px]">
          <div class="mb-0.5 text-[10px] text-text-muted">Caption</div>
          <input class="box-border h-6 w-full rounded-[3px] border-[0.5px] border-border bg-input-bg px-1.5 text-[11px] text-text-main outline-none focus:border-primary" value="" placeholder="—" />
        </div>
        <div class="px-4 py-[5px]">
          <div class="mb-0.5 text-[10px] text-text-muted">Copyright</div>
          <input class="box-border h-6 w-full rounded-[3px] border-[0.5px] border-border bg-input-bg px-1.5 text-[11px] text-text-main outline-none focus:border-primary" value="© 2026 Z. Lawrence" placeholder="—" />
        </div>
        <div class="px-4 py-[5px]">
          <div class="mb-0.5 text-[10px] text-text-muted">Creator</div>
          <input class="box-border h-6 w-full rounded-[3px] border-[0.5px] border-border bg-input-bg px-1.5 text-[11px] text-text-main outline-none focus:border-primary" value="Z. Lawrence" placeholder="—" />
        </div>
        @if ((asset.keywords?.length ?? 0) > 0) {
          <div class="px-3.5 pt-1.5 pb-0.5">
            <div class="mb-1.5 text-[10px] uppercase tracking-[0.3px] text-text-muted">Keywords</div>
            <div class="flex flex-wrap gap-1">
              @for (kw of asset.keywords!; track kw) {
                <div class="flex items-center gap-[3px] rounded-[3px] border-[0.5px] border-border bg-surface-alt px-1.5 py-0.5 text-[10px] text-text-main">
                  {{ kw }}
                  <maple-icon name="x" [size]="8" color="var(--color-text-muted)" />
                </div>
              }
              <div class="cursor-pointer rounded-[3px] border-[0.5px] border-dashed border-border px-1.5 py-0.5 text-[10px] text-text-muted">+ add</div>
            </div>
          </div>
        }
      </maple-collapsible>

      <!-- Sidecar -->
      <maple-collapsible label="Sidecar" storageKey="info-sidecar" [defaultOpen]="false">
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">File</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ xmpName(asset.filename) }}</span>
        </div>
        <div class="flex justify-between gap-2 px-4 py-[5px]">
          <span class="flex-shrink-0 text-[11px] text-text-muted">Edits</span>
          <span class="max-w-[65%] overflow-hidden text-ellipsis whitespace-nowrap text-right font-mono text-[11px] text-text-main">{{ asset.edited ? '7 adjustments' : 'none' }}</span>
        </div>
      </maple-collapsible>

      <!-- Edit history -->
      <maple-collapsible label="Edit history" storageKey="info-history" [defaultOpen]="false">
        <div class="px-3.5 pb-1">
          @for (h of HISTORY; track h.label; let i = $index) {
            <div
              class="flex items-center gap-1.5 py-[5px]"
              [style.border-bottom]="
                i < HISTORY.length - 1 ? '0.5px solid var(--color-border)' : 'none'
              "
            >
              <maple-icon name="history" [size]="11" color="var(--color-text-muted)" />
              <span class="flex-1 text-[11px] text-text-main">{{ h.label }}</span>
              <span class="font-mono text-[9px] text-text-muted">{{ h.time }}</span>
            </div>
          }
        </div>
      </maple-collapsible>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InfoTabComponent {
  state = inject(LibraryStateService);

  readonly STAR_INDICES = [1, 2, 3, 4, 5];
  readonly COLOR_LABELS = COLOR_LABELS;
  readonly HISTORY = [
    { label: 'Original import', time: 'Import' },
    { label: 'Basic tone', time: '3d ago' },
    { label: 'Warm grade', time: '2h ago' },
  ];

  ext(filename: string): string {
    return filename.split('.').pop() ?? '';
  }

  xmpName(filename: string): string {
    return filename.replace(/\.[^.]+$/, '.xmp');
  }

  formatSize(bytes: number | undefined): string {
    if (bytes == null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  formatDate(iso: string | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  toggleFlag(asset: Asset, flag: Flag): void {
    const next: Flag = asset.flag === flag ? 'unflagged' : flag;
    this.state.setFlag(asset.id, next);
  }

  toggleStar(asset: Asset, star: number): void {
    const next = asset.rating === star ? 0 : star;
    this.state.setRating(asset.id, next);
  }

  toggleColor(asset: Asset, label: ColorLabel): void {
    const next: ColorLabel = asset.colorLabel === label ? null : label;
    this.state.setColorLabel(asset.id, next);
  }
}
