// Info tab — file metadata, camera, rating/flags, location, dates, IPTC, history.
// Shared between Browse and Editor apps via maple-common.
// Ported from _design-reference/lib/detail.jsx InfoTab / KV / EditableRow.

import { Component, inject, signal } from '@angular/core';
import { LibraryStateService } from '../state/library-state.service';
import { MapleIconComponent } from '../icons/maple-icon.component';
import { MapleCollapsibleComponent } from '../collapsible/maple-collapsible.component';
import { Asset, ColorLabel, Flag } from '../models/asset';

const COLOR_LABELS: { name: ColorLabel; hex: string }[] = [
  { name: 'red',    hex: '#e74c3c' },
  { name: 'orange', hex: '#e9873f' },
  { name: 'yellow', hex: '#e9b93f' },
  { name: 'green',  hex: '#4ade80' },
  { name: 'blue',   hex: '#6aa0d4' },
];

@Component({
  selector: 'maple-info-tab',
  standalone: true,
  imports: [MapleIconComponent, MapleCollapsibleComponent],
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    :host::-webkit-scrollbar { width: 6px; }
    :host::-webkit-scrollbar-track { background: transparent; }
    :host::-webkit-scrollbar-thumb { background: var(--maple-border); border-radius: 3px; }

    .empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: var(--maple-text-muted);
      font-family: var(--maple-font);
      font-size: 11px;
      text-align: center;
    }

    .kv {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 3px 14px;
    }
    .kv-key {
      font-family: var(--maple-font);
      font-size: 11px;
      color: var(--maple-text-muted);
      flex-shrink: 0;
    }
    .kv-val {
      font-family: var(--maple-font-mono);
      font-size: 11px;
      color: var(--maple-text-main);
      text-align: right;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 65%;
    }

    .xmp-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 7px;
      border-radius: 3px;
      background: var(--maple-success-bg);
      color: var(--maple-success-text);
      font-family: var(--maple-font);
      font-size: 10px;
      font-weight: 500;
    }

    .flags-row {
      padding: 2px 14px 8px;
      display: flex;
      gap: 3px;
    }
    .flag-pill {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--maple-font);
      font-size: 10px;
      font-weight: 600;
      border: 0.5px solid var(--maple-border);
      cursor: pointer;
      color: var(--maple-text-muted);
      background: transparent;
    }
    .flag-pill.active-pick   { background: var(--maple-success-bg); color: var(--maple-success-text); border-color: var(--maple-success-text); }
    .flag-pill.active-reject { background: var(--maple-error-bg); color: var(--maple-error-text); border-color: var(--maple-error-text); }
    .flag-pill.active-none   { background: var(--maple-surface-alt); color: var(--maple-text-main); }

    .stars-row {
      padding: 0 14px 8px;
      display: flex;
      gap: 2px;
    }
    .star-btn { cursor: pointer; padding: 2px; }

    .color-section { padding: 0 14px 4px; }
    .color-label-title {
      font-family: var(--maple-font);
      font-size: 10px;
      color: var(--maple-text-muted);
      margin-bottom: 6px;
      letter-spacing: 0.3px;
      text-transform: uppercase;
    }
    .color-dots { display: flex; gap: 6px; }
    .color-dot {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      cursor: pointer;
    }
    .color-dot.active {
      outline: 1.5px solid var(--maple-text-main);
      outline-offset: 2px;
    }

    .map-placeholder {
      height: 86px;
      border-radius: 4px;
      border: 0.5px solid var(--maple-border);
      position: relative;
      cursor: pointer;
      overflow: hidden;
    }
    .map-grid {
      position: absolute;
      inset: 0;
      opacity: 0.35;
    }
    .map-dot {
      position: absolute;
      left: 42%;
      top: 62%;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--maple-primary);
      transform: translate(-50%, -50%);
      box-shadow: 0 0 0 3px rgba(196, 73, 58, 0.25);
    }
    .map-label {
      position: absolute;
      left: 8px;
      bottom: 6px;
      font-family: var(--maple-font-mono);
      font-size: 9px;
      color: var(--maple-text-muted);
    }

    .keywords-wrap { display: flex; flex-wrap: wrap; gap: 4px; }
    .keyword-chip {
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--maple-surface-alt);
      border: 0.5px solid var(--maple-border);
      font-family: var(--maple-font);
      font-size: 10px;
      color: var(--maple-text-main);
      display: flex;
      align-items: center;
      gap: 3px;
    }
    .keyword-add {
      padding: 2px 6px;
      border-radius: 3px;
      border: 0.5px dashed var(--maple-border);
      font-family: var(--maple-font);
      font-size: 10px;
      color: var(--maple-text-muted);
      cursor: pointer;
    }

    .history-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 0;
    }
    .history-item-label {
      flex: 1;
      font-family: var(--maple-font);
      font-size: 11px;
      color: var(--maple-text-main);
    }
    .history-item-time {
      font-family: var(--maple-font-mono);
      font-size: 9px;
      color: var(--maple-text-muted);
    }

    .editable-section { padding: 3px 14px; }
    .editable-label {
      font-family: var(--maple-font);
      font-size: 10px;
      color: var(--maple-text-muted);
      margin-bottom: 2px;
    }
    .editable-input {
      width: 100%;
      height: 24px;
      background: var(--maple-input-bg);
      border: 0.5px solid var(--maple-border);
      border-radius: 3px;
      padding: 0 6px;
      font-family: var(--maple-font);
      font-size: 11px;
      color: var(--maple-text-main);
      outline: none;
      box-sizing: border-box;
    }
    .editable-input:focus { border-color: var(--maple-primary); }
  `],
  template: `
    @let asset = state.focusedAsset();

    @if (!asset) {
      <div class="empty">Select an asset to inspect</div>
    } @else {
      <!-- File -->
      <maple-collapsible label="File" storageKey="info-file">
        <div class="kv">
          <span class="kv-key">Name</span>
          <span class="kv-val">{{ asset.filename }}</span>
        </div>
        <div class="kv">
          <span class="kv-key">Format</span>
          <span class="kv-val">Canon RAW · {{ ext(asset.filename) }}</span>
        </div>
        <div class="kv">
          <span class="kv-key">Dimensions</span>
          <span class="kv-val">{{ asset.width }} × {{ asset.height }}</span>
        </div>
        <div class="kv">
          <span class="kv-key">Size</span>
          <span class="kv-val">42.8 MB</span>
        </div>
        @if (asset.edited) {
          <div style="padding:6px 14px 2px">
            <div class="xmp-pill">
              <maple-icon name="check" [size]="10" [strokeWidth]="2.5" color="var(--maple-success-text)"/>
              <span>{{ xmpName(asset.filename) }}</span>
            </div>
          </div>
        }
      </maple-collapsible>

      <!-- Camera -->
      <maple-collapsible label="Camera" storageKey="info-camera">
        <div class="kv"><span class="kv-key">Body</span>    <span class="kv-val">{{ asset.camera }}</span></div>
        <div class="kv"><span class="kv-key">Lens</span>    <span class="kv-val">{{ asset.lens }}</span></div>
        <div class="kv"><span class="kv-key">Focal</span>   <span class="kv-val">{{ asset.focalLength }}</span></div>
        <div class="kv"><span class="kv-key">Aperture</span><span class="kv-val">{{ asset.aperture }}</span></div>
        <div class="kv"><span class="kv-key">Shutter</span> <span class="kv-val">{{ asset.shutter }}</span></div>
        <div class="kv"><span class="kv-key">ISO</span>     <span class="kv-val">{{ asset.iso }}</span></div>
        <div class="kv"><span class="kv-key">Flash</span>   <span class="kv-val">Not fired</span></div>
      </maple-collapsible>

      <!-- Rating & flags -->
      <maple-collapsible label="Rating & flags" storageKey="info-rating">
        <div class="flags-row">
          <div class="flag-pill"
            [class.active-pick]="asset.flag === 'pick'"
            title="Pick"
            (click)="toggleFlag(asset, 'pick')">P</div>
          <div class="flag-pill"
            [class.active-none]="asset.flag === 'unflagged'"
            title="Unflagged"
            (click)="toggleFlag(asset, 'unflagged')">—</div>
          <div class="flag-pill"
            [class.active-reject]="asset.flag === 'reject'"
            title="Reject"
            (click)="toggleFlag(asset, 'reject')">✕</div>
        </div>

        <div class="stars-row">
          @for (i of STAR_INDICES; track i) {
            <div class="star-btn" (click)="toggleStar(asset, i)">
              <maple-icon
                [name]="i <= asset.rating ? 'star-filled' : 'star'"
                [size]="15"
                [color]="i <= asset.rating ? 'var(--maple-star)' : 'var(--maple-border)'"/>
            </div>
          }
        </div>

        <div class="color-section">
          <div class="color-label-title">Color label</div>
          <div class="color-dots">
            @for (cl of COLOR_LABELS; track cl.name) {
              <div
                class="color-dot"
                [class.active]="asset.colorLabel === cl.name"
                [style.background]="cl.hex"
                [title]="cl.name"
                (click)="toggleColor(asset, cl.name)">
              </div>
            }
          </div>
        </div>
      </maple-collapsible>

      <!-- Location -->
      <maple-collapsible label="Location" storageKey="info-location">
        @if (asset.gps) {
          <div class="kv">
            <span class="kv-key">Coords</span>
            <span class="kv-val">{{ asset.gps.lat.toFixed(4) }}, {{ asset.gps.lon.toFixed(4) }}</span>
          </div>
        }
        @if (asset.city) {
          <div class="kv">
            <span class="kv-key">City</span>
            <span class="kv-val">{{ asset.city }}, {{ asset.region }}</span>
          </div>
          <div class="kv">
            <span class="kv-key">Country</span>
            <span class="kv-val">{{ asset.country }}</span>
          </div>
        }
        <div style="padding:6px 14px 2px">
          <div class="map-placeholder"
            style="background: radial-gradient(circle at 42% 62%, rgba(196,73,58,0.8) 0, rgba(196,73,58,0) 6px), linear-gradient(135deg, #22302a 0%, #1a201d 100%)">
            <div class="map-grid"
              style="background-image: linear-gradient(90deg, rgba(168,162,158,0.2) 1px, transparent 1px), linear-gradient(0deg, rgba(168,162,158,0.15) 1px, transparent 1px); background-size: 16px 16px;">
            </div>
            <div class="map-dot"></div>
            <div class="map-label">Open in Maps ›</div>
          </div>
        </div>
      </maple-collapsible>

      <!-- Dates -->
      <maple-collapsible label="Dates" storageKey="info-dates" [defaultOpen]="false">
        <div class="kv"><span class="kv-key">Captured</span><span class="kv-val">{{ asset.capturedAt }}</span></div>
        <div class="kv"><span class="kv-key">Modified</span><span class="kv-val">2026-04-18 21:04</span></div>
        <div class="kv"><span class="kv-key">Created</span> <span class="kv-val">{{ asset.capturedAt }}</span></div>
      </maple-collapsible>

      <!-- IPTC -->
      <maple-collapsible label="IPTC" storageKey="info-iptc" [defaultOpen]="false">
        <div class="editable-section">
          <div class="editable-label">Title</div>
          <input class="editable-input" [value]="asset.title ?? ''" placeholder="—"/>
        </div>
        <div class="editable-section">
          <div class="editable-label">Caption</div>
          <input class="editable-input" value="" placeholder="—"/>
        </div>
        <div class="editable-section">
          <div class="editable-label">Copyright</div>
          <input class="editable-input" value="© 2026 Z. Lawrence" placeholder="—"/>
        </div>
        <div class="editable-section">
          <div class="editable-label">Creator</div>
          <input class="editable-input" value="Z. Lawrence" placeholder="—"/>
        </div>
        @if ((asset.keywords?.length ?? 0) > 0) {
          <div style="padding:6px 14px 2px">
            <div class="color-label-title">Keywords</div>
            <div class="keywords-wrap">
              @for (kw of asset.keywords!; track kw) {
                <div class="keyword-chip">
                  {{ kw }}
                  <maple-icon name="x" [size]="8" color="var(--maple-text-muted)"/>
                </div>
              }
              <div class="keyword-add">+ add</div>
            </div>
          </div>
        }
      </maple-collapsible>

      <!-- Sidecar -->
      <maple-collapsible label="Sidecar" storageKey="info-sidecar" [defaultOpen]="false">
        <div class="kv"><span class="kv-key">File</span>  <span class="kv-val">{{ xmpName(asset.filename) }}</span></div>
        <div class="kv"><span class="kv-key">Edits</span> <span class="kv-val">{{ asset.edited ? '7 adjustments' : 'none' }}</span></div>
      </maple-collapsible>

      <!-- Edit history -->
      <maple-collapsible label="Edit history" storageKey="info-history" [defaultOpen]="false">
        <div style="padding:0 14px 4px">
          @for (h of HISTORY; track h.label; let i = $index) {
            <div class="history-item"
              [style.border-bottom]="i < HISTORY.length - 1 ? '0.5px solid var(--maple-border)' : 'none'">
              <maple-icon name="history" [size]="11" color="var(--maple-text-muted)"/>
              <span class="history-item-label">{{ h.label }}</span>
              <span class="history-item-time">{{ h.time }}</span>
            </div>
          }
        </div>
      </maple-collapsible>
    }
  `,
})
export class InfoTabComponent {
  state = inject(LibraryStateService);

  readonly STAR_INDICES = [1, 2, 3, 4, 5];
  readonly COLOR_LABELS = COLOR_LABELS;
  readonly HISTORY = [
    { label: 'Original import', time: 'Import' },
    { label: 'Basic tone',      time: '3d ago'  },
    { label: 'Warm grade',      time: '2h ago'  },
  ];

  ext(filename: string): string {
    return filename.split('.').pop() ?? '';
  }

  xmpName(filename: string): string {
    return filename.replace(/\.[^.]+$/, '.xmp');
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
