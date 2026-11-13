// Grid-cell asset tile — the browse grid's per-photo cell. Composed from
// `<mui-media-cell layout="overlay">` (image, selection ring, corner-badge
// slots, readonly rating/flags row) plus this component's own overlay
// content: the HIDDEN badge, no-preview badge, Live Photo badge and clip Play
// button, RAW+JPEG stack badge, select-mode checkbox and edited-XMP checkmark.
// The tile carries no filename caption (#5846): the name lives in the Info
// pane, which is also where rename starts, next to F2.
//
// Split out of `<maple-asset-thumb>` (MW6, ticket #3047) once the grid
// variant moved onto Maple UI composition — `asset-thumb` now renders only
// the editor filmstrip's tile, which stays hand-rolled pending the
// perf-gated editor wave (see that component's own header comment). The
// two used to share one component branched on a `variant` input; keeping
// them share nothing at all is deliberate — with the grid tile mui-composed
// and the filmstrip tile mui-untouched, a shared branch would have been one
// accidental edit away from crossing that mui/non-mui boundary and
// regressing filmstrip's decode-hot render path (#2520/#2526 history).
//
// Thumbnail acquisition delegates to `createAssetThumbnailUrlSignal`, the
// same composable `<maple-asset-thumb>` uses — same `LibraryStateService`
// contract, same recycle/destroy cleanup rationale, extracted to a shared
// function rather than duplicated between the two components verbatim.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { parseAddress, toApiPath } from '../../addressing/maple-address';
import { MapleIconComponent } from '../../icons/maple-icon.component';
import { Asset } from '../../models/asset';
import { LibraryStateService } from '../../state/library-state.service';
import { createAssetThumbnailUrlSignal } from '../../state/asset-thumbnail-url-signal';
import { noPreviewBadgeLabel as computeNoPreviewBadgeLabel } from '../../state/no-preview-extensions';
import {
  mediaRouteUrl,
  PREVIEW_VIDEO_ACCESS,
} from '../../shells/preview-shell/preview-video-access';
import { MuiMediaCellComponent } from '../../ui/media-cell/mui-media-cell.component';
import type { MuiRatingFlagState } from '../../ui/rating-flags/mui-rating-flags.component';
import { ASSET_RENAME_CAPABILITY } from '../../rename/asset-rename-capability';
import { InlineRenameFieldComponent } from '../inline-rename-field/inline-rename-field.component';

@Component({
  selector: 'maple-asset-tile',
  standalone: true,
  imports: [MapleIconComponent, MuiMediaCellComponent, InlineRenameFieldComponent],
  templateUrl: './asset-tile.component.html',
  host: { class: 'block w-full h-full' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssetTileComponent {
  /** Asset to render. Required; the binding signal handles re-renders
   * when the parent's list updates. */
  asset = input.required<Asset>();

  /** Multi-select highlight (browse). */
  selected = input<boolean>(false);

  /** Click events bubble up so the parent decides what selection /
   * navigation actions mean. Don't put click handlers in here. */
  thumbClick = output<MouseEvent>();

  private state = inject(LibraryStateService);
  readonly sidecarError = computed(() => this.state.sidecarLoadError?.(this.asset().id) ?? null);
  private readonly videoAccess = inject(PREVIEW_VIDEO_ACCESS);
  /** The capability interface, not `AssetRenameService`: see
   * `asset-rename-capability.ts` for why Hosted must not import the service. */
  protected readonly renameSvc = inject(ASSET_RENAME_CAPABILITY);
  /** F2 on the focused tile opens the rename field over it (#2637). */
  readonly isEditingFilename = computed(() => this.renameSvc.editingAssetId() === this.asset().id);
  protected readonly pendingCollision = computed(() => {
    const pending = this.renameSvc.collision();
    return pending?.assetId === this.asset().id ? pending : null;
  });

  readonly livePhoto = computed(() => this.asset().livePhoto);

  /** Tokenized clip URL while this tile plays its Live Photo clip inline; minted on Play so the token is current. */
  readonly clipSrc = signal<string | undefined>(undefined);

  onPlayClip(event: Event): void {
    event.stopPropagation();
    this.clipSrc.set(this.clipSrc() ? undefined : this.mintClipUrl());
  }

  stopClip(event?: Event): void {
    event?.stopPropagation();
    this.clipSrc.set(undefined);
  }

  private mintClipUrl(): string | undefined {
    const address = parseAddress(this.asset().id);
    return address.slug && address.relPath
      ? mediaRouteUrl(this.videoAccess, 'video', toApiPath(address))
      : undefined;
  }

  /** Select mode (#2404) — session-scoped signal on LibraryStateService.
   * Drives the checkbox affordance in the top-right corner, next to the
   * `edited` badge, while the grid's Select toggle is on. */
  readonly isSelecting = this.state.isSelecting;

  /** The blob URL for this asset, or undefined until it loads (gradient
   * placeholder stays) — see `createAssetThumbnailUrlSignal`'s doc for the
   * ownership/cleanup contract, shared verbatim with `<maple-asset-thumb>`. */
  readonly thumbUrl = createAssetThumbnailUrlSignal(this.asset);
  readonly thumbnailFailed = computed(() => this.state.thumbnailFailed(this.asset().id));

  /** Uppercased extension (e.g. "MP3", "EIP", "MOV") when this asset is a
   * recognised no-preview format, else undefined — drives the "no preview
   * available" pill in the template. */
  readonly noPreviewBadgeLabel = computed(
    () => computeNoPreviewBadgeLabel(this.asset().filename) ?? undefined,
  );

  /** `mui-media-cell`'s gradient-placeholder CSS value for the "not
   * decoded yet" state — wraps the asset's data-URI SVG swatch in `url()`,
   * same construction `asset-thumb`'s original template did inline. */
  readonly placeholderBackground = computed(() => `url(${this.asset().thumbnailGradient})`);

  /** `Asset.flag`'s wire vocabulary is `'unflagged' | 'pick' | 'reject'`;
   * `mui-rating-flags`' is `'none' | 'pick' | 'reject'` — this is the one
   * spot that reconciles them, rather than teaching either side the
   * other's vocabulary. */
  readonly mappedFlag = computed<MuiRatingFlagState>(() => {
    const flag = this.asset().flag;
    return flag === 'unflagged' ? 'none' : flag;
  });
}
