// Info tab — file metadata, camera, rating/flags, location, dates, IPTC, history.
// Shared between Browse and Editor apps via maple-common.
// Ported from _design-reference/lib/detail.jsx InfoTab / KV / EditableRow.
//
// Self-Hosted extension: when the focused asset has a known API id (Self
// Hosted backend), this component fetches the per-asset enrichment payload
// (place, description, OCR text, faces) from the Bun API and surfaces four
// editable sections at the bottom of the pane. Each section supports a
// manual override (PUT) and a re-X button (POST requeue). After a requeue,
// the component polls the asset every 2s for 30s to pick up the new value.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  Injector,
  OnDestroy,
  runInInjectionContext,
} from '@angular/core';
import { LibraryStateService } from '../state/library-state.service';
import { MapleIconComponent } from '../icons/maple-icon.component';
import { MapleCollapsibleComponent } from '../collapsible/maple-collapsible.component';
import { Asset, ColorLabel, Flag } from '../models/asset';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import {
  BunApiBackendService,
  ApiAssetDetail,
  ApiEnrichmentStage,
  ApiEnrichmentStageState,
} from '../api/bun-api-backend.service';
import { Subscription } from 'rxjs';

const COLOR_LABELS: { name: ColorLabel; hex: string }[] = [
  { name: 'red', hex: '#e74c3c' },
  { name: 'orange', hex: '#e9873f' },
  { name: 'yellow', hex: '#e9b93f' },
  { name: 'green', hex: '#4ade80' },
  { name: 'blue', hex: '#6aa0d4' },
];

