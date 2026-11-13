import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { AssetId } from '../models/asset';
import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';
import type { XmpCulling } from '../xmp/xmp.types';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { SelfHostedWorkflowWriterService } from '../xmp/self-hosted-workflow-writer.service';
import { LibraryStore } from './library-store.service';

interface Saved {
  readonly model: AdjustmentModel;
  readonly culling: XmpCulling;
}

function changed<T extends object>(before: T, after: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) => JSON.stringify(Reflect.get(before, key)) !== JSON.stringify(value),
    ),
  ) as Partial<T>;
}

/**
 * A save that merged onto an outside edit replaces the live model with the
 * merged document, so the next save of a stale in-memory model cannot overwrite
 * the merge. Edits made while that save was in flight stay on top (#4983).
 */
@Injectable({ providedIn: 'root' })
export class SidecarMergeAdoptionService {
  private readonly store = inject(LibraryStore);
  private readonly parser = inject(XmpParserService);
  private readonly xmpStore = inject(XmpStoreService);
  private readonly selfHosted = inject(SelfHostedWorkflowWriterService);
  private readonly destroyRef = inject(DestroyRef);

  /** `remember` records a confirmed Self Hosted document the way a workflow restore does. */
  follow(remember: (id: AssetId, xml: string, model: AdjustmentModel) => void): void {
    this.xmpStore.merged.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((merge) => {
      const { assetId, binding } = merge;
      const selected = this.xmpStore.bindingFor(assetId, binding.folder, binding.rawFilename);
      if (this.store.currentFolder() !== binding.folder || selected.variantId !== binding.variantId)
        return;
      const adopted = this.adopt(assetId, merge.xml, merge.saved);
      if (merge.pending)
        this.xmpStore.scheduleWrite(
          assetId,
          binding.folder,
          binding.rawFilename,
          adopted.model,
          adopted.culling,
        );
    });
    this.selfHosted.merged.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((merge) => {
      const asset = this.store
        .assets()
        .find((candidate) => this.store.absPathFor(candidate.id) === merge.path);
      if (
        !asset ||
        this.store.workflowVariants.variantFor(asset.id, merge.path) !== merge.variantId
      )
        return;
      remember(asset.id, merge.xml, this.adopt(asset.id, merge.xml, merge.saved).model);
    });
  }

  private adopt(id: AssetId, xml: string, saved: Saved): Saved {
    const asset = this.store.findAsset(id);
    const live: XmpCulling | undefined = asset && {
      rating: asset.rating,
      flag: asset.flag,
      colorLabel: asset.colorLabel,
      keywords: asset.keywords ?? [],
    };
    const model = this.store.hydrateAdjustment(id, {
      ...defaultAdjustmentModel(),
      ...this.parser.parseAdjustmentModel(xml).model,
      ...changed(saved.model, this.store.adjustmentFor(id)()),
    });
    const culling = {
      ...this.parser.parseCulling(xml),
      ...(live && changed(saved.culling, live)),
    };
    this.store.setAdjustment(id, model);
    this.store.setCulling(id, culling);
    this.store.assets.update((assets) =>
      assets.map((candidate) => (candidate.id === id ? { ...candidate, edited: true } : candidate)),
    );
    return { model, culling };
  }
}
