// LensProfileImportComponent — import, inspect and select a user-owned `.lcp`
// lens profile for the focused RAW (#3479, slice 3 of #3395; contract in
// docs/lens-profiles.md). Sits at the top of the Lens Corrections panel.
//
// Flow: pick a file → the render worker registers it, resolves it against
// the focused RAW and persists the bytes (IndexedDB; Self Hosted also
// uploads the same file to the server cache and checks both agree on the
// content reference) → the resolver's verdict is shown: camera/lens match,
// which families the calibration covers, the interpolated samples, and any
// approximations or unsupported records. **Use profile** writes ONE
// undoable sidecar edit setting `lensProfile` to `lcp1:<digest>`. When the
// resolver reported approximations the button stays disabled until the
// separate acceptance checkbox is ticked, and the edit then writes
// `lcp1-ack:<digest>` — the only way approximations are ever applied. A
// camera/lens mismatch or an unsupported model is an import ERROR: there is
// nothing to accept and no candidate to apply.
//
// The resolver's verdict for the SELECTED profile comes back with every
// render reply (`LibraryStateService.lensCorrectionsFor(id).lensProfile`),
// so after "Use profile" the panel describes what the renderer actually
// consumed, and `LensCorrectionsPanelComponent` enables each strength
// slider only for a family that calibration covers. A selected profile no
// cache can supply is shown as an explicit error (`RawPipelineService.
// lensProfileStatus`); raw-core refuses that render rather than silently
// skipping the correction.

import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  computed,
  inject,
  signal,
} from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { MuiBannerComponent } from '../../ui/banner/mui-banner.component';
import { MuiButtonComponent } from '../../ui/button/mui-button.component';
import { MuiCheckboxComponent } from '../../ui/checkbox/mui-checkbox.component';
import { MuiCollapsibleComponent } from '../../ui/collapsible/mui-collapsible.component';
import { MuiTextComponent } from '../../ui/text/mui-text.component';
import { lensProfileDigest } from '../../lens/lens-profile-cache';
import { LENS_PROFILE_MISSING_MESSAGE } from '../../lens/lens-profile-restorer';
import { uploadServerLensProfile } from '../../lens/lens-profile-server-bridge';
import type {
  ImportedLensProfile,
  LensProfileResolution,
  LensProfileSample,
} from '../../lens/lens-profile.types';
import type { AssetId } from '../../models/asset';

/** 32 MiB — the same ceiling the Self Hosted import route enforces. */
const MAX_LCP_BYTES = 32 * 1024 * 1024;

/** `lcp1:` and `lcp1-ack:` name the same bytes; anything else never matches. */
function sameProfile(a: string, b: string): boolean {
  try {
    return lensProfileDigest(a) === lensProfileDigest(b);
  } catch {
    return false;
  }
}

