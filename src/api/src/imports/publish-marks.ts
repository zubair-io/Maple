/**
 * One attempt's view of an import's publish markers (see
 * `db/repos/imports.publishing.ts`): the ones earlier attempts left, and the
 * ones it writes itself.
 */

import type { ObjectId } from '../db/object-id.ts';
import {
  clearImportFilePublishing,
  getImportPublishingDests,
  markImportFilePublishing,
} from './repo.ts';

export class PublishMarks {
  private readonly open: Set<number>;

  private constructor(
    private readonly id: ObjectId,
    private readonly holder: string,
    private readonly earlier: ReadonlyMap<number, string>,
  ) {
    this.open = new Set(earlier.keys());
  }

  static async load(id: ObjectId, holder: string): Promise<PublishMarks> {
    return new PublishMarks(id, holder, await getImportPublishingDests(id));
  }

  earlierDest(index: number): string | null {
    return this.earlier.get(index) ?? null;
  }

  async mark(index: number, destRel: string): Promise<void> {
    await markImportFilePublishing(this.id, { index, destRel, holder: this.holder });
    this.open.add(index);
  }

  async finish(index: number): Promise<void> {
    if (!this.open.has(index)) return;
    await clearImportFilePublishing(this.id, { index, holder: this.holder });
    this.open.delete(index);
  }
}