/** How long the post-requeue refresh poll runs before giving up. */
const REFRESH_TIMEOUT_MS = 30_000;
/** Poll interval inside the refresh window. */
const REFRESH_POLL_MS = 2_000;

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

      /* OCR text panel — monospace + scrollable. Tailwind line-height
         classes don't quite hit the design spec, so a tiny custom rule. */
      .ocr-pre {
        max-height: 8em;
        overflow-y: auto;
        line-height: 1.4;
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
          @if (asset.gps) {
            <a
              [href]="openInMapsUrl(asset.gps.lat, asset.gps.lon)"
              target="_blank"
              rel="noopener noreferrer"
              [title]="'Open in OpenStreetMap (' + asset.gps.lat.toFixed(4) + ', ' + asset.gps.lon.toFixed(4) + ')'"
              class="relative block h-[86px] cursor-pointer overflow-hidden rounded border-[0.5px] border-border bg-surface-alt"
            >
              <img
                [src]="staticMapTileUrl(asset.gps.lat, asset.gps.lon, MAP_ZOOM)"
                [alt]="'Map of ' + asset.gps.lat.toFixed(4) + ', ' + asset.gps.lon.toFixed(4)"
                class="absolute inset-0 h-full w-full object-cover"
                referrerpolicy="no-referrer"
                loading="lazy"
              />
              <div
                class="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_0_3px_rgba(196,73,58,0.25)]"
                [style.left]="pinOffsetPct(asset.gps.lat, asset.gps.lon).left"
                [style.top]="pinOffsetPct(asset.gps.lat, asset.gps.lon).top"
              ></div>
              <div class="absolute bottom-1.5 left-2 rounded-[3px] bg-surface/80 px-1 py-[1px] font-mono text-[9px] text-text-main">Open in Maps ›</div>
            </a>
          } @else {
            <div
              class="flex h-[58px] items-center justify-center rounded border-[0.5px] border-dashed border-border bg-surface-alt text-[10px] text-text-muted"
            >
              No GPS data
            </div>
          }
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

      <!-- ── Enrichment sections (Self Hosted only) ──────────────────── -->
      @if (selfHosted && detail()) {
        @let d = detail()!;

        <!-- Place -->
        @if (showPlaceSection(d)) {
          <maple-collapsible label="Place" storageKey="info-place">
            <div class="px-4 py-[5px]">
              @if (placeEditing()) {
                <div class="mb-0.5 text-[10px] text-text-muted">Display name</div>
                <input
                  class="box-border h-6 w-full rounded-[3px] border-[0.5px] border-border bg-input-bg px-1.5 text-[11px] text-text-main outline-none focus:border-primary"
                  [value]="placeDraft()"
                  (input)="placeDraft.set($any($event.target).value)"
                  placeholder="Display name"
                />
                <div class="mt-1.5 flex justify-end gap-1.5">
                  <button class="text-[10px] text-text-muted hover:text-text-main" type="button" (click)="cancelPlaceEdit()">Cancel</button>
                  <button class="text-[10px] font-medium text-primary hover:underline" type="button" (click)="savePlaceEdit(d)">Save</button>
                </div>
              } @else {
                @if (d.place) {
                  <div class="text-[11px] font-medium text-text-main">
                    {{ formatRollups(d.place.rollups) }}
                  </div>
                  <div class="mt-0.5 text-[10px] text-text-muted overflow-hidden text-ellipsis">
                    {{ d.place.display_name ?? '(no display name)' }}
                  </div>
                } @else {
                  <div class="text-[11px] text-text-muted">No place set</div>
                }
                <div class="mt-1.5 flex items-center justify-between">
                  <div class="flex items-center gap-1.5">
                    @let geocodeStatus = stageStatus('geocode', d.enrichment.geocode);
                    @if (geocodeStatus.label) {
                      @if (geocodeStatus.kind === 'failed') {
                        <span class="rounded-[3px] bg-error-bg px-1.5 py-0.5 text-[9px] uppercase tracking-[0.3px] text-error-text" [title]="geocodeStatus.tooltip ?? ''">{{ geocodeStatus.label }}</span>
                      } @else if (geocodeStatus.kind === 'paused') {
                        <a [href]="WORKERS_SETTINGS_URL" class="rounded-[3px] bg-surface-alt px-1.5 py-0.5 text-[9px] uppercase tracking-[0.3px] text-text-muted hover:text-text-main">{{ geocodeStatus.label }} →</a>
                      } @else {
                        <span class="rounded-[3px] bg-surface-alt px-1.5 py-0.5 text-[9px] uppercase tracking-[0.3px] text-text-muted" [title]="geocodeStatus.tooltip ?? ''">{{ geocodeStatus.label }}</span>
                      }
                    }
                  </div>
                  <div class="flex gap-2">
                    <button class="text-[10px] text-text-muted hover:text-text-main" type="button" (click)="startPlaceEdit(d)">Edit</button>
                    <button class="text-[10px] text-text-muted hover:text-text-main" type="button" (click)="requeue(d, 'geocode')">↻ Re-geocode</button>
                  </div>
                </div>
                @if (lastClickError()['geocode']) {
                  <div class="mt-1 text-[10px] text-error-text">{{ lastClickError()['geocode'] }}</div>
                } @else if (staleAfterRequeue()['geocode']) {
                  <div class="mt-1 text-[10px] text-text-muted">Still pending — check <a [href]="WORKERS_SETTINGS_URL" class="underline hover:text-text-main">worker status</a>.</div>
                }
              }
            </div>
          </maple-collapsible>
        }

        <!-- Description -->
        <maple-collapsible label="Description" storageKey="info-description">
          <div class="px-4 py-[5px]">
            @if (descriptionEditing()) {
              <textarea
                rows="3"
                class="box-border w-full rounded-[3px] border-[0.5px] border-border bg-input-bg px-1.5 py-1 text-[11px] text-text-main outline-none focus:border-primary resize-y"
                [value]="descriptionDraft()"
                (input)="descriptionDraft.set($any($event.target).value)"
                placeholder="Caption…"
              ></textarea>
              <div class="mt-1.5 flex justify-end gap-1.5">
                <button class="text-[10px] text-text-muted hover:text-text-main" type="button" (click)="cancelDescriptionEdit()">Cancel</button>
                <button class="text-[10px] font-medium text-primary hover:underline" type="button" (click)="saveDescriptionEdit(d)">Save</button>
              </div>
            } @else {
              <div class="text-[11px] leading-relaxed text-text-main whitespace-pre-wrap break-words">
                @if (d.description) {
                  {{ d.description }}
                } @else {
                  <span class="text-text-muted">No description yet</span>
                }
              </div>
              <div class="mt-1.5 flex items-center justify-between">
                <div class="flex items-center gap-1.5">
                  @let describeStatus = stageStatus('describe', d.enrichment.describe);
                  @if (describeStatus.label) {
                    @if (describeStatus.kind === 'failed') {
                      <span class="rounded-[3px] bg-error-bg px-1.5 py-0.5 text-[9px] uppercase tracking-[0.3px] text-error-text" [title]="describeStatus.tooltip ?? ''">{{ describeStatus.label }}</span>
                    } @else if (describeStatus.kind === 'paused') {
                      <a [href]="WORKERS_SETTINGS_URL" class="rounded-[3px] bg-surface-alt px-1.5 py-0.5 text-[9px] uppercase tracking-[0.3px] text-text-muted hover:text-text-main">{{ describeStatus.label }} →</a>
                    } @else {
                      <span class="rounded-[3px] bg-surface-alt px-1.5 py-0.5 text-[9px] uppercase tracking-[0.3px] text-text-muted" [title]="describeStatus.tooltip ?? ''">{{ describeStatus.label }}</span>
                    }
                  }
                </div>
                <div class="flex gap-2">
                  <button class="text-[10px] text-text-muted hover:text-text-main" type="button" (click)="startDescriptionEdit(d)">Edit</button>
                  <button class="text-[10px] text-text-muted hover:text-text-main" type="button" (click)="requeue(d, 'describe')">↻ Re-describe</button>
                </div>
              </div>
              @if (lastClickError()['describe']) {
                <div class="mt-1 text-[10px] text-error-text">{{ lastClickError()['describe'] }}</div>
              } @else if (staleAfterRequeue()['describe']) {
                <div class="mt-1 text-[10px] text-text-muted">Still pending — check <a [href]="WORKERS_SETTINGS_URL" class="underline hover:text-text-main">worker status</a>.</div>
              }
            }
          </div>
        </maple-collapsible>

        <!-- OCR text -->
        <maple-collapsible label="OCR text" storageKey="info-ocr">
          <div class="px-4 py-[5px]">
            @if (ocrEditing()) {
              <textarea
                rows="4"
                class="ocr-pre box-border w-full rounded-[3px] border-[0.5px] border-border bg-input-bg px-1.5 py-1 font-mono text-[10px] text-text-main outline-none focus:border-primary resize-y"
                [value]="ocrDraft()"
                (input)="ocrDraft.set($any($event.target).value)"
                placeholder="OCR text…"
              ></textarea>
              <div class="mt-1.5 flex justify-end gap-1.5">
                <button class="text-[10px] text-text-muted hover:text-text-main" type="button" (click)="cancelOcrEdit()">Cancel</button>
                <button class="text-[10px] font-medium text-primary hover:underline" type="button" (click)="saveOcrEdit(d)">Save</button>
              </div>
            } @else {
              @if (d.ocr_text && d.ocr_text.length > 0) {
                <pre class="ocr-pre m-0 whitespace-pre-wrap break-words font-mono text-[10px] text-text-main">{{ d.ocr_text }}</pre>
              } @else {
                <div class="text-[11px] text-text-muted">No text detected</div>
              }
              <div class="mt-1.5 flex items-center justify-between">
                <div class="flex items-center gap-1.5">
                  @let ocrStatus = stageStatus('ocr', d.enrichment.ocr);
                  @if (ocrStatus.label) {
                    @if (ocrStatus.kind === 'failed') {
                      <span class="rounded-[3px] bg-error-bg px-1.5 py-0.5 text-[9px] uppercase tracking-[0.3px] text-error-text" [title]="ocrStatus.tooltip ?? ''">{{ ocrStatus.label }}</span>
                    } @else if (ocrStatus.kind === 'paused') {
                      <a [href]="WORKERS_SETTINGS_URL" class="rounded-[3px] bg-surface-alt px-1.5 py-0.5 text-[9px] uppercase tracking-[0.3px] text-text-muted hover:text-text-main">{{ ocrStatus.label }} →</a>
                    } @else {
                      <span class="rounded-[3px] bg-surface-alt px-1.5 py-0.5 text-[9px] uppercase tracking-[0.3px] text-text-muted" [title]="ocrStatus.tooltip ?? ''">{{ ocrStatus.label }}</span>
                    }
                  }
                </div>
                <div class="flex gap-2">
                  <button class="text-[10px] text-text-muted hover:text-text-main" type="button" (click)="startOcrEdit(d)">Edit</button>
                  <button class="text-[10px] text-text-muted hover:text-text-main" type="button" (click)="requeue(d, 'ocr')">↻ Re-OCR</button>
                </div>
              </div>
              @if (lastClickError()['ocr']) {
                <div class="mt-1 text-[10px] text-error-text">{{ lastClickError()['ocr'] }}</div>
              } @else if (staleAfterRequeue()['ocr']) {
                <div class="mt-1 text-[10px] text-text-muted">Still pending — check <a [href]="WORKERS_SETTINGS_URL" class="underline hover:text-text-main">worker status</a>.</div>
              }
            }
          </div>
        </maple-collapsible>

        <!-- Faces -->
        <maple-collapsible label="Faces" storageKey="info-faces">
          <div class="px-4 py-[5px]">
            <div class="mb-1.5 text-[11px] text-text-main">
              {{ d.faces.length }} {{ d.faces.length === 1 ? 'face' : 'faces' }} detected
            </div>
            @if (d.faces.length > 0) {
              <div class="flex flex-wrap gap-1">
                @for (face of taggedFaces(d); track face.person_id) {
                  <a
                    [href]="'/people/' + face.person_id"
                    class="flex items-center gap-[3px] rounded-[3px] border-[0.5px] border-border bg-surface-alt px-1.5 py-0.5 text-[10px] text-text-main hover:border-primary hover:text-primary"
                  >
                    <maple-icon name="tag" [size]="9" color="currentColor" />
                    {{ face.person_id }}
                  </a>
                }
                @if (untaggedFaceCount(d) > 0) {
                  <a
                    [href]="'/people?asset=' + d.id"
                    class="rounded-[3px] border-[0.5px] border-dashed border-border px-1.5 py-0.5 text-[10px] text-text-muted hover:border-primary hover:text-primary"
                  >
                    + {{ untaggedFaceCount(d) }} unnamed
                  </a>
                }
              </div>
            }
            <div class="mt-1.5 flex items-center justify-between">
              <div class="flex items-center gap-1.5">
                @let faceStatus = stageStatus('face', d.enrichment.face);
                @if (faceStatus.label) {
                  @if (faceStatus.kind === 'failed') {
                    <span class="rounded-[3px] bg-error-bg px-1.5 py-0.5 text-[9px] uppercase tracking-[0.3px] text-error-text" [title]="faceStatus.tooltip ?? ''">{{ faceStatus.label }}</span>
                  } @else if (faceStatus.kind === 'paused') {
                    <a [href]="WORKERS_SETTINGS_URL" class="rounded-[3px] bg-surface-alt px-1.5 py-0.5 text-[9px] uppercase tracking-[0.3px] text-text-muted hover:text-text-main">{{ faceStatus.label }} →</a>
                  } @else {
                    <span class="rounded-[3px] bg-surface-alt px-1.5 py-0.5 text-[9px] uppercase tracking-[0.3px] text-text-muted" [title]="faceStatus.tooltip ?? ''">{{ faceStatus.label }}</span>
                  }
                }
              </div>
              <button class="text-[10px] text-text-muted hover:text-text-main" type="button" (click)="requeue(d, 'face')">↻ Re-detect</button>
            </div>
            @if (lastClickError()['face']) {
              <div class="mt-1 text-[10px] text-error-text">{{ lastClickError()['face'] }}</div>
            } @else if (staleAfterRequeue()['face']) {
              <div class="mt-1 text-[10px] text-text-muted">Still pending — check <a [href]="WORKERS_SETTINGS_URL" class="underline hover:text-text-main">worker status</a>.</div>
            }
          </div>
        </maple-collapsible>
      }

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
export class InfoTabComponent implements OnDestroy {
  state = inject(LibraryStateService);
  private readonly api = inject(BunApiBackendService);
  private readonly backend = inject(LIBRARY_BACKEND);
  private readonly injector = inject(Injector);

  readonly STAR_INDICES = [1, 2, 3, 4, 5];
  readonly COLOR_LABELS = COLOR_LABELS;
  readonly HISTORY = [
    { label: 'Original import', time: 'Import' },
    { label: 'Basic tone', time: '3d ago' },
    { label: 'Warm grade', time: '2h ago' },
  ];

  // ── Self-Hosted enrichment state ──────────────────────────────────────
  readonly selfHosted = this.backend === 'self-hosted';

  /** Deep link for "Worker paused" badges and stale-after-requeue hints.
   * The workers admin page already exists at this route. */
  readonly WORKERS_SETTINGS_URL = '/settings/workers';

  /** OSM static-tile zoom. 13 ≈ a town-sized window, which is the right
   * scale for a 86 px thumbnail; the user can zoom in via the click-out
   * link. */
  readonly MAP_ZOOM = 13;

  /** The last-fetched detail for the currently-focused asset. Cleared
   * whenever the focused asset changes. */
  readonly detail = signal<ApiAssetDetail | null>(null);

  /** Per-stage paused flag from GET /api/workers/status. Empty record
   * means "not yet fetched" — render as if not paused (so we don't show
   * the misleading "Worker paused" badge before we know). */
  readonly workerPaused = signal<Partial<Record<ApiEnrichmentStage, boolean>>>(
    {},
  );

  /** Per-stage last error string from the most recent Re-* or override
   * click. Cleared on the next successful click for the same stage. */
  readonly lastClickError = signal<Partial<Record<ApiEnrichmentStage, string>>>(
    {},
  );

  /** Per-stage flag set when the 30 s polling window expires without
   * `done_at` flipping. Tells the user the row is stuck rather than
   * actively in flight. Cleared on focus change and on the next click. */
  readonly staleAfterRequeue = signal<Partial<Record<ApiEnrichmentStage, true>>>(
    {},
  );

  // Per-section edit state. Local UI signals; not persisted.
  readonly placeEditing = signal(false);
  readonly placeDraft = signal('');
  readonly descriptionEditing = signal(false);
  readonly descriptionDraft = signal('');
  readonly ocrEditing = signal(false);
  readonly ocrDraft = signal('');

  /** API id of the asset currently fetched. Recomputed from the focused
   * asset's local id via `state.apiIdFor`. */
  private readonly apiAssetId = computed(() => {
    const asset = this.state.focusedAsset();
    if (!asset) return null;
    return this.state.apiIdFor(asset.id) ?? null;
  });

  /** Active subscription for the in-flight detail fetch. We hold the ref
   * so a focus change cancels the prior fetch. */
  private detailSub: Subscription | null = null;
  /** Polling timer + deadline for the post-requeue refresh window. */
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshDeadline = 0;
  /** Snapshot taken at requeue time; the poll stops when something
   * changes (`done_at` flips, version bumps, dead_letter clears, etc). */
  private refreshBaseline: ApiAssetDetail | null = null;
  /** Stage whose Re-* click started the current refresh loop, so we can
   * surface a row-specific "Still pending" hint on deadline expiry. */
  private refreshStage: ApiEnrichmentStage | null = null;

  constructor() {
    // Refetch detail on focus change. Self-Hosted only — Hosted has no
    // server-side enrichment payload.
    if (this.selfHosted) {
      this.fetchWorkerStatus();
      effect(() => {
        const apiId = this.apiAssetId();
        // Reset edit state and per-stage UI signals on focus change so
        // stale state from the previous asset doesn't leak through.
        this.cancelAllEdits();
        this.lastClickError.set({});
        this.staleAfterRequeue.set({});
        this.detail.set(null);
        this.stopRefreshLoop();
        if (apiId) this.fetchDetail(apiId);
      });
    }
  }

  /** Pull `config.paused` per stage from /api/workers/status. Called once
   * on init and refreshed on every Re-* click so a worker enabled in
   * another tab doesn't leave us showing a stale "Worker paused" badge. */
  private fetchWorkerStatus(): void {
    this.api.getWorkerStatus().subscribe({
      next: (status) => {
        const next: Partial<Record<ApiEnrichmentStage, boolean>> = {};
        for (const s of status.stages) {
          if (s.name === 'geocode' || s.name === 'describe' || s.name === 'ocr' || s.name === 'face') {
            // Trust `config.paused` first; fall back to the `status` string
            // which the API also exposes as "paused" when the config flag
            // is set on a running child.
            next[s.name] = s.config?.paused === true || s.status === 'paused';
          }
        }
        this.workerPaused.set(next);
      },
      error: () => {
        // Worker status endpoint unreachable — leave the cache empty.
        // The UI will show "Pending" (not "Worker paused"), which is the
        // best we can do without that signal.
      },
    });
  }

  ngOnDestroy(): void {
    this.detailSub?.unsubscribe();
    this.stopRefreshLoop();
  }

  // ── Detail fetch / refresh loop ───────────────────────────────────────

  private fetchDetail(apiId: string): void {
    this.detailSub?.unsubscribe();
    this.detailSub = this.api.getAssetDetails(apiId).subscribe({
      next: (d) => this.detail.set(d),
      error: () => {
        // Swallow — the section just stays empty. The `selfHosted &&
        // detail()` template guard keeps the UI clean.
      },
    });
  }

  /** Used by the requeue and refresh-poll paths so an inline error message
   * shows up under the row without leaking the raw HTTP error to the UI. */
  private setStageError(stage: ApiEnrichmentStage, message: string): void {
    this.lastClickError.update((m) => ({ ...m, [stage]: message }));
  }

  /** Clear the per-stage error + stale hint — called right before we
   * kick off a new request so the old message doesn't sit there. */
  private clearStageFeedback(stage: ApiEnrichmentStage): void {
    this.lastClickError.update((m) => {
      const next = { ...m };
      delete next[stage];
      return next;
    });
    this.staleAfterRequeue.update((m) => {
      const next = { ...m };
      delete next[stage];
      return next;
    });
  }

  /** After a requeue, poll the asset every 2 s for up to 30 s, stopping
   * as soon as the worker has clearly run (any per-stage state field
   * meaningfully different from the snapshot at requeue time). The
   * `stage` argument is the one the user clicked — if the deadline
   * expires without progress, we flag that stage's row as stale so the
   * user sees something other than a frozen "Pending" badge. */
  private startRefreshLoop(stage: ApiEnrichmentStage): void {
    if (!this.selfHosted) return;
    const apiId = this.apiAssetId();
    if (!apiId) return;
    this.stopRefreshLoop();
    this.refreshBaseline = this.detail();
    this.refreshStage = stage;
    this.refreshDeadline = Date.now() + REFRESH_TIMEOUT_MS;
    this.refreshTimer = setInterval(() => {
      if (Date.now() > this.refreshDeadline) {
        const expiredStage = this.refreshStage;
        if (expiredStage) {
          this.staleAfterRequeue.update((m) => ({ ...m, [expiredStage]: true }));
        }
        this.stopRefreshLoop();
        return;
      }
      const id = this.apiAssetId();
      if (!id) {
        this.stopRefreshLoop();
        return;
      }
      this.api.getAssetDetails(id).subscribe({
        next: (d) => {
          this.detail.set(d);
          if (this.detailChanged(this.refreshBaseline, d)) {
            this.stopRefreshLoop();
          }
        },
        error: () => {
          // A transient poll failure shouldn't kill the loop — the next
          // tick will try again. If the deadline expires we'll surface
          // it via `staleAfterRequeue` then.
        },
      });
    }, REFRESH_POLL_MS);
  }

  private stopRefreshLoop(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.refreshBaseline = null;
    this.refreshStage = null;
    this.refreshDeadline = 0;
  }

  /** True when something in the enrichment subdoc moved between the two
   * snapshots — a worker run flipped `done_at`, bumped `version`, cleared
   * an error, etc. */
  private detailChanged(
    a: ApiAssetDetail | null,
    b: ApiAssetDetail | null,
  ): boolean {
    if (!a || !b) return true;
    const stages: ApiEnrichmentStage[] = [
      'geocode',
      'face',
      'describe',
      'ocr',
    ];
    for (const s of stages) {
      const sa = a.enrichment[s];
      const sb = b.enrichment[s];
      if (sa.done_at !== sb.done_at) return true;
      if (sa.version !== sb.version) return true;
      if (sa.dead_letter_at !== sb.dead_letter_at) return true;
    }
    return false;
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  showPlaceSection(d: ApiAssetDetail): boolean {
    // Hide once geocoded as no-place (worker ran, found nothing). The
    // worker writes `place: null` AND sets `done_at` non-null in that
    // case; pending rows have `done_at: null`.
    if (d.place === null && d.enrichment.geocode.done_at !== null) {
      return false;
    }
    return true;
  }

  formatRollups(rollups: { locality: string | null; region: string | null }): string {
    const parts = [rollups.locality, rollups.region].filter(
      (v): v is string => !!v,
    );
    if (parts.length === 0) return '(no rollup)';
    return parts.join(', ');
  }

  taggedFaces(d: ApiAssetDetail): { person_id: string }[] {
    return d.faces
      .filter((f) => f.person_id !== null)
      .map((f) => ({ person_id: f.person_id! }));
  }

  untaggedFaceCount(d: ApiAssetDetail): number {
    return d.faces.filter((f) => f.person_id === null).length;
  }

  // ── Edit-mode toggles ─────────────────────────────────────────────────

  startPlaceEdit(d: ApiAssetDetail): void {
    this.placeDraft.set(d.place?.display_name ?? '');
    this.placeEditing.set(true);
  }
  cancelPlaceEdit(): void {
    this.placeEditing.set(false);
    this.placeDraft.set('');
  }
  savePlaceEdit(d: ApiAssetDetail): void {
    const text = this.placeDraft().trim();
    // The override route accepts a full Place document (the worker's
    // output shape). For a manual single-line correction we synthesise
    // a minimal Place keyed off the existing one; if the row had no
    // place at all, we send a stub with display_name + everything else
    // empty so it at least surfaces in the UI.
    const next = text
      ? {
          source: 'manual',
          geocoder_version: 0,
          geocoded_at: new Date().toISOString(),
          lat: d.place?.lat ?? 0,
          lon: d.place?.lon ?? 0,
          display_name: text,
          address: d.place?.address ?? {},
          pois: d.place?.pois ?? [],
          rollups: d.place?.rollups ?? {
            locality: null,
            region: null,
            country_code: null,
          },
          search_blob: text.toLowerCase(),
        }
      : null;
    this.clearStageFeedback('geocode');
    this.api.setAssetPlaceOverride(d.id, next).subscribe({
      next: () => {
        this.placeEditing.set(false);
        this.refetchAfterMutation();
      },
      error: () => {
        this.setStageError('geocode', 'Failed to save — try again.');
      },
    });
  }

  startDescriptionEdit(d: ApiAssetDetail): void {
    this.descriptionDraft.set(d.description ?? '');
    this.descriptionEditing.set(true);
  }
  cancelDescriptionEdit(): void {
    this.descriptionEditing.set(false);
    this.descriptionDraft.set('');
  }
  saveDescriptionEdit(d: ApiAssetDetail): void {
    const text = this.descriptionDraft();
    this.clearStageFeedback('describe');
    this.api
      .setAssetDescriptionOverride(d.id, text.length > 0 ? text : null)
      .subscribe({
        next: () => {
          this.descriptionEditing.set(false);
          this.refetchAfterMutation();
        },
        error: () => {
          this.setStageError('describe', 'Failed to save — try again.');
        },
      });
  }

  startOcrEdit(d: ApiAssetDetail): void {
    this.ocrDraft.set(d.ocr_text ?? '');
    this.ocrEditing.set(true);
  }
  cancelOcrEdit(): void {
    this.ocrEditing.set(false);
    this.ocrDraft.set('');
  }
  saveOcrEdit(d: ApiAssetDetail): void {
    const text = this.ocrDraft();
    this.clearStageFeedback('ocr');
    this.api
      .setAssetOcrOverride(d.id, text.length > 0 ? text : null)
      .subscribe({
        next: () => {
          this.ocrEditing.set(false);
          this.refetchAfterMutation();
        },
        error: () => {
          this.setStageError('ocr', 'Failed to save — try again.');
        },
      });
  }

  private cancelAllEdits(): void {
    this.cancelPlaceEdit();
    this.cancelDescriptionEdit();
    this.cancelOcrEdit();
  }

  /** Refetch the detail once after a manual override (no polling — the
   * field went directly to Mongo, so the next read is enough). */
  private refetchAfterMutation(): void {
    const apiId = this.apiAssetId();
    if (!apiId) return;
    runInInjectionContext(this.injector, () => this.fetchDetail(apiId));
  }

  // ── Requeue ───────────────────────────────────────────────────────────

  requeue(d: ApiAssetDetail, stage: ApiEnrichmentStage): void {
    this.clearStageFeedback(stage);
    // Refresh worker pause flags in the background — catches the case
    // where the user enabled (or paused) a worker in another tab.
    this.fetchWorkerStatus();
    this.api.requeueEnrichmentStage(d.id, stage).subscribe({
      next: () => {
        // Clear the per-stage `done_at` locally so the Pending badge
        // appears immediately, then start polling for the worker's
        // result.
        const current = this.detail();
        if (current) {
          this.detail.set({
            ...current,
            enrichment: {
              ...current.enrichment,
              [stage]: {
                ...current.enrichment[stage],
                done_at: null,
                dead_letter_at: null,
                last_error: null,
              },
            },
          });
        }
        this.startRefreshLoop(stage);
      },
      error: () => {
        this.setStageError(stage, 'Failed to requeue — try again.');
      },
    });
  }

  // ── Existing helpers ──────────────────────────────────────────────────

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

  // ── Enrichment status derivation ──────────────────────────────────────

  /** Decide what badge to show for a stage row. The DTO carries enough
   * fields to pin down every state — we layer the worker-pause cache on
   * top so a paused-on-first-boot stage reads as "Worker paused" instead
   * of an indefinite "Pending". Priority order matches the table in the
   * plan: failed > skipped > complete > paused > running > pending. */
  stageStatus(
    stage: ApiEnrichmentStage,
    s: ApiEnrichmentStageState,
  ): { kind: 'failed' | 'skipped' | 'paused' | 'running' | 'pending' | 'complete'; label: string; tooltip?: string } {
    if (s.dead_letter_at) {
      return { kind: 'failed', label: 'Failed', tooltip: s.last_error ?? undefined };
    }
    // A "skip: …" last_error means the worker decided not to process the
    // asset — done_at is also set in that case (the supervisor stamps
    // both fields in the skip path).
    if (s.last_error?.startsWith('skip: ')) {
      const reason = s.last_error.slice('skip: '.length);
      return { kind: 'skipped', label: this.skipReasonLabel(reason), tooltip: s.last_error };
    }
    if (s.done_at !== null) {
      // Complete — no badge needed.
      return { kind: 'complete', label: '' };
    }
    if (this.workerPaused()[stage]) {
      return { kind: 'paused', label: 'Worker paused' };
    }
    // Treat a live lease as "Running…"; otherwise the row is queued for
    // the next supervisor tick.
    if (s.locked_by && s.lease_expires_at) {
      const expires = Date.parse(s.lease_expires_at);
      if (Number.isFinite(expires) && expires > Date.now()) {
        return { kind: 'running', label: 'Running…' };
      }
    }
    return { kind: 'pending', label: 'Pending' };
  }

  /** Human label for a `skip: …` reason. Falls back to a generic
   * "Skipped" with the raw reason in the tooltip so we don't lose info
   * for skip cases the workers may add later. */
  private skipReasonLabel(reason: string): string {
    if (reason === 'no-gps') return 'No GPS';
    if (reason === 'image-missing') return 'No thumbnail';
    if (reason.startsWith('thumb-missing')) return 'No thumbnail';
    if (reason.startsWith('thumb-undecodable')) return 'Thumbnail unreadable';
    return 'Skipped';
  }

  // ── Map tile helpers ──────────────────────────────────────────────────

  /** Clamp lat to the WebMercator-defined band and wrap lon into
   * [-180, 180). Without this, lat near ±90 collapses to NaN/Infinity
   * (cos(π/2) ≈ 0 in the y formula) and lon ≥ 180 lands at x = 2^z
   * which is one past the valid range — both produce 404 tiles. The
   * lat bound is atan(sinh(π)) ≈ 85.05112878°, the standard
   * WebMercator limit. */
  private normalizeLatLon(lat: number, lon: number): { lat: number; lon: number } {
    const MAX_LAT = 85.05112877980659;
    const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    // ((lon + 180) % 360 + 360) % 360 - 180 — wraps any real lon
    // (including 180.0 itself, which becomes -180.0, same meridian) to
    // [-180, 180).
    const wrappedLon = (((lon + 180) % 360) + 360) % 360 - 180;
    return { lat: clampedLat, lon: wrappedLon };
  }

  /** OSM raster tile URL for the slippy-map tile that *contains*
   * (lat, lon) at the given zoom. Standard math from
   * https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames. The pin
   * helper renders the photo's exact spot inside the tile via fractional
   * offsets — for an 86 px thumbnail this is good enough; the
   * open-in-maps link opens a real centered view. */
  staticMapTileUrl(lat: number, lon: number, zoom: number): string {
    const { lat: nLat, lon: nLon } = this.normalizeLatLon(lat, lon);
    const z = Math.max(0, Math.min(19, Math.floor(zoom)));
    const n = Math.pow(2, z);
    const xRaw = Math.floor(((nLon + 180) / 360) * n);
    const latRad = (nLat * Math.PI) / 180;
    const yRaw = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
    );
    // Defensive clamp — after normalization xRaw/yRaw should already be
    // in [0, n-1], but FP rounding at exactly the wrap edge could land
    // at n. A tile request at index n would 404.
    const x = Math.max(0, Math.min(n - 1, xRaw));
    const y = Math.max(0, Math.min(n - 1, yRaw));
    return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  }

  /** CSS left/top percentages so the pin sits on the actual lat/lon
   * inside the rendered tile. Same slippy-map math, fractional part —
   * applies the same lat clamp + lon wrap as the tile helper so the
   * pin stays consistent with the tile we picked. */
  pinOffsetPct(lat: number, lon: number): { left: string; top: string } {
    const { lat: nLat, lon: nLon } = this.normalizeLatLon(lat, lon);
    const n = Math.pow(2, this.MAP_ZOOM);
    const xFrac = ((nLon + 180) / 360) * n;
    const latRad = (nLat * Math.PI) / 180;
    const yFrac =
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    const left = (xFrac - Math.floor(xFrac)) * 100;
    const top = (yFrac - Math.floor(yFrac)) * 100;
    return { left: `${left.toFixed(2)}%`, top: `${top.toFixed(2)}%` };
  }

  /** External "open in maps" URL — the OSM web viewer with a marker.
   * `mlat`/`mlon` drop a pin; the `#map=` fragment sets the view. */
  openInMapsUrl(lat: number, lon: number): string {
    const z = 14;
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${z}/${lat}/${lon}`;
  }
}