@Component({
  selector: 'lens-profile-import',
  standalone: true,
  imports: [
    MuiBannerComponent,
    MuiButtonComponent,
    MuiCheckboxComponent,
    MuiCollapsibleComponent,
    MuiTextComponent,
  ],
  templateUrl: './lens-profile-import.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LensProfileImportComponent {
  private readonly library = inject(LibraryStateService);
  private readonly editor = inject(EditorStateService);
  private readonly pipeline = inject(RawPipelineService);
  private readonly injector = inject(Injector);

  /** Bumped per pick so a slow import can never land on a later pick. */
  private generation = 0;
  private readonly candidateAsset = signal<AssetId | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly candidate = signal<ImportedLensProfile | null>(null);
  /** The separate acceptance control for reported approximations. */
  readonly acknowledged = signal(false);

  /** The focused asset's sidecar selection (`papp:LensProfile`), or ''. */
  readonly selected = computed(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)().lensProfile : '';
  });
  /** The renderer's verdict for the selected profile, once a render carried it. */
  readonly resolved = computed<LensProfileResolution | undefined>(() => {
    const id = this.library.focusedAssetId();
    const facts = id ? this.library.lensCorrectionsFor(id).lensProfile : undefined;
    return facts && facts.reference === this.selected() ? facts : undefined;
  });
  /** An import belongs to the asset it was resolved against; never leak it to another. */
  readonly visibleCandidate = computed(() =>
    this.candidateAsset() === this.library.focusedAssetId() ? this.candidate() : null,
  );
  readonly details = computed(() => this.visibleCandidate()?.resolution ?? this.resolved());
  readonly needsAcknowledgement = computed(
    () => (this.visibleCandidate()?.resolution.approximations.length ?? 0) > 0,
  );
  readonly canApply = computed(
    () =>
      this.visibleCandidate()?.resolution.source === 'lcp' &&
      (!this.needsAcknowledgement() || this.acknowledged()),
  );
  readonly selectionLabel = computed(() =>
    this.resolved()
      ? 'Imported lens profile selected.'
      : 'Waiting for the renderer to assess the selected profile.',
  );
  /** The worker could not supply the selected profile from any cache. */
  readonly unavailable = computed(() => {
    const status = this.pipeline.lensProfileStatus();
    const selected = this.selected();
    if (!status || status.available || !selected || !sameProfile(status.reference, selected))
      return '';
    // Embedded corrections win regardless — the missing bytes were never needed.
    if (this.resolved()?.source === 'embedded') return '';
    return status.message ?? LENS_PROFILE_MISSING_MESSAGE;
  });

  async choose(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const asset = this.library.focusedAsset();
    if (!file || !asset) return;
    const generation = ++this.generation;
    this.candidate.set(null);
    this.acknowledged.set(false);
    this.error.set('');
    this.busy.set(true);
    try {
      const profile = await this.readProfile(file, asset.id, asset.filename);
      if (!this.ownsImport(generation, asset.id)) return;
      this.candidateAsset.set(asset.id);
      this.candidate.set(profile);
    } catch (error) {
      if (this.ownsImport(generation, asset.id)) {
        this.error.set(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (generation === this.generation) this.busy.set(false);
    }
  }

  private ownsImport(generation: number, assetId: AssetId): boolean {
    return generation === this.generation && assetId === this.library.focusedAssetId();
  }

  private async readProfile(
    file: File,
    assetId: AssetId,
    filename: string,
  ): Promise<ImportedLensProfile> {
    if (file.size > MAX_LCP_BYTES) throw new Error('Lens profiles must be smaller than 32 MiB.');
    // `ignoreBOM` keeps a leading BOM in the string: the reference is the
    // digest of the EXACT bytes, on every host.
    const xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      await file.arrayBuffer(),
    );
    const bytes = await this.library.bytesForAsset(assetId);
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const profile = await this.pipeline.importLensProfile(xml, bytes, ext);
    if (this.library.backend === 'self-hosted') {
      const serverReference = await uploadServerLensProfile(this.injector, file);
      if (serverReference !== profile.reference)
        throw new Error('The server and this browser disagree on the imported profile.');
    }
    return profile;
  }

  apply(): void {
    const candidate = this.visibleCandidate();
    if (!candidate || !this.canApply()) return;
    const reference = this.needsAcknowledgement()
      ? candidate.reference.replace('lcp1:', 'lcp1-ack:')
      : candidate.reference;
    this.write(reference, 'Select lens profile');
    this.candidate.set(null);
    this.acknowledged.set(false);
  }

  clear(): void {
    this.write('', 'Use embedded lens corrections');
    this.candidate.set(null);
    this.acknowledged.set(false);
  }

  /** One undoable edit — the same commit → write → close shape every
   *  discrete `EditorStateService` mutator uses. */
  private write(reference: string, description: string): void {
    const id = this.library.focusedAssetId();
    if (!id) return;
    this.editor.commit('adjustment', description);
    this.library.updateAdjustment(id, { lensProfile: reference });
    this.editor.endEdit();
  }

  // ── Display helpers ────────────────────────────────────────────────────────

  profileTitle(profile: ImportedLensProfile): string {
    return profile.name || profile.lens || 'Imported lens profile';
  }

  profileSubtitle(profile: ImportedLensProfile): string {
    return [profile.make, profile.camera, profile.lens].filter(Boolean).join(' · ');
  }

  confidenceLabel(resolution: LensProfileResolution): string {
    return resolution.confidence === 'in-range'
      ? 'Camera and lens match; the frame is within the calibrated range.'
      : 'Camera and lens match; some settings fall outside the calibrated range.';
  }

  /** Which correction families this calibration covers — the panel's
   *  strength sliders disable for the ones it does not. */
  familiesLabel(resolution: LensProfileResolution): string {
    const families: [boolean | undefined, string][] = [
      [resolution.hasDistortion, 'distortion'],
      [resolution.hasCa, 'chromatic aberration'],
      [resolution.hasVignetting, 'vignetting'],
    ];
    const covered = families.filter(([has]) => has).map(([, name]) => name);
    const missing = families.filter(([has]) => !has).map(([, name]) => name);
    return (
      `Calibrated: ${covered.length ? covered.join(', ') : 'none'}` +
      (missing.length ? ` · Not calibrated: ${missing.join(', ')}` : '')
    );
  }

  sampleLabel(family: string, sample: LensProfileSample): string {
    return `${family}: ${sample.focalMm} mm · weight ${sample.weight.toFixed(2)}`;
  }
}
