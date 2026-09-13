// LensProfileSelectComponent — bundled-Lensfun lens profile dropdown (#3569,
// Web slice of epic #3564). Structural twin of Apple's
// `LensProfileChoice.swift` + the "Profile" row in `LensCorrectionsSection`:
// an "Automatic" option plus every bundled lens the focused RAW's camera
// body can carry, resolved directly against raw-core
// (`RawPipelineService.compatibleLensProfiles` / `.lensProfileEvidence`,
// `src/raw-pipeline/raw-wasm/src/lens_profile.rs`) rather than waiting on a
// render reply — so a pick is described immediately, the same reason Apple's
// view model runs its own FFI round trip instead of reading the develop
// path's own evidence.
//
// Picking an option writes `papp:LensProfile` as one undoable edit: `''` for
// Automatic, `lensfun1:<slug>` for a bundled lens. An already-selected
// `lcp1:`/`lcp1-ack:` reference (#3395/#3479, set by the file-import block
// this component sits above) is appended to the option list so the dropdown
// never silently misrepresents the current selection, mirroring
// `LensProfileChoice.build`'s defensive append in the Swift original.
//
// `evidence`/`compatibleLenses` are public so the parent panel
// (`LensCorrectionsPanelComponent`, via a `viewChild` signal query) can
// widen its OWN master-toggle/slider gating to a Lensfun-only match — a RAW
// with no embedded `OpcodeList3` still has a correction actually applying
// (`crs:LensProfileEnable`'s own default), so the panel must not leave its
// controls looking inert while that's happening.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { Asset } from '../../models/asset';
import { LibraryStateService } from '../../state/library-state.service';
import { EditorStateService } from '../../editor/editor-state.service';
import { RawPipelineService } from '../../raw-pipeline/raw-pipeline.service';
import { MuiSelectComponent } from '../../ui/select/mui-select.component';
import { MuiTextComponent } from '../../ui/text/mui-text.component';
import type {
  CompatibleLensProfile,
  LensProfileEvidence,
} from '../../lens/lens-profile-choice.types';

interface LensProfileOption {
  readonly value: string;
  readonly label: string;
}

const AUTOMATIC_OPTION: LensProfileOption = { value: '', label: 'Automatic' };
const BUNDLED_PREFIX = 'lensfun1:';

@Component({
  selector: 'lens-profile-select',
  standalone: true,
  imports: [MuiSelectComponent, MuiTextComponent],
  templateUrl: './lens-profile-select.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LensProfileSelectComponent {
  private readonly library = inject(LibraryStateService);
  private readonly editor = inject(EditorStateService);
  private readonly pipeline = inject(RawPipelineService);

  /** Bumped per reload so a slow fetch from an abandoned asset/reference can
   *  never land on a newer one — the generation-counter guard every async
   *  view-model reload in this codebase uses (mirrors `LensProfileChoice`'s
   *  own `generation` field on the Apple side). */
  private generation = 0;

  readonly isLoading = signal(true);
  readonly loadError = signal('');
  /** Public: the parent panel's gating reads these directly (see file banner). */
  readonly compatibleLenses = signal<CompatibleLensProfile[]>([]);
  readonly evidence = signal<LensProfileEvidence | undefined>(undefined);

  /** The focused asset's sidecar selection (`papp:LensProfile`), `''` = automatic. */
  readonly reference = computed<string>(() => {
    const id = this.library.focusedAssetId();
    return id ? this.library.adjustmentFor(id)().lensProfile : '';
  });

  readonly options = computed<LensProfileOption[]>(() => {
    const bundled = [...this.compatibleLenses()]
      .sort((a, b) => `${a.maker} ${a.model}`.localeCompare(`${b.maker} ${b.model}`))
      .map((lens) => ({
        value: `${BUNDLED_PREFIX}${lens.slug}`,
        label: `${lens.maker} ${lens.model}`,
      }));
    const options = [AUTOMATIC_OPTION, ...bundled];
    const reference = this.reference();
    // A reference the compatible list doesn't (yet) name — an imported LCP
    // selection, or a bundled slug this camera match no longer lists — stays
    // visible rather than silently reading back as Automatic.
    if (reference && !options.some((option) => option.value === reference)) {
      options.push({ value: reference, label: this.fallbackLabel(reference) });
    }
    return options;
  });

  readonly sourceDescription = computed<string>(() => {
    if (this.loadError()) return this.loadError();
    if (this.isLoading()) return 'Resolving the lens profile…';
    const evidence = this.evidence();
    switch (evidence?.source) {
      case 'lensfun': {
        // Name the matched lens even when Automatic (no explicit pick) is in
        // effect — the dropdown itself just reads "Automatic", so this line
        // is the only place a Lensfun auto-match is named at all.
        const lens = evidence.lens ? `${evidence.lens} · ` : '';
        return `${lens}Lensfun database ${evidence.dbVersion ?? ''} · CC BY-SA 3.0`.trim();
      }
      case 'lcp':
        return 'Imported profile';
      case 'embedded':
        return 'Embedded corrections';
      case 'none':
        return this.reference() ? 'No lens correction data' : 'Automatic — no match';
      default:
        return '';
    }
  });

  readonly selectDisabled = computed<boolean>(
    () => this.isLoading() || !this.library.focusedAssetId(),
  );

  constructor() {
    // Reload on either an asset switch or a reference change (a pick, an
    // undo/redo, or a preset apply) — the same two-key reload trigger
    // Apple's `.task(id:)` uses (`ProfileTaskKey`), translated to Angular's
    // "read every dependency, then run the async work untracked" shape so
    // the reload itself doesn't retrigger this effect.
    effect(() => {
      const asset = this.library.focusedAsset();
      const reference = this.reference();
      untracked(() => void this.reload(asset, reference));
    });
  }

  select(value: string): void {
    const id = this.library.focusedAssetId();
    if (!id || value === this.reference()) return;
    this.editor.commit('adjustment', 'Lens Profile');
    this.library.updateAdjustment(id, { lensProfile: value });
    this.editor.endEdit();
  }

  private fallbackLabel(reference: string): string {
    if (reference.startsWith(BUNDLED_PREFIX)) {
      const evidenceLens = this.evidence()?.lens;
      return evidenceLens ?? reference.slice(BUNDLED_PREFIX.length);
    }
    return 'Imported profile';
  }

  private async reload(asset: Asset | null | undefined, reference: string): Promise<void> {
    const generation = ++this.generation;
    if (!asset) {
      this.compatibleLenses.set([]);
      this.evidence.set(undefined);
      this.loadError.set('');
      this.isLoading.set(false);
      return;
    }
    this.isLoading.set(true);
    try {
      const bytes = await this.library.bytesForAsset(asset.id);
      if (generation !== this.generation) return;
      const ext = asset.filename.split('.').pop()?.toLowerCase() ?? '';
      const [lenses, evidence] = await Promise.all([
        this.pipeline.compatibleLensProfiles(bytes, ext),
        this.pipeline.lensProfileEvidence(bytes, ext, reference),
      ]);
      if (generation !== this.generation) return;
      this.compatibleLenses.set(lenses);
      this.evidence.set(evidence);
      this.loadError.set('');
    } catch (error) {
      if (generation !== this.generation) return;
      this.compatibleLenses.set([]);
      this.evidence.set(undefined);
      this.loadError.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === this.generation) this.isLoading.set(false);
    }
  }
}
