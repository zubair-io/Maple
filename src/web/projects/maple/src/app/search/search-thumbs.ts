// Thumbnail blob-URL cache for the `/search` result grid.
//
// Split out of `search.component.ts` so that file stays inside the
// file-size budget (CONTRIBUTING.md § "File-size budget"). Per-instance
// page state, not an injectable: the cache's lifetime is the component's.

import { WritableSignal } from '@angular/core';
import { FilesystemBrowseService } from '@maple-common';
import { ResultViewModel } from './search.vm';

export class SearchThumbLoader {
  /** `abs_path → blob:` URL. Created blob URLs are revoked via the
   * FilesystemBrowseService on sign-out; on this page we let them live for
   * the duration so back-nav restores instantly. */
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly fs: FilesystemBrowseService,
    /** The grid's result list — patched in place as each thumb resolves. */
    private readonly results: WritableSignal<ResultViewModel[]>,
  ) {}

  /** Already-resolved blob URL for `absPath`, or `null` on a cold entry. */
  cached(absPath: string): string | null {
    return this.cache.get(absPath) ?? null;
  }

  /** Fetch the thumbnail for `vm` and patch it into the result list.
   * Fire-and-forget: a failure just clears the row's loading state. */
  async load(vm: ResultViewModel): Promise<void> {
    if (vm.thumbUrl) return;
    const patch = (fields: Partial<ResultViewModel>): void => {
      this.results.update((list) =>
        list.map((r) => (r.abs_path === vm.abs_path ? { ...r, ...fields } : r)),
      );
    };
    try {
      const url = await this.fs.getThumbBlobUrl(vm.abs_path);
      this.cache.set(vm.abs_path, url);
      patch({ thumbUrl: url, thumbLoading: false });
    } catch {
      patch({ thumbLoading: false });
    }
  }
}
