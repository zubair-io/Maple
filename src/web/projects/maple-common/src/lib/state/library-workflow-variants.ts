import { signal } from '@angular/core';
import type { AssetId } from '../models/asset';
import { PRIMARY_VARIANT_ID } from '../generated/workflow.generated';
import type { WorkflowSidecarBinding } from '../xmp/workflow-sidecar-binding';

/** Current library's UI selection; branch contents remain in actual XMP siblings (#4063). */
export class LibraryWorkflowVariants {
  private readonly bindings = signal<ReadonlyMap<AssetId, WorkflowSidecarBinding>>(new Map());

  constructor(private readonly assetIds: () => readonly AssetId[]) {}

  variantFor(id: AssetId, path: string): string {
    const binding = this.bindings().get(id);
    return binding?.path === path ? binding.variantId : PRIMARY_VARIANT_ID;
  }

  bind(id: AssetId, path: string, variantId: string): void {
    const live = new Set(this.assetIds());
    const retained = new Map([...this.bindings()].filter(([key]) => live.has(key)));
    if (variantId === PRIMARY_VARIANT_ID) retained.delete(id);
    else retained.set(id, { path, variantId });
    this.bindings.set(retained);
  }
}
