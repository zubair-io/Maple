import type { WorkflowVariantSelection } from '../../xmp/workflow-variant-selection.service';

interface Entry {
  readonly selection: WorkflowVariantSelection;
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly xmp: string;
  readonly width: number;
  readonly bitmap: ImageBitmap;
}

/** Ownership moves at a branch boundary. No bitmap copy/allocation per slider tick (#4063). */
export class ImageCanvasVariantPreviews {
  private entries: Entry[] = [];

  store(entry: Entry): void {
    if (Math.max(entry.bitmap.width, entry.bitmap.height) > 4096) {
      entry.bitmap.close();
      return;
    }
    const previous = this.entries.filter((value) => this.sameBranch(value, entry));
    previous.forEach((value) => value.bitmap.close());
    this.entries = this.entries.filter((value) => !this.sameBranch(value, entry));
    this.entries.push(entry);
    while (this.entries.length > 2) this.entries.shift()!.bitmap.close();
  }
  take(target: Omit<Entry, 'bitmap'>): ImageBitmap | null {
    const index = this.entries.findIndex(
      (entry) =>
        this.sameBranch(entry, target) &&
        entry.bytes === target.bytes &&
        entry.xmp === target.xmp &&
        entry.width === target.width,
    );
    if (index < 0) return null;
    return this.entries.splice(index, 1)[0].bitmap;
  }
  clear(): void {
    this.entries.forEach((entry) => entry.bitmap.close());
    this.entries = [];
  }
  private sameBranch(left: Omit<Entry, 'bitmap'>, right: Omit<Entry, 'bitmap'>): boolean {
    return (
      left.id === right.id &&
      left.selection.scope === right.selection.scope &&
      left.selection.variantId === right.selection.variantId
    );
  }
}
